import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BackendAppServerEvent,
  BackendCapabilities,
  BackendImageInput,
  BackendMessage,
  BackendModelSummary,
  BackendResolveServerRequestInput,
  BackendSessionLaunchConfig,
  BackendThreadArchiveInput,
  BackendThreadForkInput,
  BackendThreadForkResult,
  BackendThreadReadInput,
  BackendThreadReadResult,
  BackendThreadResumeInput,
  BackendThreadResumeResult,
  BackendThreadSetNameInput,
  BackendThreadStartInput,
  BackendThreadStartResult,
  BackendTurnInterruptInput,
  BackendTurnStartInput,
  BackendTurnStartResult,
  Disposable,
  IBackend,
  JsonValue,
} from "@codapter/core";
import {
  BackendThreadEventBuffer,
  parseBackendModelId,
  TurnStateMachine,
  toThreadTokenUsage,
} from "@codapter/core";
import { mapExtensionDialog, mapExtensionDialogResponse } from "./extension-ui.js";
import { mapAvailableModelsToSummaries } from "./model-catalog.js";
import {
  mapSessionRecordFromSnapshot,
  type PiProcessEvent,
  type PiProcessLaunchOptions,
  PiProcessSession,
  type PiSessionStateSnapshot,
} from "./pi-process.js";
import { mapHistoryToTurns, mergeHistoryTurnsWithLiveTurn } from "./session-history.js";
import { type PiBackendSessionRecord, PiBackendStateStore } from "./state-store.js";

export interface PiBackendOptions {
  readonly sessionDir?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly debugLogFilePath?: string | null;
  readonly idleTimeoutMs?: number;
  readonly collabExtensionPath?: string | null;
  readonly staticAvailableModelsPath?: string | null;
  readonly requestTimeoutMs?: number;
}

interface ManagedSession {
  readonly process: PiProcessSession;
  record: PiBackendSessionRecord;
}

interface PiThreadRuntime {
  threadId: string;
  activeTurnId: string | null;
  machine: TurnStateMachine | null;
  pendingElicitationPayloads: Map<string, unknown>;
  processSubscription: Disposable | null;
  eventQueue: Promise<void>;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  requiresAuth: false,
  supportsImages: true,
  supportsThinking: true,
  supportsParallelTools: true,
  supportedToolTypes: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultSessionDir(): string {
  return join(
    process.env.CODAPTER_STATE_DIR ?? join(homedir(), ".local", "share", "codapter"),
    "backend-pi"
  );
}

function cloneMessage(message: BackendMessage): BackendMessage {
  return {
    ...message,
    content: structuredClone(message.content),
  };
}

function cloneMessages(messages: readonly BackendMessage[]): BackendMessage[] {
  return messages.map(cloneMessage);
}

function cloneModels(models: readonly BackendModelSummary[]): BackendModelSummary[] {
  return models.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  }));
}

function cloneCapabilities(capabilities: BackendCapabilities): BackendCapabilities {
  return {
    ...capabilities,
    supportedToolTypes: [...capabilities.supportedToolTypes],
  };
}

function opaqueSessionId(): string {
  return `pi_session_${randomUUID()}`;
}

function toRequestedModelCandidates(modelId: string): string[] {
  if (modelId.includes("/")) {
    return [modelId];
  }

  return [modelId, `openai-codex/${modelId}`];
}

function normalizeTurnInput(input: BackendTurnStartInput["input"]): {
  text: string;
  images: BackendImageInput[];
  userContent: JsonValue[];
} {
  const textParts: string[] = [];
  const images: BackendImageInput[] = [];
  const userContent: JsonValue[] = [];
  for (const item of input) {
    switch (item.type) {
      case "text":
        textParts.push(item.text);
        userContent.push({ type: "text", text: item.text });
        break;
      case "image":
        if (!item.url)
          throw new Error("Pi image input requires a URL; fileId-only images are unsupported");
        images.push({ type: "image", url: item.url });
        userContent.push({
          type: "image",
          url: item.url,
          ...(item.detail ? { detail: item.detail } : {}),
        });
        break;
      case "localImage":
        images.push({ type: "localImage", path: item.path });
        userContent.push({
          type: "localImage",
          path: item.path,
          ...(item.detail ? { detail: item.detail } : {}),
        });
        break;
      case "audio":
      case "localAudio":
      case "skill":
      case "mention":
        throw new Error(`Unsupported Pi turn input type: ${item.type}`);
      default:
        throw new Error("Unsupported Pi turn input");
    }
  }
  return {
    text: textParts.join("\n").trim(),
    images,
    userContent,
  };
}

export class PiBackend implements IBackend {
  public readonly backendType = "pi";
  public readonly sessionDir: string;

  private readonly launchOptions: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly requestTimeoutMs?: number;
  };
  private readonly idleTimeoutMs: number;
  private readonly stateStore: PiBackendStateStore;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly ownedProcesses = new Set<PiProcessSession>();
  private readonly activating = new Map<string, Promise<ManagedSession>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly modelCache = new Map<string, BackendModelSummary>();
  private modelListPromise: Promise<BackendModelSummary[]> | null = null;
  private readonly launchConfigs = new Map<string, BackendSessionLaunchConfig>();
  private readonly eventBuffer = new BackendThreadEventBuffer();
  private readonly threadRuntimes = new Map<string, PiThreadRuntime>();
  private initialized = false;
  private disposed = false;
  private capabilities: BackendCapabilities | null = null;
  private readonly collabExtensionPath: string | null;
  private readonly staticAvailableModelsPath: string | null;

  constructor(options: PiBackendOptions = {}) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir();
    const launchOptions: {
      command?: string;
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      requestTimeoutMs?: number;
    } = {};
    if (options.command !== undefined) {
      launchOptions.command = options.command;
    }
    if (options.args !== undefined) {
      launchOptions.args = options.args;
    }
    if (options.env !== undefined) {
      launchOptions.env = options.env;
    }
    if (options.cwd !== undefined) {
      launchOptions.cwd = options.cwd;
    }
    if (options.debugLogFilePath !== undefined) {
      launchOptions.env = {
        ...(launchOptions.env ?? {}),
        CODAPTER_DEBUG_LOG_FILE: options.debugLogFilePath ?? "",
      };
    }
    if (options.requestTimeoutMs !== undefined) {
      launchOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    this.launchOptions = launchOptions;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.collabExtensionPath = options.collabExtensionPath ?? null;
    this.staticAvailableModelsPath = options.staticAvailableModelsPath ?? null;
    this.stateStore = new PiBackendStateStore(this.sessionDir);
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    await this.stateStore.load();
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    const disposals = Array.from(this.ownedProcesses, (process) => this.disposeProcess(process));
    await Promise.all(disposals);

    this.sessions.clear();
    this.launchConfigs.clear();
    this.modelCache.clear();
    this.modelListPromise = null;
    for (const runtime of this.threadRuntimes.values()) {
      runtime.processSubscription?.dispose();
    }
    this.threadRuntimes.clear();
  }

  isAlive(): boolean {
    return this.initialized && !this.disposed;
  }

  parseModelSelection(model: string | null | undefined) {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    if (!parsed || parsed.backendType !== this.backendType) {
      return null;
    }
    return parsed;
  }

  async threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.createSession(launchConfig);
    try {
      if (input.model) {
        await this.setModel(threadHandle, input.model);
      }
      if (input.reasoningEffort) {
        await this.setThinkingLevel(threadHandle, input.reasoningEffort);
      }
      this.ensureThreadRuntime(threadHandle, input.threadId);
      return {
        threadHandle,
        path: await this.getSessionPath(threadHandle),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      };
    } catch (error) {
      if (!this.disposed) await this.disposeSession(threadHandle);
      throw error;
    }
  }

  async threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.resumeSession(input.threadHandle, launchConfig);
    if (input.model) {
      await this.setModel(threadHandle, input.model);
    }
    if (input.reasoningEffort) {
      await this.setThinkingLevel(threadHandle, input.reasoningEffort);
    }
    this.ensureThreadRuntime(threadHandle, input.threadId);
    return {
      threadHandle,
      path: await this.getSessionPath(threadHandle),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.forkSession(input.sourceThreadHandle, launchConfig);
    try {
      if (input.model) {
        await this.setModel(threadHandle, input.model);
      }
      if (input.reasoningEffort) {
        await this.setThinkingLevel(threadHandle, input.reasoningEffort);
      }
      this.ensureThreadRuntime(threadHandle, input.threadId);
      return {
        threadHandle,
        path: await this.getSessionPath(threadHandle),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      };
    } catch (error) {
      if (!this.disposed) await this.disposeSession(threadHandle);
      throw error;
    }
  }

  async threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult> {
    let turns = input.includeTurns
      ? mapHistoryToTurns(await this.readSessionHistory(input.threadHandle))
      : [];
    const runtime = this.threadRuntimes.get(input.threadHandle);
    if (input.includeTurns && runtime?.machine) {
      turns = mergeHistoryTurnsWithLiveTurn(
        turns,
        runtime.machine.snapshot as unknown as {
          readonly items?: readonly Record<string, unknown>[];
          readonly status?: string;
        }
      );
      turns.push(runtime.machine.snapshot as unknown as (typeof turns)[number]);
    }
    const record = await this.requireRecord(input.threadHandle);
    return {
      threadHandle: input.threadHandle,
      title: record.sessionName,
      model: record.modelId,
      turns: turns as unknown as BackendThreadReadResult["turns"],
    };
  }

  async threadArchive(input: BackendThreadArchiveInput): Promise<void> {
    await this.disposeSession(input.threadHandle);
    const runtime = this.threadRuntimes.get(input.threadHandle);
    runtime?.processSubscription?.dispose();
    this.threadRuntimes.delete(input.threadHandle);
  }

  async threadSetName(input: BackendThreadSetNameInput): Promise<void> {
    await this.setSessionName(input.threadHandle, input.name);
  }

  async turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult> {
    this.assertReady();
    const normalized = normalizeTurnInput(input.input);
    const session = await this.ensureActiveSession(input.threadHandle);
    const runtime = this.ensureThreadRuntime(input.threadHandle, input.threadId);
    if (runtime.activeTurnId || session.process.isBusy) {
      throw new Error("Pi thread already has an active turn");
    }
    // Reserve ownership before model/thinking RPCs yield to another turn/start.
    runtime.activeTurnId = input.turnId;
    const machine = new TurnStateMachine(input.threadId, input.turnId, input.cwd, {
      notify: async (method, params) => {
        this.eventBuffer.emit(input.threadHandle, {
          kind: "notification",
          threadHandle: input.threadHandle,
          method,
          params,
        });
      },
    });
    runtime.machine = machine;
    try {
      if (input.model) await this.setModel(input.threadHandle, input.model);
      if (input.reasoningEffort)
        await this.setThinkingLevel(input.threadHandle, input.reasoningEffort);
      if (runtime.machine !== machine) throw new Error("Pi turn was interrupted before prompting");
      await machine.emitStarted();
      if (normalized.userContent.length > 0) {
        await machine.emitUserMessage(normalized.userContent, {
          notify: input.emitUserMessage ?? false,
        });
      }
      if (runtime.machine !== machine) throw new Error("Pi turn was interrupted before prompting");
      await this.prompt(input.threadHandle, input.turnId, normalized.text, normalized.images);
      return { accepted: true, turnId: input.turnId };
    } catch (error) {
      await runtime.eventQueue;
      if (runtime.machine === machine) {
        await machine.handleEvent({
          sessionId: input.threadHandle,
          turnId: input.turnId,
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        runtime.machine = null;
      }
      if (runtime.activeTurnId === input.turnId) runtime.activeTurnId = null;
      throw error;
    }
  }

  async turnInterrupt(input: BackendTurnInterruptInput): Promise<void> {
    const runtime = this.threadRuntimes.get(input.threadHandle);
    if (runtime?.activeTurnId !== input.turnId) return;
    const machine = runtime.machine;
    runtime.machine = null;
    // Native abort can emit an aborted assistant and settle before its RPC reply.
    // Detach the machine while aborting, then publish interruption after the reply.
    try {
      await this.abort(input.threadHandle);
    } catch (error) {
      await machine?.handleEvent({
        sessionId: input.threadHandle,
        turnId: input.turnId,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (runtime.activeTurnId === input.turnId) runtime.activeTurnId = null;
    }
    await machine?.interrupt();
  }

  async resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void> {
    const runtime = this.threadRuntimes.get(input.threadHandle);
    const payload = runtime?.pendingElicitationPayloads.get(String(input.requestId));
    await this.respondToElicitation(
      input.threadHandle,
      String(input.requestId),
      mapExtensionDialogResponse(String(input.requestId), payload, input.response)
    );
    runtime?.pendingElicitationPayloads.delete(String(input.requestId));
  }

  async createSession(config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    const sessionId = opaqueSessionId();
    const process = this.createProcess(sessionId, config);
    try {
      const snapshot = await process.startFresh();
      this.assertReady();
      const record = await this.persistSnapshot(sessionId, snapshot);
      this.assertReady();
      this.sessions.set(sessionId, { process, record });
      if (config) this.launchConfigs.set(sessionId, config);
      this.resetIdleTimer(sessionId);
      return sessionId;
    } catch (error) {
      await this.disposeProcess(process);
      throw error;
    }
  }

  async resumeSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    if (config) {
      this.launchConfigs.set(sessionId, config);
    }
    await this.ensureActiveSession(sessionId);
    this.resetIdleTimer(sessionId);
    return sessionId;
  }

  async forkSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    const source = await this.ensureActiveSession(sessionId);
    if (!source.record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const forkedSessionId = opaqueSessionId();
    const process = this.createProcess(forkedSessionId, config);
    try {
      await process.attachSession(source.record.sessionFile);
      // clone keeps the whole active branch. fork rewinds to BEFORE a user message.
      await process.cloneSession();
      const snapshot = await process.getState();
      this.assertReady();
      const record = await this.persistSnapshot(forkedSessionId, snapshot, source.record.createdAt);
      this.assertReady();
      this.sessions.set(forkedSessionId, { process, record });
      if (config) this.launchConfigs.set(forkedSessionId, config);
      this.resetIdleTimer(forkedSessionId);
      return forkedSessionId;
    } catch (error) {
      await this.disposeProcess(process);
      throw error;
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.assertReady();
    await this.requireRecord(sessionId);
    this.clearIdleTimer(sessionId);

    const session = this.sessions.get(sessionId);
    if (session) {
      await this.disposeProcess(session.process);
      this.sessions.delete(sessionId);
    }
    this.launchConfigs.delete(sessionId);
    const runtime = this.threadRuntimes.get(sessionId);
    runtime?.processSubscription?.dispose();
    this.threadRuntimes.delete(sessionId);
  }

  async readSessionHistory(sessionId: string): Promise<BackendMessage[]> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session?.process.isRunning()) {
      this.resetIdleTimer(sessionId);
      return cloneMessages(await session.process.getMessages());
    }

    const record = await this.requireRecord(sessionId);
    if (!record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const reader = this.createProcess(`read:${sessionId}`);
    try {
      await reader.attachSession(record.sessionFile);
      return cloneMessages(await reader.getMessages());
    } finally {
      await this.disposeProcess(reader);
    }
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.setSessionName(name);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      sessionName: name,
      updatedAt: nowIso(),
    });
  }

  async getSessionPath(sessionId: string): Promise<string | null> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.record.sessionFile;
    }

    const record = await this.requireRecord(sessionId);
    return record.sessionFile;
  }

  async prompt(
    sessionId: string,
    turnId: string,
    text: string,
    images?: readonly BackendImageInput[]
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);

    await session.process.prompt(turnId, text, images);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async abort(sessionId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.abort();
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async listModels(): Promise<BackendModelSummary[]> {
    this.assertReady();
    if (this.modelCache.size > 0) {
      return cloneModels([...this.modelCache.values()]);
    }

    if (this.modelListPromise) {
      return cloneModels(await this.modelListPromise);
    }

    try {
      this.modelListPromise = this.loadAvailableModels();
      return cloneModels(await this.modelListPromise);
    } finally {
      this.modelListPromise = null;
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    const resolved = await this.resolveModel(modelId);
    await session.process.setModel(resolved.provider, resolved.modelId);
    session.record = await this.updateRecord(sessionId, {
      modelId: resolved.id,
      updatedAt: nowIso(),
    });
  }

  async setThinkingLevel(sessionId: string, effort: string): Promise<void> {
    const session = await this.ensureActiveSession(sessionId);
    await session.process.setThinkingLevel(effort);
  }

  async getCapabilities(): Promise<BackendCapabilities> {
    this.assertReady();
    if (!this.capabilities) {
      this.capabilities = cloneCapabilities(DEFAULT_CAPABILITIES);
    }
    return cloneCapabilities(this.capabilities);
  }

  async respondToElicitation(
    sessionId: string,
    requestId: string,
    response: unknown
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.respondToElicitation(requestId, response);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    this.assertReady();
    this.ensureThreadRuntime(
      threadHandle,
      this.threadRuntimes.get(threadHandle)?.threadId ?? threadHandle
    );
    return this.eventBuffer.subscribe(threadHandle, listener);
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    if (this.idleTimeoutMs <= 0 || this.disposed) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      void this.disposeIdleSession(sessionId);
    }, this.idleTimeoutMs);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const existing = this.idleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(sessionId);
    }
  }

  private async disposeIdleSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.process.isBusy || this.threadRuntimes.get(sessionId)?.activeTurnId) {
      this.resetIdleTimer(sessionId);
      return;
    }
    const runtime = this.threadRuntimes.get(sessionId);
    runtime?.processSubscription?.dispose();
    if (runtime) runtime.processSubscription = null;
    console.error(`[codapter] Idle timeout: disposing Pi session ${sessionId}`);
    this.sessions.delete(sessionId);
    await this.disposeProcess(session.process);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Pi backend has been disposed");
    }
  }

  private assertReady(): void {
    this.assertNotDisposed();
    if (!this.initialized) {
      throw new Error("Pi backend must be initialized before use");
    }
  }

  private createProcess(
    sessionId: string,
    launchConfig?: BackendSessionLaunchConfig
  ): PiProcessSession {
    const effectiveLaunchConfig = launchConfig ?? this.launchConfigs.get(sessionId);
    const options: PiProcessLaunchOptions = {
      sessionDir: this.sessionDir,
      opaqueSessionId: sessionId,
      ...this.launchOptions,
      ...(effectiveLaunchConfig?.cwd ? { cwd: effectiveLaunchConfig.cwd } : {}),
      ...(this.collabExtensionPath !== null
        ? { collabExtensionPath: this.collabExtensionPath }
        : {}),
      ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
    };

    this.assertReady();
    const process = new PiProcessSession(options);
    this.ownedProcesses.add(process);
    return process;
  }

  private async disposeProcess(process: PiProcessSession): Promise<void> {
    try {
      await process.dispose();
    } finally {
      this.ownedProcesses.delete(process);
    }
  }

  private async ensureActiveSession(sessionId: string): Promise<ManagedSession> {
    this.assertReady();
    const existing = this.sessions.get(sessionId);
    if (existing?.process.isRunning()) {
      return existing;
    }

    const pending = this.activating.get(sessionId);
    if (pending) return await pending;
    const activation = this.activateSession(sessionId);
    this.activating.set(sessionId, activation);
    try {
      return await activation;
    } finally {
      this.activating.delete(sessionId);
    }
  }

  private async activateSession(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    const runtime = this.threadRuntimes.get(sessionId);
    runtime?.processSubscription?.dispose();
    if (runtime) runtime.processSubscription = null;
    if (existing) {
      await this.disposeProcess(existing.process);
      this.sessions.delete(sessionId);
    }
    const record = await this.requireRecord(sessionId);
    const process = this.createProcess(sessionId);
    try {
      const snapshot = await process.attachSession(record.sessionFile);
      this.assertReady();
      const nextRecord = await this.persistSnapshot(sessionId, snapshot, record.createdAt);
      this.assertReady();
      const session = { process, record: nextRecord };
      this.sessions.set(sessionId, session);
      if (runtime) runtime.processSubscription = this.subscribeProcessEvents(sessionId);
      return session;
    } catch (error) {
      await this.disposeProcess(process);
      throw error;
    }
  }

  private ensureThreadRuntime(threadHandle: string, threadId = threadHandle): PiThreadRuntime {
    const existing = this.threadRuntimes.get(threadHandle);
    if (existing) {
      existing.threadId = threadId;
      if (!existing.processSubscription) {
        existing.processSubscription = this.subscribeProcessEvents(threadHandle);
      }
      return existing;
    }

    const runtime: PiThreadRuntime = {
      threadId,
      activeTurnId: null,
      machine: null,
      pendingElicitationPayloads: new Map(),
      processSubscription: null,
      eventQueue: Promise.resolve(),
    };
    this.threadRuntimes.set(threadHandle, runtime);
    runtime.processSubscription = this.subscribeProcessEvents(threadHandle);
    return runtime;
  }

  private subscribeProcessEvents(threadHandle: string): Disposable | null {
    const session = this.sessions.get(threadHandle);
    if (!session?.process.isRunning()) return null;
    return session.process.addListener((event) => {
      this.resetIdleTimer(threadHandle);
      const runtime = this.threadRuntimes.get(threadHandle);
      if (!runtime) return;
      runtime.eventQueue = runtime.eventQueue
        .then(() => this.handleProcessEvent(threadHandle, event))
        .catch((error: unknown) => {
          this.eventBuffer.emit(threadHandle, {
            kind: "error",
            threadHandle,
            code: "PI_EVENT_FAILED",
            retryable: false,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }

  private async handleProcessEvent(threadHandle: string, event: PiProcessEvent): Promise<void> {
    const runtime = this.threadRuntimes.get(threadHandle);
    if (!runtime) {
      return;
    }

    if (event.type === "disconnect") {
      this.eventBuffer.emit(threadHandle, {
        kind: "disconnect",
        threadHandle,
        message: event.message,
      });
      return;
    }

    if (event.type === "extension_error") {
      this.eventBuffer.emit(threadHandle, {
        kind: "error",
        threadHandle,
        code: "PI_EXTENSION_ERROR",
        message: event.message,
        retryable: false,
      });
      return;
    }

    if (event.type === "token_usage") {
      this.eventBuffer.emit(threadHandle, {
        kind: "notification",
        threadHandle,
        method: "thread/tokenUsage/updated",
        params: {
          threadId: runtime.threadId,
          turnId: event.turnId,
          tokenUsage: toThreadTokenUsage(event.usage),
        },
      });
      return;
    }

    if (event.type === "elicitation_request") {
      runtime.pendingElicitationPayloads.set(event.requestId, event.payload);
      this.eventBuffer.emit(threadHandle, {
        kind: "serverRequest",
        threadHandle,
        requestId: event.requestId,
        method: "item/tool/requestUserInput",
        params: mapExtensionDialog(event.requestId, event.payload, runtime.threadId, event.turnId),
      });
      return;
    }

    if (!runtime.machine || runtime.activeTurnId !== event.turnId) {
      return;
    }

    const completed = await runtime.machine.handleEvent(event);
    if (completed) {
      runtime.machine = null;
      runtime.activeTurnId = null;
    }
  }

  private async requireRecord(sessionId: string): Promise<PiBackendSessionRecord> {
    const record = await this.stateStore.get(sessionId);
    if (!record) {
      throw new Error(`Unknown Pi session: ${sessionId}`);
    }
    return record;
  }

  private async persistSnapshot(
    sessionId: string,
    snapshot: PiSessionStateSnapshot,
    createdAt?: string
  ): Promise<PiBackendSessionRecord> {
    const record = mapSessionRecordFromSnapshot(sessionId, snapshot, createdAt ?? nowIso());
    await this.stateStore.upsert(record);
    return record;
  }

  private async updateRecord(
    sessionId: string,
    patch: Partial<Omit<PiBackendSessionRecord, "opaqueSessionId" | "createdAt">>
  ): Promise<PiBackendSessionRecord> {
    return await this.stateStore.update(sessionId, patch);
  }

  private async resolveModel(
    modelId: string
  ): Promise<{ id: string; provider: string; modelId: string }> {
    if (this.modelCache.size === 0) {
      await this.listModels();
    }

    const model = toRequestedModelCandidates(modelId)
      .map((candidate) => this.modelCache.get(candidate))
      .find((candidate) => candidate !== undefined);
    if (!model) {
      throw new Error(`Unknown Pi model: ${modelId}`);
    }

    const separator = model.model.indexOf("/");
    const provider = model.model.slice(0, separator);
    const rawModelId = model.model.slice(separator + 1);
    return {
      id: model.id,
      provider,
      modelId: rawModelId,
    };
  }

  private async loadStaticModels(filePath: string): Promise<BackendModelSummary[]> {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const models = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : [];
    return mapAvailableModelsToSummaries(models);
  }

  private async loadAvailableModels(): Promise<BackendModelSummary[]> {
    if (this.staticAvailableModelsPath) {
      const summaries = await this.loadStaticModels(this.staticAvailableModelsPath);
      this.replaceModelCache(summaries);
      return summaries;
    }

    const probe = this.createProcess(`models:${randomUUID()}`);
    try {
      const models = await probe.getAvailableModels();
      const defaults = await probe.getState();
      const thinkingLevels = await probe.getAvailableThinkingLevels();
      const summaries = mapAvailableModelsToSummaries(models, { ...defaults, thinkingLevels });
      this.assertReady();
      this.replaceModelCache(summaries);
      return summaries;
    } finally {
      await this.disposeProcess(probe);
    }
  }

  private replaceModelCache(models: readonly BackendModelSummary[]): void {
    this.modelCache.clear();
    for (const model of models) {
      this.modelCache.set(model.id, model);
    }
  }
}

export function createPiBackend(options: PiBackendOptions = {}): PiBackend {
  return new PiBackend(options);
}
