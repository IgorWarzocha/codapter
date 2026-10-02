import { randomUUID } from "node:crypto";
import type { AppServerLogger } from "./app-server.js";
import type { DebugLogWriter } from "./app-server-log.js";
import type { BackendSessionLaunchConfig, IBackend } from "./backend.js";
import type { BackendRouter } from "./backend-router.js";
import type { BackendServerRequests } from "./backend-server-requests.js";
import { BackendThreadMirror } from "./backend-thread-mirror.js";
import {
  CollabManager,
  type CollabManagerCreateChildThreadInput,
  type CollabManagerNotificationSink,
} from "./collab-manager.js";
import { CollabUdsListener } from "./collab-uds.js";
import {
  hasCompleteBrowserOverrides,
  resumeBrowserConfig,
  threadBrowserOverrides,
} from "./desktop-browser-policy.js";
import type {
  Thread,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadLoadedListParams,
  ThreadLoadedListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  Turn,
} from "./protocol.js";
import { ThreadCatalog } from "./thread-catalog.js";
import {
  normalizeDynamicTools,
  ThreadDesktop,
  type ThreadDesktopPlugins,
} from "./thread-desktop.js";
import {
  buildSandboxPolicy,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_APPROVALS_REVIEWER,
  rewriteCollaborationModeSettings,
  type ThreadExecutionContext,
  type ThreadExecutionSettings,
} from "./thread-execution.js";
import { ThreadHistory } from "./thread-history.js";
import { serializeThread } from "./thread-protocol.js";
import type { ThreadRegistry, ThreadRegistryEntry } from "./thread-registry.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { ThreadTurns } from "./thread-turns.js";

function isSubAgentThreadSource(
  source: ThreadRegistryEntry["source"]
): source is Extract<ThreadRegistryEntry["source"], { subAgent: unknown }> {
  return "subAgent" in source;
}

export interface ThreadSessionsOptions {
  backendRouter: BackendRouter;
  threadRegistry: ThreadRegistry;
  execution: ThreadExecutionSettings;
  desktopPlugins?: ThreadDesktopPlugins;
  serverRequests: BackendServerRequests;
  collabEnabled: boolean;
  logger: AppServerLogger;
  debugLogWriter: DebugLogWriter | null;
  publish(method: string, params?: unknown, threadId?: string): Promise<void>;
}
export class ThreadSessions {
  readonly turns: ThreadTurns;
  readonly catalog: ThreadCatalog;
  readonly history: ThreadHistory;
  private readonly backendRouter: BackendRouter;
  private readonly threadRegistry: ThreadRegistry;
  private readonly execution: ThreadExecutionSettings;
  private readonly desktop: ThreadDesktop;
  private readonly serverRequests: BackendServerRequests;
  private readonly mirror: BackendThreadMirror;
  private readonly collabEnabled: boolean;
  private readonly logger: AppServerLogger;
  private readonly debugLogWriter: DebugLogWriter | null;
  private readonly publish: ThreadSessionsOptions["publish"];
  private readonly collabManager: CollabManager | null;
  private readonly collabUdsListener: CollabUdsListener | null;
  private readonly collabReady: Promise<void>;
  private readonly threadRuntimes = new Map<string, ThreadRuntime>();
  private readonly unsubscribedThreadIds = new Set<string>();
  constructor(options: ThreadSessionsOptions) {
    this.backendRouter = options.backendRouter;
    this.threadRegistry = options.threadRegistry;
    this.execution = options.execution;
    this.desktop = new ThreadDesktop(this.execution, options.desktopPlugins);
    this.serverRequests = options.serverRequests;
    this.collabEnabled = options.collabEnabled;
    this.logger = options.logger;
    this.debugLogWriter = options.debugLogWriter;
    this.publish = options.publish;
    this.history = new ThreadHistory(async (threadId) => {
      const { thread } = await this.read({ threadId, includeTurns: true });
      return thread.turns;
    });
    this.catalog = new ThreadCatalog(
      this.backendRouter,
      this.threadRegistry,
      (threadId) => this.threadRuntimes.get(threadId)?.threadStatus ?? { type: "notLoaded" },
      (method, params, threadId) => this.publish(method, params, threadId)
    );
    this.mirror = new BackendThreadMirror(
      this.backendRouter,
      this.threadRegistry,
      async (entry) => {
        const runtime = this.createRuntime(
          entry.threadId,
          entry.backendType,
          entry.backendSessionId,
          false
        );
        runtime.bindSubscription(
          !runtime.managedByCollab ||
            this.collabManager?.getAgentByThreadId(entry.threadId) === null
        );
        runtime.ready();
        await this.publish(
          "thread/started",
          { thread: this.buildThread(entry, []) },
          entry.threadId
        );
        await this.publishThreadStatus(entry.threadId);
      }
    );
    if (this.collabEnabled) {
      const notifySink: CollabManagerNotificationSink = {
        notify: async (method, params, threadId) => {
          await this.publish(method, params, threadId);
        },
      };
      this.collabManager = new CollabManager({
        backendRouter: this.backendRouter,
        notifySink,
        resolveParentTurnId: (parentThreadId) =>
          this.threadRuntimes.get(parentThreadId)?.latestTurnId ??
          this.threadRuntimes.get(parentThreadId)?.activeTurnId ??
          "unknown",
        resolveThreadHandle: (threadId) => {
          const runtime = this.threadRuntimes.get(threadId);
          if (!runtime) {
            throw new Error(`Thread ${threadId} is not loaded`);
          }
          return runtime.threadHandle;
        },
        resolveThreadBackendType: (threadId) => {
          const runtime = this.threadRuntimes.get(threadId);
          if (!runtime) {
            throw new Error(`Thread ${threadId} is not loaded`);
          }
          return runtime.backendType;
        },
        createSessionLaunchConfig: (
          threadId: string,
          context?: ThreadExecutionContext | null,
          backendType?: string
        ) => this.createBackendSessionLaunchConfig(threadId, context ?? undefined, backendType),
        resolveThreadExecutionContext: (threadId) =>
          this.execution.cloneThreadExecutionContext(threadId),
        createChildThread: async (input) => {
          await this.createCollabChildThread(input);
        },
        startChildTurn: async ({ agent, message }) =>
          await this.startCollabChildTurn(agent, message),
        onChildAgentEvent: async ({ agent, event }) => {
          this.threadRuntimes.get(agent.threadId)?.enqueue(event);
        },
        onChildAgentStatusChanged: async ({ agent }) => {
          this.syncCollabRuntimeState(agent);
          await this.publishThreadStatus(agent.threadId);
        },
      });
      this.collabUdsListener = new CollabUdsListener({
        collabManager: this.collabManager,
        validateParentThread: (parentThreadId) => {
          if (!this.threadRuntimes.has(parentThreadId)) {
            throw new Error(`Thread ${parentThreadId} is not loaded`);
          }
        },
      });
      this.collabReady = this.collabUdsListener.start().catch((error) => {
        this.logger.warn("Failed to start collab UDS listener", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    } else {
      this.collabManager = null;
      this.collabUdsListener = null;
      this.collabReady = Promise.resolve();
    }
    this.turns = new ThreadTurns(
      this.backendRouter,
      this.threadRegistry,
      this.execution,
      this.collabManager,
      (threadId) => this.threadRuntimes.get(threadId),
      this.desktop
    );
  }

  async dispose(): Promise<void> {
    await this.collabUdsListener?.close().catch(() => {});
    await this.collabManager?.dispose().catch(() => {});
    await Promise.all([...this.threadRuntimes.values()].map((runtime) => runtime.dispose()));
    this.serverRequests.clear();
    this.threadRuntimes.clear();
    this.execution.clear();
    this.mirror.clear();
    this.unsubscribedThreadIds.clear();
  }

  async start(params: unknown): Promise<ThreadStartResponse> {
    const parsed = params as ThreadStartParams;
    const dynamicTools = normalizeDynamicTools(parsed.dynamicTools);
    await this.collabReady;
    const threadId = randomUUID();
    const ephemeral = parsed.ephemeral ?? false;
    const effectiveModel = this.execution.coerceModelToRequestedProvider(
      this.execution.resolveRequestedModel(parsed.cwd ?? null, parsed.model, null, null),
      parsed.modelProvider,
      parsed.model
    );
    const effectiveReasoningEffort = this.execution.resolveRequestedReasoningEffort(
      parsed.cwd ?? null,
      parsed.config?.model_reasoning_effort as string | null | undefined,
      null,
      null
    );
    const selection = await this.execution.resolveThreadStartSelection(
      effectiveModel,
      parsed.modelProvider,
      ephemeral
    );
    const backend = selection.backend;
    const browserOverrides =
      backend.backendType === "pi" ? threadBrowserOverrides(parsed.config ?? {}) : undefined;
    const threadStart = await backend.threadStart({
      threadId,
      cwd: parsed.cwd ?? process.cwd(),
      model: selection.selection.rawModelId,
      reasoningEffort: effectiveReasoningEffort,
      approvalPolicy: parsed.approvalPolicy ?? null,
      approvalsReviewer: parsed.approvalsReviewer ?? null,
      sandbox: parsed.sandbox ?? null,
      config: parsed.config ?? null,
      serviceTier: parsed.serviceTier ?? null,
      serviceName: parsed.serviceName ?? null,
      baseInstructions: parsed.baseInstructions ?? null,
      developerInstructions: parsed.developerInstructions ?? null,
      personality: parsed.personality ?? null,
      ephemeral: parsed.ephemeral ?? null,
      experimentalRawEvents: parsed.experimentalRawEvents,
      persistExtendedHistory: parsed.persistExtendedHistory,
      ...(parsed.dynamicTools != null ? { dynamicTools } : {}),
      launchConfig: await this.createBackendSessionLaunchConfig(
        threadId,
        {
          cwd: parsed.cwd ?? process.cwd(),
          config: parsed.config ?? null,
          dynamicTools,
        },
        backend.backendType
      ),
    });
    const selectedModel = this.backendRouter.toClientModelId(
      selection.selection.backendType,
      selection.selection.rawModelId
    );

    const entry = await this.threadRegistry.create({
      threadId,
      backendSessionId: threadStart.threadHandle,
      backendType: backend.backendType,
      ephemeral,
      hidden: ephemeral,
      path: ephemeral ? null : threadStart.path,
      cwd: parsed.cwd ?? process.cwd(),
      preview: "",
      model: selectedModel,
      modelProvider: parsed.modelProvider ?? backend.backendType,
      reasoningEffort: threadStart.reasoningEffort ?? effectiveReasoningEffort,
      gitInfo: null,
      dynamicTools,
      browserOverrides,
    });

    const runtime = this.createRuntime(
      entry.threadId,
      backend.backendType,
      threadStart.threadHandle,
      false
    );
    runtime.bindSubscription(
      !runtime.managedByCollab || this.collabManager?.getAgentByThreadId(entry.threadId) === null
    );
    runtime.ready();

    const thread = this.buildThread(entry, []);
    this.execution.recordThreadExecutionContext(entry.threadId, {
      cwd: parsed.cwd ?? process.cwd(),
      model: entry.model,
      approvalPolicy: parsed.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: parsed.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
      sandbox: parsed.sandbox ?? null,
      sandboxPolicy: buildSandboxPolicy(parsed.sandbox ?? null, parsed.cwd ?? process.cwd()),
      config: parsed.config ?? null,
      reasoningEffort: entry.reasoningEffort,
      serviceTier: parsed.serviceTier ?? null,
      serviceName: parsed.serviceName ?? null,
      baseInstructions: parsed.baseInstructions ?? null,
      developerInstructions: parsed.developerInstructions ?? null,
      personality: parsed.personality ?? null,
      summary: null,
      collaborationMode: null,
      dynamicTools,
      browserOverridesKnown: true,
    });
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publishThreadStatus(entry.threadId);
    return await this.execution.buildThreadExecutionResponse(
      thread,
      entry.model,
      entry.reasoningEffort,
      selectedModel,
      parsed.cwd ?? null,
      parsed.approvalPolicy ?? null,
      parsed.approvalsReviewer ?? null,
      parsed.sandbox ?? null,
      threadStart.reasoningEffort ?? effectiveReasoningEffort,
      entry.disabledPluginIds
    );
  }

  async resume(params: unknown): Promise<ThreadResumeResponse> {
    const parsed = params as ThreadResumeParams;
    let entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    const existingContext = this.execution.cloneThreadExecutionContext(parsed.threadId);
    const browserOverridesKnown =
      entry.browserOverrides != null || hasCompleteBrowserOverrides(parsed.config);
    const resumeConfig =
      entry.backendType === "pi"
        ? resumeBrowserConfig(existingContext?.config ?? entry.browserOverrides, parsed.config)
        : (parsed.config ?? null);
    const browserOverrides =
      entry.backendType === "pi"
        ? browserOverridesKnown
          ? threadBrowserOverrides(resumeConfig ?? {})
          : null
        : undefined;
    const effectiveModel = this.execution.resolveRequestedModel(
      parsed.cwd ?? entry.cwd,
      parsed.model,
      null,
      entry.model
    );
    const effectiveReasoningEffort = this.execution.resolveRequestedReasoningEffort(
      parsed.cwd ?? entry.cwd,
      parsed.config?.model_reasoning_effort as string | null | undefined,
      null,
      entry.reasoningEffort
    );
    const collabAgent = isSubAgentThreadSource(entry.source)
      ? (this.collabManager?.getAgentByThreadId(parsed.threadId) ?? null)
      : null;
    const collabRuntimeState = collabAgent
      ? (this.collabManager?.getAgentRuntimeStateByThreadId(parsed.threadId) ?? null)
      : null;
    const existing = this.threadRuntimes.get(parsed.threadId);
    const existingActiveTurnId = existing?.activeTurnId ?? null;
    existing?.prepareResume();
    const runtime = existing
      ? existing
      : this.createRuntime(
          parsed.threadId,
          entry.backendType,
          entry.backendSessionId,
          isSubAgentThreadSource(entry.source)
        );

    try {
      await this.collabReady;
      const requestedSelection =
        effectiveModel !== null ? this.backendRouter.parseModelSelection(effectiveModel) : null;
      if (requestedSelection && requestedSelection.selection.backendType !== entry.backendType) {
        throw new Error(
          `Cannot resume thread ${entry.threadId} on backend ${requestedSelection.selection.backendType}; thread belongs to ${entry.backendType}`
        );
      }
      const resumed = await backend.threadResume({
        threadId: parsed.threadId,
        threadHandle: entry.backendSessionId,
        cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
        model: requestedSelection?.selection.rawModelId ?? null,
        reasoningEffort: effectiveReasoningEffort,
        approvalPolicy: parsed.approvalPolicy ?? null,
        approvalsReviewer: parsed.approvalsReviewer ?? null,
        sandbox: parsed.sandbox ?? null,
        config: parsed.config ?? null,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        personality: parsed.personality ?? null,
        persistExtendedHistory: parsed.persistExtendedHistory,
        launchConfig: await this.createBackendSessionLaunchConfig(
          parsed.threadId,
          {
            cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
            config: resumeConfig,
            dynamicTools: entry.dynamicTools ?? [],
            browserOverridesKnown,
          },
          entry.backendType
        ),
      });
      runtime.updateHandle(entry.backendType, resumed.threadHandle);
      runtime.bindSubscription(
        !runtime.managedByCollab || this.collabManager?.getAgentByThreadId(parsed.threadId) === null
      );
      if (isSubAgentThreadSource(entry.source)) {
        this.collabManager?.syncExternalResume(
          parsed.threadId,
          resumed.threadHandle,
          entry.backendType
        );
      }
      if (
        entry.backendSessionId !== resumed.threadHandle ||
        entry.path !== resumed.path ||
        entry.model !== effectiveModel ||
        entry.reasoningEffort !== effectiveReasoningEffort ||
        entry.backendType === "pi"
      ) {
        entry = await this.threadRegistry.update(parsed.threadId, {
          backendSessionId: resumed.threadHandle,
          path: entry.ephemeral ? null : resumed.path,
          model: effectiveModel,
          reasoningEffort: effectiveReasoningEffort,
          browserOverrides,
        });
      }

      const readResult = await backend.threadRead({
        threadId: parsed.threadId,
        threadHandle: runtime.threadHandle,
        includeTurns: true,
        cwd: entry.cwd ?? process.cwd(),
      });
      if (readResult.threadHandle !== runtime.threadHandle) {
        runtime.updateHandle(runtime.backendType, readResult.threadHandle);
        entry = await this.threadRegistry.update(parsed.threadId, {
          backendSessionId: readResult.threadHandle,
        });
        runtime.bindSubscription(
          !runtime.managedByCollab ||
            this.collabManager?.getAgentByThreadId(parsed.threadId) === null
        );
      }
      entry =
        (await this.mirror.syncCanonicalThreadRead(parsed.threadId, readResult, {
          allowRecoveredNicknameNameFallback: true,
        })) ?? entry;
      const turns = this.mirror.normalizeReadTurns(entry, [...readResult.turns]);
      this.threadRuntimes.get(parsed.threadId)?.reconcileLoadedTurnIds(turns);
      const resumedActiveTurnId = collabRuntimeState?.activeTurnId ?? existingActiveTurnId;
      const shouldRemainActive =
        collabRuntimeState?.status === "running" || collabRuntimeState?.status === "pendingInit";
      if (shouldRemainActive) {
        runtime.recoverActiveTurn(resumedActiveTurnId);
      } else {
        runtime.ready();
      }
      const thread = this.buildThread(entry, turns);
      this.execution.recordThreadExecutionContext(entry.threadId, {
        cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
        model: entry.model,
        approvalPolicy: parsed.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
        approvalsReviewer: parsed.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
        sandbox: parsed.sandbox ?? null,
        sandboxPolicy: buildSandboxPolicy(parsed.sandbox ?? null, parsed.cwd ?? thread.cwd),
        config: resumeConfig,
        browserOverridesKnown,
        reasoningEffort: entry.reasoningEffort,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        personality: parsed.personality ?? null,
        summary: null,
        collaborationMode: null,
        dynamicTools: entry.dynamicTools ?? [],
      });
      await this.publishThreadStatus(parsed.threadId);
      const response = await this.execution.buildThreadExecutionResponse(
        thread,
        entry.model,
        entry.reasoningEffort,
        effectiveModel,
        parsed.cwd ?? null,
        parsed.approvalPolicy ?? null,
        parsed.approvalsReviewer ?? null,
        parsed.sandbox ?? null,
        effectiveReasoningEffort,
        entry.disabledPluginIds
      );
      return {
        ...response,
        collaborationMode: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      };
    } catch (error) {
      runtime.terminate();
      this.threadRuntimes.delete(parsed.threadId);
      throw error;
    }
  }

  async fork(params: unknown): Promise<ThreadForkResponse> {
    const parsed = params as ThreadForkParams;
    const sourceEntry = await this.getThreadEntry(parsed.threadId);
    const sourceContext = this.execution.cloneThreadExecutionContext(parsed.threadId);
    const backend = this.requireBackend(sourceEntry.backendType);
    const forkConfig =
      sourceEntry.backendType === "pi"
        ? resumeBrowserConfig(sourceContext?.config ?? sourceEntry.browserOverrides, parsed.config)
        : (parsed.config ?? null);
    const browserOverridesKnown =
      sourceEntry.browserOverrides != null || hasCompleteBrowserOverrides(parsed.config);
    const browserOverrides =
      sourceEntry.backendType === "pi"
        ? browserOverridesKnown
          ? threadBrowserOverrides(forkConfig ?? {})
          : null
        : undefined;
    const sourceRuntime = this.threadRuntimes.get(parsed.threadId);
    if (sourceRuntime && sourceRuntime.status !== "ready") {
      throw new Error(`Cannot fork thread ${parsed.threadId} (status: ${sourceRuntime.status})`);
    }

    if (sourceRuntime) {
      sourceRuntime.beginFork();
    }

    let forkThreadId: string | null = null;
    try {
      forkThreadId = randomUUID();
      await this.collabReady;
      const effectiveModel = this.execution.resolveRequestedModel(
        parsed.cwd ?? sourceEntry.cwd,
        parsed.model,
        null,
        sourceEntry.model
      );
      const effectiveReasoningEffort = this.execution.resolveRequestedReasoningEffort(
        parsed.cwd ?? sourceEntry.cwd,
        parsed.config?.model_reasoning_effort as string | null | undefined,
        null,
        sourceEntry.reasoningEffort
      );
      const requestedSelection =
        effectiveModel !== null ? this.backendRouter.parseModelSelection(effectiveModel) : null;
      if (
        requestedSelection &&
        requestedSelection.selection.backendType !== sourceEntry.backendType
      ) {
        throw new Error(
          `Cannot fork thread ${parsed.threadId} across backends (${sourceEntry.backendType} -> ${requestedSelection.selection.backendType})`
        );
      }
      const forked = await backend.threadFork({
        threadId: forkThreadId,
        sourceThreadId: parsed.threadId,
        sourceThreadHandle: sourceEntry.backendSessionId,
        cwd: parsed.cwd ?? sourceEntry.cwd ?? process.cwd(),
        model: requestedSelection?.selection.rawModelId ?? null,
        reasoningEffort: effectiveReasoningEffort,
        approvalPolicy: parsed.approvalPolicy ?? null,
        approvalsReviewer: parsed.approvalsReviewer ?? null,
        sandbox: parsed.sandbox ?? null,
        config: parsed.config ?? null,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        ephemeral: parsed.ephemeral ?? null,
        persistExtendedHistory: parsed.persistExtendedHistory,
        launchConfig: await this.createBackendSessionLaunchConfig(
          forkThreadId,
          {
            cwd: parsed.cwd ?? sourceEntry.cwd ?? process.cwd(),
            config: forkConfig,
            dynamicTools: sourceEntry.dynamicTools ?? [],
            disabledPluginIds: sourceEntry.disabledPluginIds ?? [],
            browserOverridesKnown,
          },
          sourceEntry.backendType
        ),
      });
      const ephemeral = parsed.ephemeral ?? false;
      let entry = await this.threadRegistry.create({
        threadId: forkThreadId,
        backendSessionId: forked.threadHandle,
        sessionId: sourceEntry.sessionId ?? sourceEntry.threadId,
        forkedFromId: sourceEntry.threadId,
        backendType: sourceEntry.backendType,
        ephemeral,
        hidden: ephemeral,
        path: ephemeral ? null : forked.path,
        cwd: parsed.cwd ?? sourceEntry.cwd,
        preview: sourceEntry.preview,
        model: effectiveModel,
        modelProvider: parsed.modelProvider ?? sourceEntry.backendType,
        reasoningEffort: forked.reasoningEffort ?? effectiveReasoningEffort,
        name: sourceEntry.name,
        gitInfo: sourceEntry.gitInfo,
        dynamicTools: sourceEntry.dynamicTools ?? [],
        disabledPluginIds: sourceEntry.disabledPluginIds ?? [],
        browserOverrides,
      });

      const forkRuntime = this.createRuntime(
        entry.threadId,
        sourceEntry.backendType,
        forked.threadHandle,
        false
      );
      forkRuntime.bindSubscription(
        !forkRuntime.managedByCollab ||
          this.collabManager?.getAgentByThreadId(parsed.threadId) === null
      );
      forkRuntime.ready();

      const readResult = await backend.threadRead({
        threadId: entry.threadId,
        threadHandle: forkRuntime.threadHandle,
        includeTurns: true,
        cwd: entry.cwd ?? process.cwd(),
      });
      entry = (await this.mirror.syncCanonicalThreadRead(entry.threadId, readResult)) ?? entry;
      const turns = [...readResult.turns];
      this.threadRuntimes.get(entry.threadId)?.reconcileLoadedTurnIds(turns);
      const thread = this.buildThread(entry, turns);
      this.execution.recordThreadExecutionContext(entry.threadId, {
        cwd: parsed.cwd ?? sourceEntry.cwd ?? process.cwd(),
        model: entry.model,
        approvalPolicy: parsed.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
        approvalsReviewer: parsed.approvalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
        sandbox: parsed.sandbox ?? null,
        sandboxPolicy: buildSandboxPolicy(
          parsed.sandbox ?? null,
          parsed.cwd ?? sourceEntry.cwd ?? process.cwd()
        ),
        config: forkConfig,
        browserOverridesKnown,
        reasoningEffort: entry.reasoningEffort,
        serviceTier: parsed.serviceTier ?? null,
        serviceName: null,
        baseInstructions: parsed.baseInstructions ?? null,
        developerInstructions: parsed.developerInstructions ?? null,
        personality: null,
        summary: null,
        collaborationMode: null,
        dynamicTools: entry.dynamicTools ?? [],
      });
      await this.publish("thread/started", { thread }, entry.threadId);
      await this.publishThreadStatus(entry.threadId);
      return await this.execution.buildThreadExecutionResponse(
        thread,
        entry.model,
        entry.reasoningEffort,
        effectiveModel,
        parsed.cwd ?? null,
        parsed.approvalPolicy ?? null,
        parsed.approvalsReviewer ?? null,
        parsed.sandbox ?? null,
        forked.reasoningEffort ?? effectiveReasoningEffort,
        entry.disabledPluginIds
      );
    } catch (error) {
      if (forkThreadId) {
        this.threadRuntimes.get(forkThreadId)?.terminate();
        this.threadRuntimes.delete(forkThreadId);
      }
      throw error;
    } finally {
      if (sourceRuntime && sourceRuntime.status === "forking") {
        sourceRuntime.finishFork();
      }
    }
  }

  async read(params: unknown): Promise<ThreadReadResponse> {
    const parsed = params as ThreadReadParams;
    let entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    const readResult = await backend.threadRead({
      threadId: parsed.threadId,
      threadHandle: entry.backendSessionId,
      includeTurns: parsed.includeTurns,
      cwd: entry.cwd ?? process.cwd(),
    });
    if (readResult.threadHandle !== entry.backendSessionId) {
      entry = await this.threadRegistry.update(parsed.threadId, {
        backendSessionId: readResult.threadHandle,
      });
      const runtime = this.threadRuntimes.get(parsed.threadId);
      if (runtime) {
        runtime.updateHandle(runtime.backendType, readResult.threadHandle);
        runtime.bindSubscription(
          !runtime.managedByCollab ||
            this.collabManager?.getAgentByThreadId(parsed.threadId) === null
        );
      }
    }
    entry = (await this.mirror.syncCanonicalThreadRead(parsed.threadId, readResult)) ?? entry;
    const turns = parsed.includeTurns
      ? this.mirror.normalizeReadTurns(entry, [...readResult.turns])
      : [];
    if (parsed.includeTurns) {
      this.threadRuntimes.get(parsed.threadId)?.reconcileLoadedTurnIds(turns);
    }
    return { thread: this.buildThread(entry, turns) };
  }

  listLoaded(params: unknown): ThreadLoadedListResponse {
    const parsed = (params ?? {}) as Partial<ThreadLoadedListParams>;
    const loaded = [...this.threadRuntimes.keys()].sort();
    const start = Number.isFinite(Number(parsed.cursor ?? "0")) ? Number(parsed.cursor ?? "0") : 0;
    const limit = parsed.limit ?? loaded.length;
    return {
      data: loaded.slice(start, start + limit),
      nextCursor: start + limit < loaded.length ? String(start + limit) : null,
    };
  }

  async archive(params: unknown): Promise<ThreadArchiveResponse> {
    const parsed = params as ThreadArchiveParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.requireBackend(entry.backendType);
    if (this.collabManager) {
      const collabAgent = this.collabManager.getAgentByThreadId(parsed.threadId);
      if (collabAgent) {
        await this.collabManager.close({
          parentThreadId: collabAgent.parentThreadId,
          id: collabAgent.agentId,
        });
      } else {
        await this.collabManager.shutdownByParent(parsed.threadId);
      }
    }
    const runtime = this.threadRuntimes.get(parsed.threadId);
    if (runtime) {
      runtime.terminate();
    }
    await backend.threadArchive({
      threadId: parsed.threadId,
      threadHandle: entry.backendSessionId,
    });
    this.threadRuntimes.delete(parsed.threadId);
    this.execution.forget(parsed.threadId);
    await this.threadRegistry.update(parsed.threadId, { archived: true });
    await this.publish("thread/archived", { threadId: parsed.threadId }, parsed.threadId);
    return {};
  }

  unsubscribe(params: unknown): ThreadUnsubscribeResponse {
    const parsed = params as ThreadUnsubscribeParams;
    if (!this.threadRuntimes.has(parsed.threadId)) {
      return { status: "notLoaded" };
    }
    if (this.unsubscribedThreadIds.has(parsed.threadId)) {
      return { status: "notSubscribed" };
    }
    this.unsubscribedThreadIds.add(parsed.threadId);
    return { status: "unsubscribed" };
  }

  isSubscribed(threadId: string): boolean {
    return !this.unsubscribedThreadIds.has(threadId);
  }

  private syncCollabRuntimeState(agent: {
    threadId: string;
    threadHandle: string;
    backendType: string;
    status: string;
  }): void {
    const runtime = this.threadRuntimes.get(agent.threadId);
    if (!runtime?.managedByCollab) {
      return;
    }

    runtime.updateHandle(agent.backendType, agent.threadHandle);

    runtime.syncCollabStatus(agent.status);
    if (agent.status === "errored" || agent.status === "shutdown") {
      this.serverRequests.forgetThread(agent.threadId);
    }
  }

  private buildThread(entry: ThreadRegistryEntry, turns: Turn[]): Thread {
    return (
      this.threadRuntimes.get(entry.threadId)?.buildThread(entry, turns) ??
      serializeThread(entry, { type: "notLoaded" }, turns)
    );
  }

  private async publishThreadStatus(threadId: string): Promise<void> {
    await this.publish(
      "thread/status/changed",
      {
        threadId,
        status: this.threadRuntimes.get(threadId)?.threadStatus ?? { type: "notLoaded" },
      },
      threadId
    );
  }

  private requireBackend(backendType: string): IBackend {
    return this.backendRouter.requireBackend(backendType);
  }

  get collabSocketPath(): string | null {
    return this.collabUdsListener?.socketPath ?? null;
  }

  private async createBackendSessionLaunchConfig(
    threadId: string,
    context?: Pick<ThreadExecutionContext, "cwd" | "config" | "dynamicTools"> &
      Pick<ThreadExecutionContext, "browserOverridesKnown"> &
      Pick<ThreadRegistryEntry, "disabledPluginIds">,
    backendType?: string
  ): Promise<BackendSessionLaunchConfig> {
    const entry = await this.threadRegistry.get(threadId);
    const snapshot = context ?? this.execution.cloneThreadExecutionContext(threadId);
    const desktopCapabilities =
      (backendType ?? entry?.backendType) === "pi"
        ? await this.desktop.capabilities(
            snapshot?.cwd ?? entry?.cwd ?? process.cwd(),
            snapshot?.config ?? resumeBrowserConfig(entry?.browserOverrides, null),
            snapshot?.dynamicTools ?? entry?.dynamicTools ?? [],
            context?.disabledPluginIds ?? entry?.disabledPluginIds ?? [],
            snapshot?.browserOverridesKnown ?? (entry ? entry.browserOverrides != null : true)
          )
        : undefined;
    if (!this.collabEnabled || !this.collabUdsListener) {
      return desktopCapabilities ? { desktopCapabilities } : {};
    }

    return {
      threadId,
      collabSocketPath: this.collabUdsListener.socketPath,
      availableModelsDescription: await this.createCollabAvailableModelsDescription(),
      ...(desktopCapabilities ? { desktopCapabilities } : {}),
    };
  }

  private async createCollabAvailableModelsDescription(): Promise<string | null> {
    let models: Awaited<ReturnType<BackendRouter["listModels"]>>;
    try {
      models = await this.backendRouter.listModels();
    } catch {
      return null;
    }

    if (models.length === 0) {
      return null;
    }

    const lines = models.flatMap((model) => {
      const name = typeof model.model === "string" ? model.model : null;
      if (!name) {
        return [];
      }

      const efforts = model.supportedReasoningEfforts
        .map((entry) => entry.reasoningEffort)
        .filter((entry) => entry.length > 0)
        .join(", ");
      return [`- ${name}${efforts ? `: ${efforts}` : ""}`];
    });

    if (lines.length === 0) {
      return null;
    }

    return `Available models (use the model id exactly as shown):\n${lines.join("\n")}`;
  }

  private async createCollabChildThread(input: CollabManagerCreateChildThreadInput): Promise<void> {
    const parentEntry = await this.getThreadEntry(input.parentThreadId);
    const parentContext = this.execution.cloneThreadExecutionContext(input.parentThreadId);
    const entry = await this.threadRegistry.create({
      threadId: input.threadId,
      backendSessionId: input.threadHandle,
      sessionId: parentEntry.sessionId ?? parentEntry.threadId,
      backendType: input.backendType,
      path: input.path,
      cwd: parentEntry.cwd ?? process.cwd(),
      preview: input.preview,
      model: input.model,
      modelProvider: input.backendType,
      reasoningEffort: input.reasoningEffort,
      name: null,
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: input.parentThreadId,
            depth: input.depth,
            agent_nickname: input.nickname,
            agent_role: input.role,
          },
        },
      },
      agentNickname: input.nickname,
      agentRole: input.role,
      gitInfo: null,
      dynamicTools: parentContext?.dynamicTools ?? parentEntry.dynamicTools ?? [],
      disabledPluginIds: parentEntry.disabledPluginIds ?? [],
      browserOverrides:
        input.backendType === "pi"
          ? parentEntry.browserOverrides == null
            ? null
            : threadBrowserOverrides(parentContext?.config ?? parentEntry.browserOverrides)
          : undefined,
    });
    const runtime = this.createRuntime(entry.threadId, input.backendType, input.threadHandle, true);
    runtime.ready();
    if (parentContext) {
      this.execution.recordThreadExecutionContext(entry.threadId, {
        ...parentContext,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        collaborationMode: rewriteCollaborationModeSettings(parentContext.collaborationMode, {
          model: input.model,
          reasoningEffort: input.reasoningEffort,
        }),
      });
    }

    const thread = this.buildThread(entry, []);
    await this.publish("thread/started", { thread }, entry.threadId);
    await this.publishThreadStatus(entry.threadId);
  }

  private async startCollabChildTurn(
    agent: { threadId: string },
    _message: string
  ): Promise<string> {
    const runtime = this.threadRuntimes.get(agent.threadId);
    if (!runtime) {
      throw new Error(`Thread ${agent.threadId} is not loaded`);
    }

    const turnId = randomUUID();
    runtime.beginTurn(turnId);
    await this.publishThreadStatus(agent.threadId);
    return turnId;
  }
  private createRuntime(
    threadId: string,
    backendType: string,
    threadHandle: string,
    managedByCollab: boolean
  ): ThreadRuntime {
    const runtime = new ThreadRuntime({
      threadId,
      backendType,
      threadHandle,
      managedByCollab,
      backendRouter: this.backendRouter,
      mirror: this.mirror,
      serverRequests: this.serverRequests,
      logger: this.logger,
      debugLogWriter: this.debugLogWriter,
      publish: this.publish,
    });
    this.threadRuntimes.set(threadId, runtime);
    return runtime;
  }
  private async getThreadEntry(threadId: string): Promise<ThreadRegistryEntry> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    return entry;
  }
}
