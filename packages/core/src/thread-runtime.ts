import type { AppServerLogger } from "./app-server.js";
import type { DebugLogWriter } from "./app-server-log.js";
import type { BackendAppServerEvent, Disposable } from "./backend.js";
import type { BackendRouter } from "./backend-router.js";
import type { BackendServerRequests } from "./backend-server-requests.js";
import type { BackendThreadMirror } from "./backend-thread-mirror.js";
import type { Thread, ThreadStatus, Turn } from "./protocol.js";
import { serializeThread } from "./thread-protocol.js";
import type { ThreadRegistryEntry } from "./thread-registry.js";

export interface ThreadRuntimeOptions {
  threadId: string;
  backendType: string;
  threadHandle: string;
  managedByCollab: boolean;
  backendRouter: BackendRouter;
  mirror: BackendThreadMirror;
  serverRequests: BackendServerRequests;
  logger: AppServerLogger;
  debugLogWriter: DebugLogWriter | null;
  publish(method: string, params?: unknown, threadId?: string): Promise<void>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function backendEventTurnId(event: BackendAppServerEvent): string | null {
  if (!("params" in event) || !isRecord(event.params)) {
    return null;
  }
  if (typeof event.params.turnId === "string") {
    return event.params.turnId;
  }
  if (isRecord(event.params.turn) && typeof event.params.turn.id === "string") {
    return event.params.turn.id;
  }
  return null;
}

export class ThreadRuntime {
  private phase: "starting" | "ready" | "turn_active" | "forking" | "terminating" = "starting";
  private turnId: string | null = null;
  private latestId: string | null = null;
  private loadedTurnIds: string[] = [];
  private subscription: Disposable | null = null;
  private eventQueue: Promise<void> = Promise.resolve();
  private eventLifetime = 0;
  private readyResolver: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private backend: string;
  private handle: string;
  constructor(private readonly options: ThreadRuntimeOptions) {
    this.backend = options.backendType;
    this.handle = options.threadHandle;
    this.waitForReady();
    this.logTransition("none", "starting");
  }
  get status() {
    return this.phase;
  }
  get activeTurnId() {
    return this.turnId;
  }
  get latestTurnId() {
    return this.latestId;
  }
  get backendType() {
    return this.backend;
  }
  get threadHandle() {
    return this.handle;
  }
  get managedByCollab() {
    return this.options.managedByCollab;
  }
  get threadStatus(): ThreadStatus {
    return this.phase === "ready" ? { type: "idle" } : { type: "active", activeFlags: [] };
  }
  buildThread(entry: ThreadRegistryEntry, turns: Turn[]): Thread {
    return serializeThread(entry, this.threadStatus, turns);
  }
  updateHandle(backendType: string, threadHandle: string): void {
    this.backend = backendType;
    this.handle = threadHandle;
  }
  prepareResume(): void {
    this.eventLifetime += 1;
    const from = this.phase;
    this.phase = "starting";
    this.turnId = null;
    this.unbind();
    this.waitForReady();
    this.logTransition(from, "starting");
  }
  private waitForReady(): void {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });
  }
  private releaseReady(): void {
    this.readyResolver?.();
    this.readyResolver = null;
    this.readyPromise = null;
  }
  ready(): void {
    const from = this.phase;
    this.phase = "ready";
    this.releaseReady();
    this.logTransition(from, "ready");
  }
  recoverActiveTurn(turnId: string | null): void {
    const from = this.phase;
    this.phase = "turn_active";
    this.releaseReady();
    this.turnId = turnId;
    this.latestId = turnId ?? this.latestId;
    this.logTransition(from, "turn_active");
  }
  beginFork(): void {
    this.phase = "forking";
    this.logTransition("ready", "forking");
  }
  finishFork(): void {
    if (this.phase !== "forking") return;
    this.phase = "ready";
    this.logTransition("forking", "ready");
  }
  terminate(): void {
    this.eventLifetime += 1;
    this.stopAcceptingEvents();
  }
  private stopAcceptingEvents(): void {
    const from = this.phase;
    this.phase = "terminating";
    this.releaseReady();
    this.unbind();
    this.logTransition(from, "terminating");
  }
  async dispose(): Promise<void> {
    // Connection shutdown flushes accepted output. Archive and failed/replaced
    // lifetimes instead invalidate it immediately through terminate/resume.
    this.stopAcceptingEvents();
    await this.drain();
    this.eventLifetime += 1;
  }
  async drain(): Promise<void> {
    await this.eventQueue.catch(() => {});
  }
  async requireReady(): Promise<void> {
    if (this.phase === "starting" && this.readyPromise) await this.readyPromise;
    if (this.phase !== "ready")
      throw new Error(`Thread ${this.options.threadId} is not ready (status: ${this.phase})`);
  }
  bindSubscription(direct: boolean): void {
    this.unbind();
    if (!direct) return;
    this.subscription = this.options.backendRouter
      .requireBackend(this.backend)
      .onEvent(this.handle, (event) => this.enqueue(event));
  }
  private unbind(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }
  beginTurn(turnId: string): void {
    this.phase = "turn_active";
    this.turnId = turnId;
    this.latestId = turnId;
    this.unbind();
  }
  acceptTurnId(turnId: string): void {
    this.turnId = turnId;
    this.latestId = turnId;
  }
  async finishTurn(turnId: string): Promise<void> {
    if (this.phase === "terminating" || this.turnId !== turnId) return;
    this.turnId = null;
    this.phase = "ready";
    await this.publishStatus();
  }
  syncCollabStatus(status: string): void {
    if (this.phase === "terminating") return;
    if (status === "completed" || status === "errored" || status === "shutdown") {
      this.turnId = null;
      this.phase = "ready";
    }
  }
  async publishStatus(): Promise<void> {
    if (this.phase === "terminating") return;
    await this.options.publish(
      "thread/status/changed",
      { threadId: this.options.threadId, status: this.threadStatus },
      this.options.threadId
    );
  }
  enqueue(event: BackendAppServerEvent): void {
    if (this.phase === "terminating") return;
    const lifetime = this.eventLifetime;
    const run = async () => this.handleBackendEvent(event, lifetime);
    this.eventQueue = this.eventQueue.then(run, run).catch((error) => {
      this.options.logger.warn("Failed to handle backend event", {
        threadId: this.options.threadId,
        eventKind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  private async handleBackendEvent(event: BackendAppServerEvent, lifetime: number): Promise<void> {
    if (lifetime !== this.eventLifetime) return;
    const threadId = this.options.threadId;
    const turnId = backendEventTurnId(event);
    await this.options.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "backend-event",
      threadId,
      ...(turnId ? { turnId } : {}),
      accepted: true,
      eventType: event.kind,
      payload: event,
    });
    if (lifetime !== this.eventLifetime) return;

    switch (event.kind) {
      case "notification": {
        if (event.method === "thread/started") {
          const updatedThread = await this.options.mirror.syncCanonicalThreadStarted(
            threadId,
            event.params
          );
          if (lifetime !== this.eventLifetime) return;
          if (updatedThread) {
            await this.options.publish(
              "thread/started",
              { thread: this.buildThread(updatedThread, []) },
              threadId
            );
          }
          return;
        }
        const params = await this.options.mirror.translateNotification(
          threadId,
          event.threadHandle,
          event.method,
          event.params
        );
        if (lifetime !== this.eventLifetime) return;
        await this.options.publish(event.method, params, threadId);
        if (lifetime !== this.eventLifetime || this.phase === "terminating") return;
        if (event.method === "turn/started" && turnId) {
          const previousTurnId = this.activeTurnId;
          this.phase = "turn_active";
          this.turnId = turnId;
          this.latestId = turnId;
          this.recordLoadedTurnId(turnId, previousTurnId);
          await this.publishStatus();
        }
        if (event.method === "turn/completed" && turnId) {
          this.recordLoadedTurnId(turnId, this.activeTurnId);
          await this.finishTurn(turnId);
        }
        return;
      }
      case "serverRequest": {
        await this.options.serverRequests.forward(
          threadId,
          this.backendType,
          this.threadHandle,
          event,
          this.options.mirror.rewriteBackendThreadReferences(
            threadId,
            event.threadHandle,
            event.params
          )
        );
        return;
      }
      case "error":
        await this.options.publish(
          "backend/error",
          {
            threadId,
            backendType: this.backendType,
            code: event.code,
            message: event.message,
            retryable: event.retryable,
          },
          threadId
        );
        return;
      case "disconnect":
        await this.options.publish(
          "backend/disconnect",
          {
            threadId,
            backendType: this.backendType,
            message: event.message,
          },
          threadId
        );
        if (lifetime !== this.eventLifetime) return;
        if (this.activeTurnId) {
          await this.finishTurn(this.activeTurnId);
        }
        return;
    }
  }
  recordLoadedTurnId(turnId: string, previousTurnId: string | null = null): void {
    if (previousTurnId) {
      const previousIndex = this.loadedTurnIds.lastIndexOf(previousTurnId);
      if (previousIndex >= 0) {
        this.loadedTurnIds[previousIndex] = turnId;
      }
    }

    if (this.loadedTurnIds.at(-1) !== turnId && !this.loadedTurnIds.includes(turnId)) {
      this.loadedTurnIds.push(turnId);
    }

    this.latestId = turnId;
  }
  reconcileLoadedTurnIds(turns: Turn[]): void {
    if (turns.length === 0) {
      return;
    }

    if (this.loadedTurnIds.length > 0) {
      const suffixLength = Math.min(turns.length, this.loadedTurnIds.length);
      const loadedSuffix = this.loadedTurnIds.slice(-suffixLength);
      for (const [offset, turnId] of loadedSuffix.entries()) {
        const turn = turns[turns.length - suffixLength + offset];
        if (turn) {
          turn.id = turnId;
        }
      }
    }

    this.loadedTurnIds = turns.map((turn) => turn.id);
    this.latestId = this.loadedTurnIds.at(-1) ?? this.latestId;
  }
  private logTransition(from: string, to: string): void {
    void this.options.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "state-transition",
      threadId: this.options.threadId,
      payload: { from, to },
    });
  }
}
