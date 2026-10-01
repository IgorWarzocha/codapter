import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { JsonRpcId } from "@codapter/core";

export interface CodexBackendOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly transport?: "stdio" | "websocket";
  readonly websocketUrl?: string;
  readonly stderr?: NodeJS.WritableStream | null;
}

export interface CodexRpcEvent {
  readonly method: string;
  readonly params: unknown;
  readonly id?: JsonRpcId;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly reader: Interface;
  readonly closed: Promise<void>;
  readonly pending: Map<JsonRpcId, PendingRequest>;
  ready: boolean;
  disposed: boolean;
  failure: string | null;
  recentStderr: string;
  disposal: Promise<void> | null;
}

const DEFAULT_INITIALIZE_PARAMS = {
  clientInfo: {
    name: "codapter-backend-codex",
    title: "codapter backend codex",
    version: "0.0.1",
  },
  capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
};
const WEBSOCKET_DEFERRED_MESSAGE = "Codex websocket transport is deferred in this implementation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Owns the child and its RPCs. Thread routing belongs to CodexBackend. */
export class CodexRpcTransport {
  private session: RpcSession | null = null;
  private initialization: Promise<void> | null = null;
  private disposalGeneration = 0;
  private requestCounter = 0;
  private initError: string | null = null;
  private readonly options: CodexBackendOptions;

  constructor(
    options: CodexBackendOptions,
    private readonly onEvent: (event: CodexRpcEvent) => void,
    private readonly onDisconnect: (message: string) => void
  ) {
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server"],
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
      transport: options.transport ?? "stdio",
      websocketUrl: options.websocketUrl ?? "",
      stderr: options.stderr ?? null,
    };
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.isAlive()) return Promise.resolve();
    this.initialization = this.start(this.disposalGeneration).finally(() => {
      this.initialization = null;
    });
    return this.initialization;
  }

  private async start(generation: number): Promise<void> {
    if (this.options.transport === "websocket") {
      this.initError = this.options.websocketUrl
        ? `${WEBSOCKET_DEFERRED_MESSAGE}: ${this.options.websocketUrl}`
        : WEBSOCKET_DEFERRED_MESSAGE;
      throw new Error(this.initError);
    }
    // A failed child must be closed before a new lifetime can own the callbacks.
    if (this.session) await this.stop(this.session);
    if (generation !== this.disposalGeneration) throw new Error("Codex backend disposed");
    this.initError = null;
    const child = spawn(
      this.options.command ?? "codex",
      [...(this.options.args ?? ["app-server"])],
      {
        cwd: this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const session: RpcSession = {
      child,
      reader: createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }),
      closed: new Promise((resolve) => child.once("close", () => resolve())),
      pending: new Map(),
      ready: false,
      disposed: false,
      failure: null,
      recentStderr: "",
      disposal: null,
    };
    this.session = session;
    session.reader.on("line", (line) => this.handleLine(session, line));
    child.once("error", (error) => {
      this.fail(session, `Failed to spawn Codex app-server process: ${error.message}`);
    });
    child.stdin.on("error", (error) => {
      this.fail(session, `Codex app-server stdin failed: ${error.message}`);
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      session.recentStderr = `${session.recentStderr}${text}`.slice(-8_000);
      this.options.stderr?.write(text);
    });
    child.once("exit", () => this.fail(session, "Codex app-server process exited"));
    try {
      await this.sendRequest(session, "initialize", DEFAULT_INITIALIZE_PARAMS);
      this.sendRaw(session, { method: "initialized" });
      session.ready = true;
      this.initError = null;
    } catch (error) {
      this.initError = error instanceof Error ? error.message : String(error);
      await this.stop(session);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposalGeneration += 1;
    if (this.session) await this.stop(this.session);
  }

  private stop(session: RpcSession): Promise<void> {
    if (session.disposal) return session.disposal;
    session.disposed = true;
    session.ready = false;
    this.rejectPending(session, "Codex backend disposed");
    session.reader.close();
    session.disposal = this.closeChild(session);
    return session.disposal;
  }

  private async closeChild(session: RpcSession): Promise<void> {
    session.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([
        session.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2_000);
          timer.unref();
        }),
      ]);
      if (!closed) {
        session.child.kill("SIGKILL");
        await session.closed;
      }
    } finally {
      clearTimeout(timer);
      if (this.session === session) this.session = null;
    }
  }

  isAlive(): boolean {
    return this.session?.ready === true && !this.session.disposed && this.session.failure === null;
  }

  private readySession(): RpcSession {
    if (this.options.transport === "websocket") throw new Error(WEBSOCKET_DEFERRED_MESSAGE);
    if (!this.session || !this.isAlive()) {
      throw new Error(this.initError ?? "Codex backend is unavailable");
    }
    return this.session;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    return await this.sendRequest(this.readySession(), method, params);
  }

  respond(id: JsonRpcId, response: unknown): void {
    this.sendRaw(this.readySession(), {
      id,
      ...(isRecord(response) && "error" in response
        ? { error: response.error }
        : { result: (response as { result?: unknown }).result }),
    });
  }

  private sendRequest(session: RpcSession, method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestCounter;
    return new Promise((resolve, reject) => {
      // Register before writing so write failure and process failure own this RPC too.
      session.pending.set(id, { resolve, reject });
      try {
        this.sendRaw(session, { id, method, params });
      } catch (error) {
        session.pending.delete(id);
        reject(error);
      }
    });
  }

  private sendRaw(session: RpcSession, payload: Record<string, unknown>): void {
    if (session.disposed || session.failure) {
      throw new Error(session.failure ?? "Codex backend disposed");
    }
    session.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectPending(session: RpcSession, message: string): void {
    for (const pending of session.pending.values()) pending.reject(new Error(message));
    session.pending.clear();
  }

  private fail(session: RpcSession, message: string): void {
    if (session.failure) return;
    const stderr = session.recentStderr.trim();
    session.failure = stderr ? `${message}; recent stderr: ${stderr}` : message;
    session.ready = false;
    this.rejectPending(session, session.failure);
    if (this.session !== session) return;
    if (!session.disposed && !this.initError) this.initError = session.failure;
    this.onDisconnect(this.initError ?? session.failure);
  }

  private handleLine(session: RpcSession, line: string): void {
    if (this.session !== session || session.disposed || !line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
      const id = parsed.id;
      if (typeof id !== "string" && typeof id !== "number") return;
      const pending = session.pending.get(id);
      if (!pending) return;
      session.pending.delete(id);
      if ("error" in parsed && parsed.error !== undefined) {
        pending.reject(new Error(JSON.stringify(parsed.error)));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    if (typeof parsed.method !== "string") return;
    this.onEvent({
      method: parsed.method,
      params: parsed.params,
      ...(typeof parsed.id === "string" || typeof parsed.id === "number" ? { id: parsed.id } : {}),
    });
  }
}
