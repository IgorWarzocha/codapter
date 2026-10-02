import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { serializeJsonLine } from "./jsonl.js";

export interface DesktopChatGptAccount {
  readonly type: "chatgpt";
  readonly email: string;
  readonly planType: string;
}

export interface DesktopAuthStatus {
  readonly authMethod: "chatgpt" | null;
  readonly authToken: string | null;
  readonly account: DesktopChatGptAccount | null;
  /** Native plan claim is independent of optional account display metadata. */
  readonly planType: string;
}

interface PendingAuth {
  readonly provider: Socket;
  readonly finish: (error?: Error, result?: DesktopAuthStatus) => void;
  readonly includeToken: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDesktopAuthStatus(value: unknown, includeToken: boolean): DesktopAuthStatus {
  if (
    !record(value) ||
    !(value.authMethod === null || value.authMethod === "chatgpt") ||
    !(value.authToken === null || typeof value.authToken === "string") ||
    (value.planType !== undefined && typeof value.planType !== "string") ||
    !(
      value.account === null ||
      (record(value.account) &&
        value.account.type === "chatgpt" &&
        typeof value.account.email === "string" &&
        typeof value.account.planType === "string")
    )
  )
    throw new Error("Invalid native Pi authentication response");
  if (value.authMethod === null)
    return { authMethod: null, authToken: null, account: null, planType: "unknown" };
  const account =
    record(value.account) &&
    typeof value.account.email === "string" &&
    typeof value.account.planType === "string"
      ? {
          type: "chatgpt" as const,
          email: value.account.email,
          planType: value.account.planType,
        }
      : null;
  return {
    authMethod: "chatgpt",
    authToken: includeToken && typeof value.authToken === "string" ? value.authToken : null,
    account,
    planType: typeof value.planType === "string" ? value.planType : "unknown",
  };
}

/** Owns the connected native provider, never a cached credential or credential file. */
export class DesktopAuthBridge {
  private provider: Socket | null = null;
  private providerClosed: (() => void) | null = null;
  private readonly pending = new Map<string, PendingAuth>();
  private disposed = false;

  constructor(private readonly requestTimeoutMs = 60_000) {
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > 2_147_483_647
    )
      throw new Error("Invalid native Pi authentication request timeout");
  }

  /** Call for every frame, including responses, before the ordinary Desktop dispatcher. */
  handle(socket: Socket, message: unknown): boolean {
    if (!record(message) || message.jsonrpc !== "2.0") return false;
    if (message.method === "desktop/auth/provider") {
      if (
        this.disposed ||
        typeof message.id !== "string" ||
        !record(message.params) ||
        message.params.provider !== "openai-codex"
      ) {
        this.reply(
          socket,
          typeof message.id === "string" ? message.id : null,
          undefined,
          -32602,
          "Invalid native Pi authentication provider registration"
        );
      } else {
        if (this.provider !== socket) {
          this.detachProvider();
          this.provider = socket;
          this.providerClosed = () => this.detachProvider();
          socket.once("close", this.providerClosed);
        }
        this.reply(socket, message.id, { provider: "openai-codex" });
      }
      return true;
    }
    if (message.method === "desktop/auth/read") {
      if (
        typeof message.id !== "string" ||
        (message.params !== undefined &&
          (!record(message.params) ||
            (message.params.includeToken !== undefined &&
              typeof message.params.includeToken !== "boolean")))
      ) {
        this.reply(
          socket,
          typeof message.id === "string" ? message.id : null,
          undefined,
          -32602,
          "Invalid native Pi authentication request"
        );
        return true;
      }
      const includeToken = record(message.params) && message.params.includeToken === true;
      const id = message.id;
      const abort = new AbortController();
      const closed = () => abort.abort();
      socket.once("close", closed);
      void this.read(includeToken, abort.signal)
        .then(
          (result) => this.reply(socket, id, result),
          () => this.reply(socket, id, undefined, -32000, "Native Pi authentication is unavailable")
        )
        .finally(() => socket.off("close", closed));
      return true;
    }
    if (socket !== this.provider || "method" in message || typeof message.id !== "string")
      return false;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    try {
      if (!("result" in message) || "error" in message)
        throw new Error("Native Pi authentication failed");
      pending.finish(undefined, parseDesktopAuthStatus(message.result, pending.includeToken));
    } catch {
      pending.finish(new Error("Native Pi authentication failed"));
    }
    return true;
  }

  read(includeToken = false, signal?: AbortSignal): Promise<DesktopAuthStatus> {
    const provider = this.provider;
    if (this.disposed || !provider || provider.destroyed)
      return Promise.reject(new Error("Native Pi authentication provider is disconnected"));
    if (signal?.aborted)
      return Promise.reject(new Error("Native Pi authentication request cancelled"));
    return new Promise((resolve, reject) => {
      const id = `auth_${randomUUID()}`;
      const finish = (error?: Error, result?: DesktopAuthStatus) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error("Native Pi authentication failed"));
      };
      const aborted = () => finish(new Error("Native Pi authentication request cancelled"));
      const timeout = setTimeout(
        () => finish(new Error("Native Pi authentication request timed out")),
        this.requestTimeoutMs
      );
      this.pending.set(id, { provider, finish, includeToken });
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        provider.write(
          serializeJsonLine({
            jsonrpc: "2.0",
            id,
            method: "desktop/auth/resolve",
            params: { includeToken },
          })
        );
      } catch {
        finish(new Error("Native Pi authentication provider is disconnected"));
      }
    });
  }

  private detachProvider(): void {
    const provider = this.provider;
    if (provider && this.providerClosed) provider.off("close", this.providerClosed);
    this.provider = null;
    this.providerClosed = null;
    for (const pending of this.pending.values())
      if (pending.provider === provider)
        pending.finish(new Error("Native Pi authentication provider disconnected"));
    provider?.destroy();
  }

  private reply(
    socket: Socket,
    id: string | null,
    result?: unknown,
    code?: number,
    message?: string
  ): void {
    if (socket.destroyed) return;
    socket.write(
      serializeJsonLine({
        jsonrpc: "2.0",
        id,
        ...(code === undefined ? { result } : { error: { code, message } }),
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    this.detachProvider();
  }
}
