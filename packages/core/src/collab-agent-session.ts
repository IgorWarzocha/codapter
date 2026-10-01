import { randomUUID } from "node:crypto";
import type { BackendAppServerEvent, Disposable } from "./backend.js";
import type { BackendRouter } from "./backend-router.js";
import type { CollabAgent, CollabAgentStatus } from "./collab-types.js";
import type { UserInput } from "./protocol.js";
import type { ThreadExecutionContext } from "./thread-execution.js";

export interface CollabAgentSessionOptions {
  backendRouter: BackendRouter;
  resolveThreadExecutionContext(threadId: string): ThreadExecutionContext | null;
  startChildTurn?: (input: { agent: CollabAgent; message: string }) => string | Promise<string>;
  onChildAgentEvent?: (input: {
    agent: CollabAgent;
    event: BackendAppServerEvent;
  }) => void | Promise<void>;
  onChildAgentStatusChanged?: (input: {
    agent: CollabAgent & { backendType: string; threadHandle: string };
  }) => void | Promise<void>;
  onSettled(agentId: string): void;
}

export class CollabAgentSession {
  private subscription: Disposable | null = null;
  private turnId: string | null = null;
  private lastAssistantText = "";
  private backend: string;
  constructor(
    readonly agent: CollabAgent,
    backendType: string,
    private readonly options: CollabAgentSessionOptions
  ) {
    this.backend = backendType;
  }
  get backendType() {
    return this.backend;
  }
  get activeTurnId() {
    return this.turnId;
  }
  bind(backendType: string): void {
    this.unbind();
    this.backend = backendType;
    this.subscription = this.options.backendRouter
      .requireBackend(backendType)
      .onEvent(this.agent.sessionId, (event) => {
        void this.handleChildEvent(event);
      });
  }
  unbind(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }
  resume(sessionId: string, backendType: string): void {
    this.agent.sessionId = sessionId;
    this.bind(backendType);
    this.transition("running", this.agent.completionMessage);
  }
  syncTurnStart(turnId: string): void {
    this.turnId = turnId;
    this.lastAssistantText = "";
    this.transition("running", null);
  }
  syncTurnInterrupt(): void {
    this.turnId = null;
    this.lastAssistantText = "";
    this.transition("interrupted", null);
  }
  async beginTurn(message: string): Promise<string> {
    const turnId = this.options.startChildTurn
      ? await this.options.startChildTurn({ agent: structuredClone(this.agent), message })
      : randomUUID();
    this.turnId = turnId;
    this.lastAssistantText = "";
    return turnId;
  }
  async shutdown(): Promise<void> {
    const backend = this.options.backendRouter.requireBackend(this.backend);
    if (this.turnId) {
      await backend
        .turnInterrupt({
          threadId: this.agent.threadId,
          threadHandle: this.agent.sessionId,
          turnId: this.turnId,
        })
        .catch(() => {});
    }
    this.unbind();
    this.turnId = null;
    this.lastAssistantText = "";
    await backend
      .threadArchive({ threadId: this.agent.threadId, threadHandle: this.agent.sessionId })
      .catch(() => {});
    this.transition("shutdown", this.agent.completionMessage);
    this.options.onSettled(this.agent.agentId);
  }
  async startPrompt(input: readonly UserInput[]): Promise<void> {
    const agent = this.agent;
    if (!this.turnId) return;

    try {
      const backend = this.options.backendRouter.requireBackend(this.backend);
      const childContext = this.options.resolveThreadExecutionContext(agent.threadId);
      const parentContext = this.options.resolveThreadExecutionContext(agent.parentThreadId);
      const context = childContext ?? parentContext;
      const selectedModel = childContext?.model
        ? (this.options.backendRouter.parseModelSelection(childContext.model)?.selection
            .rawModelId ?? childContext.model)
        : null;
      await backend.turnStart({
        threadId: agent.threadId,
        threadHandle: agent.sessionId,
        turnId: this.turnId,
        cwd: context?.cwd ?? process.cwd(),
        input: [...input],
        model: selectedModel,
        reasoningEffort: childContext?.reasoningEffort ?? null,
        approvalPolicy: context?.approvalPolicy ?? null,
        approvalsReviewer: context?.approvalsReviewer ?? null,
        sandboxPolicy: context?.sandboxPolicy ?? null,
        serviceTier: context?.serviceTier ?? null,
        summary: context?.summary ?? null,
        personality: context?.personality ?? null,
        collaborationMode: context?.collaborationMode ?? null,
        emitUserMessage: true,
      });
    } catch (error) {
      this.transition("errored", error instanceof Error ? error.message : String(error));
      this.options.onSettled(agent.agentId);
    }
  }
  private async handleChildEvent(event: BackendAppServerEvent): Promise<void> {
    const agent = this.agent;
    void this.options.onChildAgentEvent?.({ agent: structuredClone(agent), event });

    if (event.kind === "notification") {
      if (
        event.method === "item/agentMessage/delta" &&
        typeof (event.params as { delta?: unknown }).delta === "string"
      ) {
        this.lastAssistantText += (event.params as { delta: string }).delta;
        return;
      }

      if (event.method === "item/completed") {
        const item = (event.params as { item?: { type?: unknown; text?: unknown } }).item;
        if (
          item?.type === "agentMessage" &&
          typeof item.text === "string" &&
          item.text.length > 0
        ) {
          this.lastAssistantText = item.text;
        }
      }

      if (event.method === "turn/completed") {
        const params = event.params as {
          turn?: {
            status?: unknown;
            error?: { message?: unknown };
            items?: Array<{ type?: unknown; text?: unknown }>;
          };
        };
        if (!this.lastAssistantText && Array.isArray(params.turn?.items)) {
          const latestAgentMessage = [...params.turn.items]
            .reverse()
            .find((item) => item?.type === "agentMessage" && typeof item?.text === "string");
          if (latestAgentMessage && typeof latestAgentMessage.text === "string") {
            this.lastAssistantText = latestAgentMessage.text;
          }
        }
        const status = params.turn?.status;
        this.turnId = null;
        if (status === "completed" || status === "interrupted") {
          this.transition("completed", this.lastAssistantText || null);
        } else if (status === "failed") {
          const message =
            typeof params.turn?.error?.message === "string"
              ? params.turn.error.message
              : this.lastAssistantText || "Child agent turn failed";
          this.transition("errored", message);
        } else {
          this.transition("completed", this.lastAssistantText || null);
        }
        this.options.onSettled(agent.agentId);
      }
      return;
    }

    if (event.kind === "error" || event.kind === "disconnect") {
      this.turnId = null;
      this.transition(
        "errored",
        event.kind === "error" ? event.message : `Backend disconnected: ${event.message}`
      );
      this.options.onSettled(agent.agentId);
    }
  }
  transition(status: CollabAgentStatus, message: string | null): void {
    const agent = this.agent;
    agent.status = status;
    agent.completionMessage = message;
    void this.options.onChildAgentStatusChanged?.({
      agent: {
        ...structuredClone(agent),
        backendType: this.backend,
        threadHandle: agent.sessionId,
      },
    });
  }
}
