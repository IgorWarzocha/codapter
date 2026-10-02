import { randomUUID } from "node:crypto";
import type { AppServerLogger } from "./app-server.js";
import type { BackendAppServerEvent, BackendResolveServerRequestInput } from "./backend.js";
import type { BackendRouter } from "./backend-router.js";
import { isRecord, type JsonRpcEnvelope, type JsonRpcResponse } from "./jsonrpc.js";

interface PendingBackendServerRequest {
  threadId: string;
  backendType: string;
  threadHandle: string;
  backendRequestId: string | number;
}

export class BackendServerRequests {
  private readonly pendingBackendServerRequests = new Map<
    string | number,
    PendingBackendServerRequest
  >();
  constructor(
    private readonly backendRouter: BackendRouter,
    private readonly logger: AppServerLogger,
    private readonly send: (message: JsonRpcEnvelope) => Promise<void>,
    private readonly publish: (method: string, params: unknown, threadId: string) => Promise<void>
  ) {}
  clear(): void {
    this.pendingBackendServerRequests.clear();
  }
  async forward(
    threadId: string,
    backendType: string,
    threadHandle: string,
    event: Extract<BackendAppServerEvent, { kind: "serverRequest" }>,
    params: unknown
  ): Promise<void> {
    const requestId = randomUUID();
    this.pendingBackendServerRequests.set(requestId, {
      threadId,
      backendType,
      threadHandle,
      backendRequestId: event.requestId,
    });
    // Dynamic tool arguments belong to the GUI tool, not the thread protocol.
    // Restore the opaque payload after translation of the request envelope.
    const requestParams =
      event.method === "item/tool/call" && isRecord(params) && isRecord(event.params)
        ? { ...params, arguments: event.params.arguments }
        : params;
    await this.send({ id: requestId, method: event.method, params: requestParams }).catch(() => {
      this.pendingBackendServerRequests.delete(requestId);
    });
  }
  resolve(message: JsonRpcResponse): null {
    if (message.id === null) {
      return null;
    }

    const pending = this.pendingBackendServerRequests.get(message.id);
    if (!pending) {
      return null;
    }

    this.pendingBackendServerRequests.delete(message.id);
    const backend = this.backendRouter.getBackend(pending.backendType);
    if (!backend) {
      return null;
    }
    const responsePayload =
      "error" in message ? { error: message.error } : { result: message.result };
    const resolveInput: BackendResolveServerRequestInput = {
      threadId: pending.threadId,
      threadHandle: pending.threadHandle,
      requestId: pending.backendRequestId,
      response: responsePayload,
    };
    void backend.resolveServerRequest(resolveInput).catch((error) => {
      this.logger.warn("Failed to resolve backend server request", {
        threadId: pending.threadId,
        backendType: pending.backendType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void this.publish(
      "serverRequest/resolved",
      {
        threadId: pending.threadId,
        requestId: message.id,
      },
      pending.threadId
    );
    return null;
  }

  forgetThread(threadId: string): void {
    for (const [requestId, request] of this.pendingBackendServerRequests) {
      if (request.threadId !== threadId) {
        continue;
      }
      this.pendingBackendServerRequests.delete(requestId);
    }
  }
}
