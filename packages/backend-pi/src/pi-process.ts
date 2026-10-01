import type {
  BackendImageInput,
  BackendMessage,
  BackendSessionLaunchConfig,
  BackendTokenUsage,
} from "@codapter/core";
import { normalizeElicitationResponse } from "./extension-ui.js";
import { convertImages } from "./image-input.js";
import { mapBackendMessages, mapTokenUsage } from "./message-mapping.js";
import {
  parseStateModelContextWindow,
  parseStateModelId,
  parseUpstreamModelFromResponse,
  type UpstreamModel,
} from "./model-catalog.js";
import { PiLogWriter } from "./process-log.js";
import { type PiProcessResponse, PiRpcTransport } from "./rpc-transport.js";
import { type PiProcessEvent, type PiRunState, PiTurnStream } from "./turn-stream.js";

export type { PiProcessEvent } from "./turn-stream.js";

export interface PiProcessLaunchOptions {
  readonly opaqueSessionId: string;
  readonly sessionDir: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly collabExtensionPath?: string | null;
  readonly launchConfig?: BackendSessionLaunchConfig;
  readonly requestTimeoutMs?: number;
}

export interface PiSessionStateSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly sessionName: string | undefined;
  readonly modelId: string | undefined;
  readonly modelContextWindow: number | null;
  readonly reasoningEffort: string | undefined;
}

interface UpstreamSessionState extends PiRunState {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly model?: UpstreamModel;
  readonly thinkingLevel?: string;
}

export class PiProcessSession {
  private readonly opaqueSessionId: string;
  private readonly transport: PiRpcTransport;
  private readonly listeners = new Set<(event: PiProcessEvent) => void>();
  private readonly turnStream: PiTurnStream;
  private promptAbort: AbortController | null = null;
  private currentSessionFile: string | undefined;
  private currentSessionName: string | undefined;
  private currentModelContextWindow: number | null = null;
  private readonly logWriter: PiLogWriter | null;
  constructor(options: PiProcessLaunchOptions) {
    this.opaqueSessionId = options.opaqueSessionId;
    const command = options.command ?? "pi";
    const args = [
      ...(options.args ?? ["--mode", "rpc"]),
      "--session-dir",
      options.sessionDir,
      ...(options.collabExtensionPath ? ["--extension", options.collabExtensionPath] : []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options.env ?? process.env),
      ...(options.launchConfig?.collabSocketPath
        ? { CODAPTER_COLLAB_UDS: options.launchConfig.collabSocketPath }
        : {}),
      ...(options.launchConfig?.threadId
        ? { CODAPTER_COLLAB_PARENT_THREAD: options.launchConfig.threadId }
        : {}),
      ...(options.launchConfig?.availableModelsDescription
        ? {
            CODAPTER_COLLAB_AVAILABLE_MODELS_DESCRIPTION:
              options.launchConfig.availableModelsDescription,
          }
        : {}),
    };
    const cwd = options.cwd ?? process.cwd();
    const logFilePath = env.CODAPTER_DEBUG_LOG_FILE;
    this.logWriter =
      typeof logFilePath === "string" && logFilePath.length > 0
        ? new PiLogWriter(logFilePath)
        : null;
    const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("Pi requestTimeoutMs must be a positive finite number");
    }
    this.turnStream = new PiTurnStream(
      this.opaqueSessionId,
      (event) => this.emit(event),
      () => this.sendRequest<UpstreamSessionState>({ type: "get_state" }),
      (turnId) => {
        this.promptAbort = null;
        this.emitTokenUsage(turnId);
      },
      this.logWriter
    );
    this.transport = new PiRpcTransport({
      command,
      args,
      env,
      cwd,
      requestTimeoutMs,
      onEvent: (event) => this.turnStream.handleEvent(event),
      onDisconnect: (error) => this.turnStream.disconnect(error),
      log: (kind, raw, pid) =>
        this.logWriter?.write({
          at: new Date().toISOString(),
          component: "pi-process",
          kind,
          raw,
          ...(pid !== undefined ? { pid } : {}),
          ...(kind === "startup" ? { command, sessionId: this.opaqueSessionId } : {}),
        }),
    });
  }

  isRunning(): boolean {
    return this.transport.isRunning();
  }

  addListener(listener: (event: PiProcessEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  get sessionFile(): string | undefined {
    return this.currentSessionFile;
  }

  get sessionName(): string | undefined {
    return this.currentSessionName;
  }

  async startFresh(parentSession?: string): Promise<PiSessionStateSnapshot> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ cancelled: boolean }>({
      type: "new_session",
      parentSession,
    });
    if (response.data?.cancelled) {
      throw new Error("Pi new_session was cancelled");
    }

    const snapshot = await this.getState();
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async attachSession(sessionPath: string): Promise<PiSessionStateSnapshot> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ cancelled: boolean }>({
      type: "switch_session",
      sessionPath,
    });
    if (response.data?.cancelled) {
      throw new Error(`Pi switch_session was cancelled for ${sessionPath}`);
    }

    const snapshot = await this.getState();
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async cloneSession(): Promise<void> {
    const response = await this.sendRequest<{ cancelled: boolean }>({ type: "clone" });
    if (response.data?.cancelled) throw new Error("Pi clone was cancelled");
    this.applySnapshot(await this.getState());
  }

  get isBusy(): boolean {
    return this.turnStream.isBusy;
  }

  async setThinkingLevel(effort: string): Promise<void> {
    const level = effort === "none" ? "off" : effort;
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
      throw new Error(`Unsupported Pi reasoning effort: ${effort}`);
    }
    await this.sendRequest({ type: "set_thinking_level", level });
  }

  async prompt(
    turnId: string,
    message: string,
    images?: readonly BackendImageInput[]
  ): Promise<void> {
    this.turnStream.begin(turnId);
    const abort = new AbortController();
    this.promptAbort = abort;
    try {
      await this.ensureStarted();
      abort.signal.throwIfAborted();
      const converted = await convertImages(images, abort.signal);
      abort.signal.throwIfAborted();
      const response = await this.sendRequest<{ disposition?: string }>({
        type: "prompt",
        message,
        images: converted,
      });
      if (response.data?.disposition === "handled") {
        await this.turnStream.finishHandledPromptIfIdle(turnId);
      }
    } catch (error) {
      this.turnStream.reset();
      this.promptAbort = null;
      throw error;
    }
  }

  async abort(): Promise<void> {
    this.promptAbort?.abort(new Error("Pi prompt was aborted"));
    await this.ensureStarted();
    await this.sendRequest({ type: "abort" });
  }

  async getState(): Promise<PiSessionStateSnapshot> {
    const response = await this.sendRequest<UpstreamSessionState>({ type: "get_state" });
    const state = response.data;

    return {
      sessionId: typeof state?.sessionId === "string" ? state.sessionId : this.opaqueSessionId,
      sessionFile: typeof state?.sessionFile === "string" ? state.sessionFile : undefined,
      sessionName: typeof state?.sessionName === "string" ? state.sessionName : undefined,
      modelId: parseStateModelId(state?.model),
      modelContextWindow: parseStateModelContextWindow(state?.model),
      reasoningEffort: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : undefined,
    };
  }

  async setSessionName(name: string): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest({ type: "set_session_name", name });
    this.currentSessionName = name;
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ model?: UpstreamModel }>({
      type: "set_model",
      provider,
      modelId,
    });
    const model = parseUpstreamModelFromResponse(response.data);
    this.currentModelContextWindow = model
      ? parseStateModelContextWindow(model)
      : this.currentModelContextWindow;
    return response.data;
  }

  async getAvailableModels(): Promise<unknown> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ models: unknown[] }>({
      type: "get_available_models",
    });
    return response.data?.models ?? [];
  }

  async getAvailableThinkingLevels(): Promise<readonly string[]> {
    const response = await this.sendRequest<{ levels: unknown }>({
      type: "get_available_thinking_levels",
    });
    if (
      !Array.isArray(response.data?.levels) ||
      !response.data.levels.every((level) => typeof level === "string")
    ) {
      throw new Error("Pi returned invalid thinking levels");
    }
    return response.data.levels;
  }

  async getMessages(): Promise<BackendMessage[]> {
    await this.ensureStarted();
    const response = await this.sendRequest<{ messages: unknown[] }>({ type: "get_messages" });
    return mapBackendMessages(response.data?.messages ?? []);
  }

  async getSessionStats(): Promise<BackendTokenUsage> {
    await this.ensureStarted();
    const response = await this.sendRequest<unknown>({ type: "get_session_stats" });
    return {
      ...mapTokenUsage(response.data),
      modelContextWindow: this.currentModelContextWindow,
    };
  }

  async respondToElicitation(requestId: string, responseValue: unknown): Promise<void> {
    await this.ensureStarted();
    const response = normalizeElicitationResponse(requestId, responseValue);
    await this.transport.write(response);
  }

  async dispose(): Promise<void> {
    this.promptAbort?.abort(new Error("Pi session has been disposed"));
    await this.transport.dispose();
    this.turnStream.reset();
    this.promptAbort = null;
    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "shutdown",
      raw: "",
      exitCode: this.transport.exitCode,
      signal: this.transport.exitSignal,
      sessionId: this.opaqueSessionId,
    });
    await this.logWriter?.flush();
  }

  getStderr(): string {
    return this.transport.getStderr();
  }

  private async ensureStarted(): Promise<void> {
    await this.transport.start();
  }

  private emitTokenUsage(turnId: string): void {
    void this.getSessionStats()
      .then((usage) => {
        if (!this.transport.isRunning()) return;
        this.logWriter?.write({
          at: new Date().toISOString(),
          component: "pi-process",
          kind: "parsed-event",
          eventType: "token_usage",
          raw: JSON.stringify({ turnId, usage }),
        });
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId,
          type: "token_usage",
          usage,
        });
      })
      .catch(() => {
        if (!this.transport.isRunning()) return;
        this.logWriter?.write({
          at: new Date().toISOString(),
          component: "pi-process",
          kind: "parsed-event",
          eventType: "token_usage",
          raw: JSON.stringify({
            turnId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
              modelContextWindow: this.currentModelContextWindow,
            },
            fallback: true,
          }),
        });
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId,
          type: "token_usage",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            modelContextWindow: this.currentModelContextWindow,
          },
        });
      });
  }

  private emit(event: PiProcessEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async sendRequest<T = unknown>(
    command: Record<string, unknown>
  ): Promise<PiProcessResponse<T>> {
    return await this.transport.request<T>(command);
  }

  private applySnapshot(snapshot: PiSessionStateSnapshot): void {
    this.currentSessionFile = snapshot.sessionFile;
    this.currentSessionName = snapshot.sessionName;
    this.currentModelContextWindow = snapshot.modelContextWindow;
  }
}
