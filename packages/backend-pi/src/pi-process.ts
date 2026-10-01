import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BackendEvent,
  BackendImageInput,
  BackendMessage,
  BackendSessionLaunchConfig,
  BackendTokenUsage,
} from "@codapter/core";
import { assistantMessageText, mapBackendMessages, mapTokenUsage } from "./message-mapping.js";
import {
  parseStateModelContextWindow,
  parseStateModelId,
  parseUpstreamModelFromResponse,
  type UpstreamModel,
} from "./model-catalog.js";
import { type PiProcessResponse, PiRpcTransport } from "./rpc-transport.js";
import type { PiBackendSessionRecord } from "./state-store.js";

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

interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiSessionStateSnapshot {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly sessionName: string | undefined;
  readonly modelId: string | undefined;
  readonly modelContextWindow: number | null;
  readonly reasoningEffort: string | undefined;
}

interface UpstreamSessionState {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly model?: UpstreamModel;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly pendingMessageCount?: number;
}

interface PiLogRecord {
  readonly at: string;
  readonly component: "pi-process";
  readonly kind: "startup" | "shutdown" | "stdin" | "stdout" | "stderr" | "parsed-event";
  readonly raw: string;
  readonly eventType?: string;
  readonly assistantEventType?: string;
  readonly emittedType?: string;
  readonly delta?: string;
  readonly pid?: number;
  readonly command?: string;
  readonly sessionId?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

class PiLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly filePath: string) {}

  write(record: PiLogRecord): void {
    if (this.failed) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });

    void this.pending.catch(() => {
      this.failed = true;
    });
  }

  async flush(): Promise<void> {
    try {
      await this.pending;
    } catch {
      this.failed = true;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageRole(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") {
    return null;
  }
  return message.role;
}

function messageStopReason(message: unknown): string | null {
  if (!isRecord(message) || typeof message.stopReason !== "string") {
    return null;
  }
  return message.stopReason;
}

function isToolUseAssistantMessage(message: unknown): boolean {
  return messageRole(message) === "assistant" && messageStopReason(message) === "toolUse";
}

export function mapSessionRecordFromSnapshot(
  opaqueSessionId: string,
  snapshot: PiSessionStateSnapshot,
  createdAt: string
): PiBackendSessionRecord {
  if (!snapshot.sessionFile) {
    throw new Error("Pi session snapshot did not include a session file");
  }

  return {
    opaqueSessionId,
    sessionFile: snapshot.sessionFile,
    sessionName: snapshot.sessionName ?? null,
    modelId: snapshot.modelId ?? null,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export type PiProcessEvent =
  | BackendEvent
  | { readonly type: "disconnect"; readonly message: string }
  | { readonly type: "extension_error"; readonly message: string };

export class PiProcessSession {
  private readonly opaqueSessionId: string;
  private readonly transport: PiRpcTransport;
  private readonly listeners = new Set<(event: PiProcessEvent) => void>();
  private completion: { text?: string; error?: string } = {};
  private currentTurnId: string | null = null;
  private nativeRunStarted = false;
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
    this.transport = new PiRpcTransport({
      command,
      args,
      env,
      cwd,
      requestTimeoutMs,
      onEvent: (event) => this.handleEvent(event),
      onDisconnect: (error) => {
        if (this.currentTurnId) {
          this.emit({
            sessionId: this.opaqueSessionId,
            turnId: this.currentTurnId,
            type: "error",
            message: error.message,
          });
          this.currentTurnId = null;
        }
        this.emit({ type: "disconnect", message: error.message });
      },
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
    return this.currentTurnId !== null;
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
    if (this.currentTurnId) throw new Error("Pi session already has an active turn");
    this.currentTurnId = turnId;
    this.nativeRunStarted = false;
    const abort = new AbortController();
    this.promptAbort = abort;
    this.completion = {};
    try {
      await this.ensureStarted();
      abort.signal.throwIfAborted();
      const converted = await this.convertImages(images, abort.signal);
      abort.signal.throwIfAborted();
      const response = await this.sendRequest<{ disposition?: string }>({
        type: "prompt",
        message,
        images: converted,
      });
      if (response.data?.disposition === "handled" && this.currentTurnId === turnId) {
        await this.finishHandledPromptIfIdle(turnId);
      }
    } catch (error) {
      this.currentTurnId = null;
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
    this.currentTurnId = null;
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

  private handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "agent_start":
        this.nativeRunStarted = true;
        return;
      case "turn_start":
        return;
      case "turn_end":
      case "agent_end":
        return;
      case "agent_settled":
        this.finishTurn();
        return;
      case "message_update":
        this.emitMessageUpdate(event);
        return;
      case "message_end":
        if (messageRole(event.message) !== "assistant") {
          return;
        }
        if (isToolUseAssistantMessage(event.message)) {
          return;
        }
        {
          const text = assistantMessageText(event.message);
          const message = isRecord(event.message) ? event.message : {};
          this.completion = {
            ...(text !== null ? { text } : {}),
            ...(message.stopReason === "error" || message.stopReason === "aborted"
              ? {
                  error: String(
                    message.errorMessage ?? `Pi assistant ${String(message.stopReason)}`
                  ),
                }
              : {}),
          };
        }
        return;
      case "tool_execution_start":
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "tool_start",
          toolCallId: String(event.toolCallId ?? "unknown"),
          toolName: String(event.toolName ?? "unknown"),
          input: event.args,
        });
        return;
      case "tool_execution_update":
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "tool_update",
          toolCallId: String(event.toolCallId ?? "unknown"),
          toolName: String(event.toolName ?? "unknown"),
          output: event.partialResult,
          isCumulative: true,
        });
        return;
      case "tool_execution_end":
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "tool_end",
          toolCallId: String(event.toolCallId ?? "unknown"),
          toolName: String(event.toolName ?? "unknown"),
          output: event.result,
          isError: Boolean(event.isError),
        });
        return;
      case "extension_ui_request":
        if (
          event.method === "select" ||
          event.method === "confirm" ||
          event.method === "input" ||
          event.method === "editor"
        ) {
          this.emit({
            sessionId: this.opaqueSessionId,
            turnId: this.currentTurnId ?? "unknown",
            type: "elicitation_request",
            requestId: String(event.id ?? randomUUID()),
            payload: event,
          });
        }
        return;
      case "extension_error":
        this.emit({
          type: "extension_error",
          message: String(event.error ?? event.message ?? "Pi extension error"),
        });
        return;
      case "error":
        this.emit({
          sessionId: this.opaqueSessionId,
          turnId: this.currentTurnId ?? "unknown",
          type: "error",
          message: String(event.error ?? event.message ?? "Pi runtime error"),
        });
        return;
      default:
        return;
    }
  }

  private emitMessageUpdate(event: Record<string, unknown>): void {
    const assistantEvent = isRecord(event.assistantMessageEvent)
      ? event.assistantMessageEvent
      : undefined;
    if (!assistantEvent || typeof assistantEvent.type !== "string") {
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        raw: JSON.stringify(event),
      });
      return;
    }

    if (assistantEvent.type === "text_delta") {
      const delta = String(assistantEvent.delta ?? "");
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        assistantEventType: assistantEvent.type,
        emittedType: "text_delta",
        delta,
        raw: JSON.stringify(event),
      });
      this.emit({
        sessionId: this.opaqueSessionId,
        turnId: this.currentTurnId ?? "unknown",
        type: "text_delta",
        delta,
      });
      return;
    }

    if (assistantEvent.type === "thinking_delta") {
      const delta = String(assistantEvent.delta ?? "");
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        assistantEventType: assistantEvent.type,
        emittedType: "thinking_delta",
        delta,
        raw: JSON.stringify(event),
      });
      this.emit({
        sessionId: this.opaqueSessionId,
        turnId: this.currentTurnId ?? "unknown",
        type: "thinking_delta",
        delta,
      });
      return;
    }

    if (assistantEvent.type === "error") {
      this.logWriter?.write({
        at: new Date().toISOString(),
        component: "pi-process",
        kind: "parsed-event",
        eventType: "message_update",
        assistantEventType: assistantEvent.type,
        emittedType: "error",
        raw: JSON.stringify(event),
      });
      this.completion = { error: String(assistantEvent.errorMessage ?? "Pi assistant error") };
      return;
    }

    this.logWriter?.write({
      at: new Date().toISOString(),
      component: "pi-process",
      kind: "parsed-event",
      eventType: "message_update",
      assistantEventType: assistantEvent.type,
      raw: JSON.stringify(event),
    });
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

  private finishTurn(): void {
    const turnId = this.currentTurnId;
    if (!turnId) return;
    this.currentTurnId = null;
    this.nativeRunStarted = false;
    this.promptAbort = null;
    this.emitTokenUsage(turnId);
    this.emit(
      this.completion.error
        ? { sessionId: this.opaqueSessionId, turnId, type: "error", message: this.completion.error }
        : { sessionId: this.opaqueSessionId, turnId, type: "message_end", ...this.completion }
    );
    this.completion = {};
  }

  private async finishHandledPromptIfIdle(turnId: string): Promise<void> {
    if (this.nativeRunStarted) return;
    // "handled" describes this input, not work pi.sendUserMessage started.
    // Query after the acknowledgement to catch activity that begins asynchronously.
    // agent_start/settled may arrive while this state request is outstanding.
    const response = await this.sendRequest<UpstreamSessionState>({ type: "get_state" });
    const state = response.data;
    if (
      this.currentTurnId === turnId &&
      !this.nativeRunStarted &&
      !state?.isStreaming &&
      !state?.isCompacting &&
      !(state?.pendingMessageCount && state.pendingMessageCount > 0)
    ) {
      this.finishTurn();
    }
  }

  private applySnapshot(snapshot: PiSessionStateSnapshot): void {
    this.currentSessionFile = snapshot.sessionFile;
    this.currentSessionName = snapshot.sessionName;
    this.currentModelContextWindow = snapshot.modelContextWindow;
  }

  private async convertImages(
    images?: readonly BackendImageInput[],
    signal?: AbortSignal
  ): Promise<readonly PiImageContent[] | undefined> {
    if (!images || images.length === 0) {
      return undefined;
    }

    const converted = await Promise.all(
      images.map(async (image) => {
        if (typeof image.data === "string" && image.data.length > 0) {
          return {
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType ?? "image/png",
          };
        }

        if (typeof image.path === "string" && image.path.length > 0) {
          const buffer = await readFile(image.path, { signal });
          return {
            type: "image" as const,
            data: buffer.toString("base64"),
            mimeType: image.mimeType ?? "image/png",
          };
        }

        if (typeof image.url === "string" && image.url.length > 0) {
          const response = await fetch(image.url, { ...(signal ? { signal } : {}) });
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          return {
            type: "image" as const,
            data: buffer.toString("base64"),
            mimeType: image.mimeType ?? response.headers.get("content-type") ?? "image/png",
          };
        }

        throw new Error("Pi backend requires image data, file path, or URL");
      })
    );

    return converted;
  }
}

function normalizeElicitationResponse(
  requestId: string,
  responseValue: unknown
): Record<string, unknown> {
  if (typeof responseValue === "string") {
    return { type: "extension_ui_response", id: requestId, value: responseValue };
  }

  if (typeof responseValue === "boolean") {
    return { type: "extension_ui_response", id: requestId, confirmed: responseValue };
  }

  if (isRecord(responseValue)) {
    if (responseValue.cancelled === true) {
      return { type: "extension_ui_response", id: requestId, cancelled: true as const };
    }

    if (typeof responseValue.value === "string") {
      return { type: "extension_ui_response", id: requestId, value: responseValue.value };
    }

    if (typeof responseValue.confirmed === "boolean") {
      return { type: "extension_ui_response", id: requestId, confirmed: responseValue.confirmed };
    }
  }

  throw new Error("Unsupported Pi elicitation response shape");
}
