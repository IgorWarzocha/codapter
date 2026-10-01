import { randomUUID } from "node:crypto";
import type {
  BackendAppServerEvent,
  BackendSessionLaunchConfig,
  BackendThreadForkResult,
  BackendThreadStartResult,
  IBackend,
} from "./backend.js";
import { BackendRouter } from "./backend-router.js";
import { CollabAgentSession } from "./collab-agent-session.js";
import { AGENT_NICKNAMES } from "./collab-nicknames.js";
import type {
  CollabAgent,
  CollabAgentState,
  CollabAgentStatus,
  CollabAgentTool,
  CollabAgentToolCallItem,
  CollabCloseRequest,
  CollabCloseResponse,
  CollabConfig,
  CollabResumeRequest,
  CollabResumeResponse,
  CollabSendInputRequest,
  CollabSendInputResponse,
  CollabSpawnRequest,
  CollabSpawnResponse,
  CollabWaitRequest,
  CollabWaitResponse,
} from "./collab-types.js";
import { CollabWaitQueue } from "./collab-wait-queue.js";
import type { UserInput } from "./protocol.js";
import type { ThreadExecutionContext } from "./thread-execution.js";

const DEFAULT_CONFIG: CollabConfig = {
  maxAgents: 10,
  maxDepth: 3,
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 10_000,
  maxTimeoutMs: 3_600_000,
};

function previewFromItems(items: readonly UserInput[] | undefined, fallback: string): string {
  if (!items || items.length === 0) {
    return fallback;
  }

  const text = items
    .flatMap((item) => {
      switch (item.type) {
        case "text":
          return [item.text];
        case "image":
          return [`[image] ${item.url ?? item.fileId}`];
        case "localImage":
          return [`[local image] ${item.path}`];
        case "audio":
          return [`[audio] ${item.url}`];
        case "localAudio":
          return [`[local audio] ${item.path}`];
        case "skill":
          return [`[skill:${item.name}] ${item.path}`];
        case "mention":
          return [`[mention:${item.name}] ${item.path}`];
        default:
          throw new Error("Unsupported collaboration input type");
      }
    })
    .join("\n")
    .trim();

  return text || fallback;
}

function hasCombinedMessageAndItems(
  message: string | undefined,
  items: readonly UserInput[] | undefined
): boolean {
  return (
    typeof message === "string" && message.length > 0 && Array.isArray(items) && items.length > 0
  );
}

export interface CollabManagerNotificationSink {
  notify(method: string, params: unknown, threadId?: string): Promise<void>;
}

export interface CollabManagerCreateChildThreadInput {
  agentId: string;
  nickname: string;
  role: string | null;
  parentThreadId: string;
  threadId: string;
  backendType: string;
  threadHandle: string;
  path: string | null;
  depth: number;
  preview: string;
  model: string | null;
  reasoningEffort: string | null;
}

export interface CollabThreadExecutionContext extends ThreadExecutionContext {}

export interface CollabManagerOptions {
  backend?: IBackend;
  backendRouter?: BackendRouter;
  notifySink: CollabManagerNotificationSink;
  resolveParentTurnId(parentThreadId: string): string;
  resolveThreadSessionId?(threadId: string): string;
  resolveThreadHandle(threadId: string): string;
  resolveThreadBackendType(threadId: string): string;
  createSessionLaunchConfig?(
    threadId: string
  ): BackendSessionLaunchConfig | Promise<BackendSessionLaunchConfig>;
  resolveThreadExecutionContext?(threadId: string): CollabThreadExecutionContext | null;
  createChildThread(input: CollabManagerCreateChildThreadInput): Promise<void>;
  startChildTurn?(input: { agent: CollabAgent; message: string }): string | Promise<string>;
  onChildAgentEvent?(input: {
    agent: CollabAgent;
    event: BackendAppServerEvent;
  }): void | Promise<void>;
  onChildAgentStatusChanged?(input: {
    agent: CollabAgent & { backendType: string; threadHandle: string };
  }): void | Promise<void>;
  config?: Partial<CollabConfig>;
}

function collabStateFromAgent(
  agent: Pick<CollabAgent, "status" | "completionMessage">
): CollabAgentState {
  return {
    status: agent.status,
    message: agent.completionMessage,
  };
}

export class CollabManager {
  private readonly agents = new Map<string, CollabAgent>();
  private readonly agentRuntimes = new Map<string, CollabAgentSession>();
  private readonly nicknames = new Set<string>();
  private readonly waits: CollabWaitQueue;
  private readonly shuttingDownAgentIds = new Set<string>();
  private readonly config: CollabConfig;
  private readonly backendRouter: BackendRouter;
  private readonly notifySink: CollabManagerNotificationSink;
  private readonly resolveParentTurnId: (parentThreadId: string) => string;
  private readonly resolveThreadHandle: (threadId: string) => string;
  private readonly resolveThreadBackendType: (threadId: string) => string;
  private readonly createSessionLaunchConfig: (
    threadId: string
  ) => BackendSessionLaunchConfig | Promise<BackendSessionLaunchConfig>;
  private readonly resolveThreadExecutionContext: (
    threadId: string
  ) => CollabThreadExecutionContext | null;
  private readonly createChildThread: CollabManagerOptions["createChildThread"];
  private readonly startChildTurn: CollabManagerOptions["startChildTurn"];
  private readonly onChildAgentEvent: CollabManagerOptions["onChildAgentEvent"];
  private readonly onChildAgentStatusChanged: CollabManagerOptions["onChildAgentStatusChanged"];
  private nicknameCounter = 0;

  constructor(options: CollabManagerOptions) {
    this.backendRouter =
      options.backendRouter ??
      (options.backend ? new BackendRouter([options.backend]) : new BackendRouter());
    this.notifySink = options.notifySink;
    this.resolveParentTurnId = options.resolveParentTurnId;
    this.resolveThreadHandle =
      options.resolveThreadHandle ?? options.resolveThreadSessionId ?? ((threadId) => threadId);
    this.resolveThreadBackendType = options.resolveThreadBackendType ?? (() => "pi");
    this.createSessionLaunchConfig = options.createSessionLaunchConfig ?? (() => ({}));
    this.resolveThreadExecutionContext = options.resolveThreadExecutionContext ?? (() => null);
    this.createChildThread = options.createChildThread;
    this.startChildTurn = options.startChildTurn;
    this.onChildAgentEvent = options.onChildAgentEvent;
    this.onChildAgentStatusChanged = options.onChildAgentStatusChanged;
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
    };
    this.waits = new CollabWaitQueue((agentId) => this.agents.get(agentId), this.config);
  }

  async spawn(req: CollabSpawnRequest): Promise<CollabSpawnResponse> {
    this.assertSpawnLimits(req.parentThreadId);
    const agentId = randomUUID();
    const nickname = this.assignNickname();
    const role = req.agentType ?? "default";
    const depth = this.depthForParent(req.parentThreadId) + 1;
    const threadId = randomUUID();
    const parentBackendType = this.resolveThreadBackendType(req.parentThreadId);
    if (parentBackendType === "codex" && hasCombinedMessageAndItems(req.message, req.items)) {
      throw new Error("Provide either message or items, but not both");
    }
    const parentBackend = this.requireBackend(parentBackendType);
    const modelSelection = req.model
      ? await this.backendRouter.resolveModelSelection(req.model)
      : null;
    const childBackend = modelSelection?.backend ?? parentBackend;
    if (req.forkContext && childBackend.backendType !== parentBackendType) {
      throw new Error(
        `Cross-backend fork is not supported (${parentBackendType} -> ${childBackend.backendType})`
      );
    }

    const parentContext = this.resolveThreadExecutionContext(req.parentThreadId);
    const sessionLaunchConfig = await this.createSessionLaunchConfig(threadId);
    const useBackendFork = req.forkContext && parentBackendType !== "codex";
    const threadStart: BackendThreadStartResult | BackendThreadForkResult = useBackendFork
      ? await parentBackend.threadFork({
          threadId,
          sourceThreadId: req.parentThreadId,
          sourceThreadHandle: this.resolveThreadHandle(req.parentThreadId),
          cwd: parentContext?.cwd ?? process.cwd(),
          model: modelSelection?.selection.rawModelId ?? null,
          reasoningEffort: req.reasoningEffort ?? null,
          approvalPolicy: parentContext?.approvalPolicy ?? null,
          approvalsReviewer: parentContext?.approvalsReviewer ?? null,
          sandbox: parentContext?.sandbox ?? null,
          config: parentContext?.config ?? null,
          serviceTier: parentContext?.serviceTier ?? null,
          serviceName: parentContext?.serviceName ?? null,
          baseInstructions: parentContext?.baseInstructions ?? null,
          developerInstructions: parentContext?.developerInstructions ?? null,
          personality: parentContext?.personality ?? null,
          persistExtendedHistory: false,
          launchConfig: sessionLaunchConfig,
        })
      : await childBackend.threadStart({
          threadId,
          cwd: parentContext?.cwd ?? process.cwd(),
          model: modelSelection?.selection.rawModelId ?? null,
          reasoningEffort: req.reasoningEffort ?? null,
          approvalPolicy: parentContext?.approvalPolicy ?? null,
          approvalsReviewer: parentContext?.approvalsReviewer ?? null,
          sandbox: parentContext?.sandbox ?? null,
          config: parentContext?.config ?? null,
          serviceTier: parentContext?.serviceTier ?? null,
          serviceName: parentContext?.serviceName ?? null,
          baseInstructions: parentContext?.baseInstructions ?? null,
          developerInstructions: parentContext?.developerInstructions ?? null,
          personality: parentContext?.personality ?? null,
          persistExtendedHistory: false,
          launchConfig: sessionLaunchConfig,
        });
    const backendType = (useBackendFork ? parentBackend : childBackend).backendType;
    const threadHandle = threadStart.threadHandle;
    const selectedModel = modelSelection
      ? this.backendRouter.toClientModelId(backendType, modelSelection.selection.rawModelId)
      : (req.model ?? null);
    const promptPreview = previewFromItems(req.items, req.message);

    try {
      await this.createChildThread({
        agentId,
        nickname,
        role,
        parentThreadId: req.parentThreadId,
        threadId,
        backendType,
        threadHandle,
        path: threadStart.path,
        depth,
        preview: promptPreview.slice(0, 120),
        model: selectedModel,
        reasoningEffort: threadStart.reasoningEffort ?? req.reasoningEffort ?? null,
      });

      const agent: CollabAgent = {
        agentId,
        nickname,
        role,
        threadId,
        sessionId: threadHandle,
        parentThreadId: req.parentThreadId,
        depth,
        status: "pendingInit",
        completionMessage: null,
      };
      this.agents.set(agentId, agent);
      const runtime = new CollabAgentSession(agent, backendType, {
        backendRouter: this.backendRouter,
        resolveThreadExecutionContext: this.resolveThreadExecutionContext,
        startChildTurn: this.startChildTurn,
        onChildAgentEvent: this.onChildAgentEvent,
        onChildAgentStatusChanged: this.onChildAgentStatusChanged,
        onSettled: (agentId) => this.waits.settled(agentId),
      });
      this.agentRuntimes.set(agentId, runtime);
      runtime.bind(backendType);

      const startedItem = this.createToolItem(req.parentThreadId, "spawnAgent", {
        receiverThreadIds: [],
        prompt: promptPreview,
        model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null,
      });
      await this.emitToolItem("item/started", req.parentThreadId, startedItem);

      await this.requireAgentRuntime(agent.agentId).beginTurn(promptPreview);

      startedItem.status = "completed";
      startedItem.receiverThreadIds = [agent.threadId];
      startedItem.agentsStates = this.collectAgentStates([agentId]);
      await this.emitToolItem("item/completed", req.parentThreadId, startedItem);

      this.requireAgentRuntime(agentId).transition("running", null);
      void this.requireAgentRuntime(agentId).startPrompt(
        req.items ?? [{ type: "text", text: req.message, text_elements: [] }]
      );

      return {
        agent_id: agentId,
        nickname,
      };
    } catch (error) {
      this.agentRuntimes.get(agentId)?.unbind();
      this.agents.delete(agentId);
      this.agentRuntimes.delete(agentId);
      const backend = this.requireBackend(backendType);
      await backend
        .threadArchive({
          threadId,
          threadHandle,
        })
        .catch(() => {});
      throw error;
    }
  }

  async sendInput(req: CollabSendInputRequest): Promise<CollabSendInputResponse> {
    const agent = this.requireOwnedAgent(req.parentThreadId, req.id);
    const parentBackendType = this.resolveThreadBackendType(req.parentThreadId);
    if (parentBackendType === "codex" && hasCombinedMessageAndItems(req.message, req.items)) {
      throw new Error("Provide either message or items, but not both");
    }
    const runtime = this.agentRuntimes.get(agent.agentId);
    if (agent.status === "shutdown") {
      throw new Error(`Agent ${req.id} is shutdown and must be resumed before sending input`);
    }
    if (agent.status === "errored") {
      throw new Error(`Agent ${req.id} is errored and must be resumed before sending input`);
    }
    if (runtime?.activeTurnId && !req.interrupt) {
      throw new Error(
        `Agent ${req.id} is already running; wait for it to finish or use interrupt=true`
      );
    }

    const promptPreview = previewFromItems(req.items, req.message);
    const item = this.createToolItem(req.parentThreadId, "sendInput", {
      receiverThreadIds: [agent.threadId],
      prompt: promptPreview,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const backend = this.requireBackend(
      runtime?.backendType ?? this.resolveThreadBackendType(agent.threadId)
    );
    if (req.interrupt && runtime?.activeTurnId) {
      await backend.turnInterrupt({
        threadId: agent.threadId,
        threadHandle: agent.sessionId,
        turnId: runtime.activeTurnId,
      });
      this.requireAgentRuntime(agent.agentId).transition("interrupted", agent.completionMessage);
    }

    const submissionId = randomUUID();
    await this.requireAgentRuntime(agent.agentId).beginTurn(promptPreview);
    this.requireAgentRuntime(agent.agentId).transition("running", null);
    void this.requireAgentRuntime(agent.agentId).startPrompt(
      req.items ?? [{ type: "text", text: req.message, text_elements: [] }]
    );

    item.status = "completed";
    item.agentsStates = this.collectAgentStates([agent.agentId]);
    await this.emitToolItem("item/completed", req.parentThreadId, item);

    return {
      submission_id: submissionId,
    };
  }

  async wait(req: CollabWaitRequest): Promise<CollabWaitResponse> {
    if (req.ids.length === 0) {
      return { status: {}, messages: {}, timed_out: false };
    }

    for (const agentId of req.ids) {
      this.validateParentOwnership(req.parentThreadId, agentId);
    }

    const item = this.createToolItem(req.parentThreadId, "wait", {
      receiverThreadIds: this.collectReceiverThreadIds(req.ids),
      prompt: null,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const response = await this.waits.wait(req.ids, req.timeout_ms);

    item.status = "completed";
    item.agentsStates = this.collectAgentStates(req.ids);
    await this.emitToolItem("item/completed", req.parentThreadId, item);
    return response;
  }

  async close(req: CollabCloseRequest): Promise<CollabCloseResponse> {
    const agent = this.getOwnedAgent(req.parentThreadId, req.id);
    if (!agent) {
      return { previous_status: "notFound" };
    }

    const item = this.createToolItem(req.parentThreadId, "closeAgent", {
      receiverThreadIds: [agent.threadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const previousStatus = agent.status;
    if (agent.status !== "shutdown") {
      await this.shutdownAgent(agent.agentId);
    }

    item.status = "completed";
    item.agentsStates = this.collectAgentStates([agent.agentId]);
    await this.emitToolItem("item/completed", req.parentThreadId, item);

    return {
      previous_status: previousStatus,
    };
  }

  async resume(req: CollabResumeRequest): Promise<CollabResumeResponse> {
    const agent = this.getOwnedAgent(req.parentThreadId, req.id);
    if (!agent) {
      return { status: "notFound" };
    }
    if (agent.status === "running" || agent.status === "pendingInit") {
      throw new Error(`Agent ${req.id} is already active`);
    }

    const item = this.createToolItem(req.parentThreadId, "resumeAgent", {
      receiverThreadIds: [agent.threadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const runtime = this.agentRuntimes.get(agent.agentId);
    runtime?.unbind();
    let sessionId = agent.sessionId;
    let backendType = runtime?.backendType ?? this.resolveThreadBackendType(agent.threadId);
    const backend = this.requireBackend(backendType);
    const context =
      this.resolveThreadExecutionContext(agent.threadId) ??
      this.resolveThreadExecutionContext(req.parentThreadId);
    try {
      const resumed = await backend.threadResume({
        threadId: agent.threadId,
        threadHandle: agent.sessionId,
        cwd: context?.cwd ?? process.cwd(),
        model: null,
        reasoningEffort: null,
        approvalPolicy: context?.approvalPolicy ?? null,
        approvalsReviewer: context?.approvalsReviewer ?? null,
        sandbox: context?.sandbox ?? null,
        config: context?.config ?? null,
        serviceTier: context?.serviceTier ?? null,
        serviceName: context?.serviceName ?? null,
        baseInstructions: context?.baseInstructions ?? null,
        developerInstructions: context?.developerInstructions ?? null,
        personality: context?.personality ?? null,
        persistExtendedHistory: false,
        launchConfig: await this.createSessionLaunchConfig(agent.threadId),
      });
      sessionId = resumed.threadHandle;
    } catch {
      const started = await backend.threadStart({
        threadId: agent.threadId,
        cwd: context?.cwd ?? process.cwd(),
        model: null,
        reasoningEffort: null,
        approvalPolicy: context?.approvalPolicy ?? null,
        approvalsReviewer: context?.approvalsReviewer ?? null,
        sandbox: context?.sandbox ?? null,
        config: context?.config ?? null,
        serviceTier: context?.serviceTier ?? null,
        serviceName: context?.serviceName ?? null,
        baseInstructions: context?.baseInstructions ?? null,
        developerInstructions: context?.developerInstructions ?? null,
        personality: context?.personality ?? null,
        persistExtendedHistory: false,
        launchConfig: await this.createSessionLaunchConfig(agent.threadId),
      });
      sessionId = started.threadHandle;
    }

    backendType = runtime?.backendType ?? backendType;
    this.requireAgentRuntime(agent.agentId).resume(sessionId, backendType);

    item.status = "completed";
    item.agentsStates = this.collectAgentStates([agent.agentId]);
    await this.emitToolItem("item/completed", req.parentThreadId, item);

    return { status: agent.status };
  }

  async shutdownByParent(parentThreadId: string): Promise<void> {
    const agents = [...this.agents.values()].filter(
      (agent) => agent.parentThreadId === parentThreadId
    );
    await Promise.all(
      agents.map((agent) => this.close({ parentThreadId, id: agent.agentId }).then(() => {}))
    );
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => this.shutdownAgent(agent.agentId)));

    this.waits.dispose();
  }

  private assignNickname(): string {
    for (const nickname of AGENT_NICKNAMES) {
      if (!this.nicknames.has(nickname)) {
        this.nicknames.add(nickname);
        return nickname;
      }
    }

    this.nicknameCounter += 1;
    const fallback = `Agent${this.nicknameCounter}`;
    this.nicknames.add(fallback);
    return fallback;
  }

  private assertSpawnLimits(parentThreadId: string): void {
    const activeAgentCount = [...this.agents.values()].filter(
      (agent) => agent.status !== "shutdown"
    ).length;
    if (activeAgentCount >= this.config.maxAgents) {
      throw new Error(`Maximum collab agent count reached (${this.config.maxAgents})`);
    }

    const nextDepth = this.depthForParent(parentThreadId) + 1;
    if (nextDepth > this.config.maxDepth) {
      throw new Error(`Maximum collab depth reached (${this.config.maxDepth})`);
    }
  }

  private depthForParent(parentThreadId: string): number {
    const parentAgent = [...this.agents.values()].find(
      (agent) => agent.threadId === parentThreadId
    );
    return parentAgent?.depth ?? 0;
  }

  private validateParentOwnership(parentThreadId: string, agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    if (agent.parentThreadId !== parentThreadId) {
      throw new Error(`Agent ${agentId} does not belong to parent thread ${parentThreadId}`);
    }
  }

  private getOwnedAgent(parentThreadId: string, agentId: string): CollabAgent | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }
    if (agent.parentThreadId !== parentThreadId) {
      throw new Error(`Agent ${agentId} does not belong to parent thread ${parentThreadId}`);
    }
    return agent;
  }

  private requireOwnedAgent(parentThreadId: string, agentId: string): CollabAgent {
    const agent = this.getOwnedAgent(parentThreadId, agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return agent;
  }

  getAgentByThreadId(threadId: string): CollabAgent | null {
    return [...this.agents.values()].find((agent) => agent.threadId === threadId) ?? null;
  }

  getAgentRuntimeStateByThreadId(threadId: string): {
    status: CollabAgentStatus;
    activeTurnId: string | null;
  } | null {
    const agent = this.getAgentByThreadId(threadId);
    if (!agent) {
      return null;
    }

    const runtime = this.agentRuntimes.get(agent.agentId);
    return {
      status: agent.status,
      activeTurnId: runtime?.activeTurnId ?? null,
    };
  }

  syncExternalResume(threadId: string, sessionId: string, backendType: string): void {
    const agent = this.getAgentByThreadId(threadId);
    if (!agent) {
      return;
    }
    this.requireAgentRuntime(agent.agentId).resume(sessionId, backendType);
  }

  syncExternalTurnStart(threadId: string, turnId: string): void {
    const agent = this.getAgentByThreadId(threadId);
    const runtime = agent ? this.agentRuntimes.get(agent.agentId) : null;
    if (!agent || !runtime) {
      return;
    }

    runtime.syncTurnStart(turnId);
  }

  syncExternalTurnInterrupt(threadId: string): void {
    const agent = this.getAgentByThreadId(threadId);
    const runtime = agent ? this.agentRuntimes.get(agent.agentId) : null;
    if (!agent || !runtime) {
      return;
    }

    runtime.syncTurnInterrupt();
  }

  private async shutdownAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === "shutdown" || this.shuttingDownAgentIds.has(agentId)) {
      return;
    }
    this.shuttingDownAgentIds.add(agentId);

    try {
      await this.shutdownByParent(agent.threadId);

      await this.agentRuntimes.get(agent.agentId)?.shutdown();
    } finally {
      this.shuttingDownAgentIds.delete(agentId);
    }
  }

  private createToolItem(
    parentThreadId: string,
    tool: CollabAgentTool,
    options: {
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
    }
  ): CollabAgentToolCallItem {
    return {
      type: "collabAgentToolCall",
      id: randomUUID(),
      tool,
      status: "inProgress",
      senderThreadId: parentThreadId,
      receiverThreadIds: options.receiverThreadIds,
      prompt: options.prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      agentsStates: {},
    };
  }

  private async emitToolItem(
    method: "item/started" | "item/completed",
    parentThreadId: string,
    item: CollabAgentToolCallItem
  ): Promise<void> {
    await this.notifySink.notify(
      method,
      {
        item: structuredClone(item),
        threadId: parentThreadId,
        turnId: this.resolveParentTurnId(parentThreadId),
      },
      parentThreadId
    );
  }

  private collectReceiverThreadIds(agentIds: readonly string[]): string[] {
    return agentIds.flatMap((agentId) => {
      const agent = this.agents.get(agentId);
      return agent ? [agent.threadId] : [];
    });
  }

  private collectAgentStates(agentIds: readonly string[]): Record<string, CollabAgentState> {
    const states: Record<string, CollabAgentState> = {};
    for (const agentId of agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        continue;
      }
      states[agent.threadId] = collabStateFromAgent(agent);
    }
    return states;
  }

  private requireBackend(backendType: string): IBackend {
    return this.backendRouter.requireBackend(backendType);
  }
  private requireAgentRuntime(agentId: string): CollabAgentSession {
    const runtime = this.agentRuntimes.get(agentId);
    if (!runtime) throw new Error(`Missing runtime for agent ${agentId}`);
    return runtime;
  }
}
