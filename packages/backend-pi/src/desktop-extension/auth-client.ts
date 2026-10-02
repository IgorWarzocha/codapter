import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { DesktopAuthStatus, DesktopChatGptAccount } from "../desktop-auth.js";
import { attachJsonlLineReader, serializeJsonLine } from "../jsonl.js";

/** Structural subset of native ModelRegistry.getProviderAuth(). No runtime SDK dependency. */
export interface NativeProviderAuth {
  readonly auth: {
    readonly apiKey?: string;
    readonly headers?: Readonly<Record<string, string | null>>;
  };
}

export type NativeProviderAuthResolver = (
  provider: "openai-codex"
) => Promise<NativeProviderAuth | undefined>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PLAN_TYPES = [
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "promax",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
];

function accountMetadata(token: string): {
  account: DesktopChatGptAccount | null;
  planType: string;
} {
  let payload: Record<string, unknown> = {};
  try {
    const part = token.split(".")[1];
    const decoded: unknown = part
      ? JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
      : null;
    if (record(decoded)) payload = decoded;
  } catch {
    // Missing native token claims cannot establish display metadata or policy-plan support.
  }
  const profile = payload["https://api.openai.com/profile"];
  const email =
    typeof payload.email === "string"
      ? payload.email
      : record(profile) && typeof profile.email === "string"
        ? profile.email
        : null;
  const claims = payload["https://api.openai.com/auth"];
  const claimedPlan =
    record(claims) && typeof claims.chatgpt_plan_type === "string"
      ? claims.chatgpt_plan_type
      : "unknown";
  const planType = PLAN_TYPES.includes(claimedPlan) ? claimedPlan : "unknown";
  return {
    account: email === null ? null : { type: "chatgpt", email, planType },
    planType,
  };
}

/** Resolves on demand through Pi, which owns credential refresh and sign-in. */
export async function resolveDesktopAuth(
  resolve: NativeProviderAuthResolver,
  includeToken: boolean
): Promise<DesktopAuthStatus> {
  const resolution = await resolve("openai-codex");
  let token = resolution?.auth.apiKey;
  if (!token) {
    const authorization = Object.entries(resolution?.auth.headers ?? {}).find(
      ([name]) => name.toLowerCase() === "authorization"
    )?.[1];
    if (typeof authorization === "string") token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  }
  if (!token) return { authMethod: null, authToken: null, account: null, planType: "unknown" };
  return {
    authMethod: "chatgpt",
    authToken: includeToken ? token : null,
    ...accountMetadata(token),
  };
}

/** One bidirectional connection owned by the extension session, with no token snapshot. */
export class DesktopAuthProviderClient {
  private socket: Socket | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private disposed = false;
  private readonly pending = new Set<{ socket: Socket; cancel: () => void }>();

  constructor(
    private readonly path: string,
    private readonly resolve: NativeProviderAuthResolver,
    private readonly requestTimeoutMs = 60_000
  ) {
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > 2_147_483_647
    )
      throw new Error("Invalid native Pi authentication registration timeout");
  }

  start(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Native Pi authentication provider disposed"));
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    const socket = createConnection(this.path);
    this.socket = socket;
    const id = randomUUID();
    const work = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail();
        socket.destroy();
      }, this.requestTimeoutMs);
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Native Pi authentication provider registration failed"));
      };
      const stop = attachJsonlLineReader(socket, (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
          if (!record(message) || message.jsonrpc !== "2.0") throw new Error("Invalid response");
          if (!settled) {
            if (
              message.id !== id ||
              !record(message.result) ||
              message.result.provider !== "openai-codex" ||
              "error" in message
            )
              throw new Error("Invalid registration");
            settled = true;
            clearTimeout(timeout);
            this.ready = true;
            resolve();
            return;
          }
          void this.request(socket, message);
        } catch {
          fail();
          socket.destroy();
        }
      });
      socket.once("connect", () =>
        socket.write(
          serializeJsonLine({
            jsonrpc: "2.0",
            id,
            method: "desktop/auth/provider",
            params: { provider: "openai-codex" },
          })
        )
      );
      socket.once("error", () => {
        fail();
        socket.destroy();
      });
      socket.once("close", () => {
        stop();
        fail();
        for (const pending of this.pending) if (pending.socket === socket) pending.cancel();
        if (this.socket === socket) {
          this.socket = null;
          this.ready = false;
        }
      });
    });
    this.starting = work.finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async request(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (typeof id !== "string") return;
    let response: { result: DesktopAuthStatus } | { error: { code: number; message: string } };
    if (message.method !== "desktop/auth/resolve") {
      response = { error: { code: -32601, message: "Unknown native Pi authentication method" } };
    } else if (!record(message.params) || typeof message.params.includeToken !== "boolean") {
      response = { error: { code: -32602, message: "Invalid native Pi authentication request" } };
    } else {
      try {
        response = { result: await this.read(socket, message.params.includeToken) };
      } catch {
        response = { error: { code: -32000, message: "Native Pi authentication is unavailable" } };
      }
    }
    // Native refresh may finish after process replacement or disposal. Never send it to another session.
    if (!this.disposed && this.socket === socket && !socket.destroyed)
      socket.write(serializeJsonLine({ jsonrpc: "2.0", id, ...response }));
  }

  private read(socket: Socket, includeToken: boolean): Promise<DesktopAuthStatus> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: DesktopAuthStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.pending.delete(pending);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const pending = {
        socket,
        cancel: () => finish(new Error("Native Pi authentication request cancelled")),
      };
      const timeout = setTimeout(pending.cancel, this.requestTimeoutMs);
      this.pending.add(pending);
      // Pi's provider API has no AbortSignal. Bound our route and discard late SDK completion.
      void resolveDesktopAuth(this.resolve, includeToken).then(
        (result) => finish(undefined, result),
        () => finish(new Error("Native Pi authentication is unavailable"))
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    for (const pending of this.pending) pending.cancel();
    this.socket?.destroy();
  }
}
