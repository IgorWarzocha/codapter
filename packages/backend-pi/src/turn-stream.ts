import { randomUUID } from "node:crypto";
import type { BackendEvent } from "@codapter/core";
import { assistantMessageText } from "./message-mapping.js";
import type { PiLogWriter } from "./process-log.js";

export interface PiRunState {
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly pendingMessageCount?: number;
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

export type PiProcessEvent =
  | BackendEvent
  | { readonly type: "disconnect"; readonly message: string }
  | { readonly type: "extension_error"; readonly message: string };

export class PiTurnStream {
  private completion: { text?: string; error?: string } = {};
  private currentTurnId: string | null = null;
  private nativeRunStarted = false;

  constructor(
    private readonly opaqueSessionId: string,
    private readonly emit: (event: PiProcessEvent) => void,
    private readonly readState: () => Promise<{ data?: PiRunState }>,
    private readonly onSettled: (turnId: string) => void,
    private readonly logWriter: PiLogWriter | null
  ) {}

  get isBusy(): boolean {
    return this.currentTurnId !== null;
  }

  begin(turnId: string): void {
    if (this.currentTurnId) throw new Error("Pi session already has an active turn");
    this.currentTurnId = turnId;
    this.nativeRunStarted = false;
    this.completion = {};
  }

  reset(): void {
    this.currentTurnId = null;
    this.nativeRunStarted = false;
    this.completion = {};
  }

  disconnect(error: Error): void {
    if (this.currentTurnId) {
      this.emit({
        sessionId: this.opaqueSessionId,
        turnId: this.currentTurnId,
        type: "error",
        message: error.message,
      });
    }
    this.reset();
    this.emit({ type: "disconnect", message: error.message });
  }

  handleEvent(event: Record<string, unknown>): void {
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

  private finishTurn(): void {
    const turnId = this.currentTurnId;
    if (!turnId) return;
    this.currentTurnId = null;
    this.nativeRunStarted = false;

    this.onSettled(turnId);
    this.emit(
      this.completion.error
        ? { sessionId: this.opaqueSessionId, turnId, type: "error", message: this.completion.error }
        : { sessionId: this.opaqueSessionId, turnId, type: "message_end", ...this.completion }
    );
    this.completion = {};
  }

  async finishHandledPromptIfIdle(turnId: string): Promise<void> {
    if (this.currentTurnId !== turnId || this.nativeRunStarted) return;
    // "handled" describes this input, not work pi.sendUserMessage started.
    // Query after the acknowledgement to catch activity that begins asynchronously.
    // agent_start/settled may arrive while this state request is outstanding.
    const response = await this.readState();
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
}
