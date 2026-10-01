import type {
  BackendAppServerEvent,
  BackendImageInput,
  BackendResolveServerRequestInput,
  BackendTurnInterruptInput,
  BackendTurnStartInput,
  BackendTurnStartResult,
  Disposable,
  JsonValue,
} from "@codapter/core";
import { BackendThreadEventBuffer, TurnStateMachine, toThreadTokenUsage } from "@codapter/core";
import { mapExtensionDialog, mapExtensionDialogResponse } from "./extension-ui.js";
import type { PiProcessEvent, PiProcessSession } from "./pi-process.js";
import type { PiSessionRuntime } from "./session-runtime.js";

interface PiThreadRuntime {
  threadId: string;
  activeTurnId: string | null;
  machine: TurnStateMachine | null;
  pendingElicitationPayloads: Map<string, unknown>;
  processSubscription: Disposable | null;
  eventQueue: Promise<void>;
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
        userContent.push({ type: "text", text: item.text, text_elements: [] });
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

// The public backend owns sessions. This controller owns turn reservation,
// serialized event delivery and native-dialog request/response pairing.
export class PiThreadController {
  private readonly threadRuntimes = new Map<string, PiThreadRuntime>();
  private readonly eventBuffer = new BackendThreadEventBuffer();

  constructor(
    private readonly sessions: Pick<
      PiSessionRuntime,
      "setModel" | "setThinkingLevel" | "prompt" | "abort" | "respondToElicitation"
    >,
    private readonly getActiveProcess: (handle: string) => Promise<PiProcessSession>,
    private readonly getProcess: (handle: string) => PiProcessSession | undefined,
    private readonly resetIdleTimer: (handle: string) => void
  ) {}

  dispose(): void {
    for (const runtime of this.threadRuntimes.values()) runtime.processSubscription?.dispose();
    this.threadRuntimes.clear();
  }

  remove(handle: string): void {
    this.detach(handle);
    this.threadRuntimes.delete(handle);
  }

  detach(handle: string): void {
    const runtime = this.threadRuntimes.get(handle);
    runtime?.processSubscription?.dispose();
    if (runtime) runtime.processSubscription = null;
  }

  reconnect(handle: string): void {
    const runtime = this.threadRuntimes.get(handle);
    if (runtime) runtime.processSubscription = this.subscribeProcessEvents(handle);
  }

  hasActiveTurn(handle: string): boolean {
    return Boolean(this.threadRuntimes.get(handle)?.activeTurnId);
  }

  liveTurn(handle: string) {
    return this.threadRuntimes.get(handle)?.machine?.snapshot;
  }

  onEvent(handle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    this.bindThread(handle, this.threadRuntimes.get(handle)?.threadId ?? handle);
    return this.eventBuffer.subscribe(handle, listener);
  }

  async turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult> {
    const normalized = normalizeTurnInput(input.input);
    const session = await this.getActiveProcess(input.threadHandle);
    const runtime = this.bindThread(input.threadHandle, input.threadId);
    if (runtime.activeTurnId || session.isBusy) {
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
      if (input.model) await this.sessions.setModel(input.threadHandle, input.model);
      if (input.reasoningEffort)
        await this.sessions.setThinkingLevel(input.threadHandle, input.reasoningEffort);
      if (runtime.machine !== machine) throw new Error("Pi turn was interrupted before prompting");
      await machine.emitStarted();
      if (normalized.userContent.length > 0) {
        await machine.emitUserMessage(normalized.userContent, {
          notify: input.emitUserMessage ?? false,
        });
      }
      if (runtime.machine !== machine) throw new Error("Pi turn was interrupted before prompting");
      await this.sessions.prompt(
        input.threadHandle,
        input.turnId,
        normalized.text,
        normalized.images
      );
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
      await this.sessions.abort(input.threadHandle);
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
    await this.sessions.respondToElicitation(
      input.threadHandle,
      String(input.requestId),
      mapExtensionDialogResponse(String(input.requestId), payload, input.response)
    );
    runtime?.pendingElicitationPayloads.delete(String(input.requestId));
  }

  bindThread(threadHandle: string, threadId = threadHandle): PiThreadRuntime {
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
    const session = this.getProcess(threadHandle);
    if (!session?.isRunning()) return null;
    return session.addListener((event) => {
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
}
