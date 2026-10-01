import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, parseJsonLine, serializeJsonLine } from "./jsonl.js";

export interface PiProcessResponse<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

interface TransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly requestTimeoutMs: number;
  readonly onEvent: (event: Record<string, unknown>) => void;
  readonly onDisconnect: (error: Error) => void;
  readonly log: (
    kind: "stdin" | "stdout" | "stderr" | "startup",
    raw: string,
    pid?: number
  ) => void;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: PiProcessResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

// Owns the subprocess, RPC correlation, deadlines, writes and shutdown together.
export class PiRpcTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startup: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private failure: Error | null = null;
  private disposed = false;
  private stopReading: (() => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private writes: Promise<void> = Promise.resolve();
  private stderr = "";
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;

  constructor(private readonly options: TransportOptions) {}

  isRunning(): boolean {
    return this.child !== null && !this.failure && !this.disposed;
  }

  getStderr(): string {
    return this.stderr;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Pi session has been disposed"));
    if (this.failure) return Promise.reject(this.failure);
    if (this.startup) return this.startup;
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-65536);
      this.options.log("stderr", chunk.toString());
    });
    child.once("error", (error) => this.fail(error));
    child.stdin.on("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.fail(
        new Error(
          `Pi process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}${this.stderr ? `: ${this.stderr.trim()}` : ""}`
        )
      );
    });
    child.once("close", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.child = null;
      this.stopReading?.();
      this.stopReading = null;
      this.fail(
        new Error(
          `Pi process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}${this.stderr ? `: ${this.stderr.trim()}` : ""}`
        )
      );
    });
    this.stopReading = attachJsonlLineReader(child.stdout, (line) => this.handleLine(line));
    this.options.log("startup", "", child.pid);
    this.startup = this.send({ type: "get_state" }).then(() => {});
    return this.startup;
  }

  async request<T = unknown>(command: Record<string, unknown>): Promise<PiProcessResponse<T>> {
    await this.start();
    return (await this.send(command)) as PiProcessResponse<T>;
  }

  async write(value: unknown): Promise<void> {
    const child = this.child;
    if (!child || this.disposed || this.failure)
      throw this.failure ?? new Error("Pi process is not running");
    const line = serializeJsonLine(value);
    const write = this.writes.then(async () => {
      if (this.disposed || this.failure)
        throw this.failure ?? new Error("Pi session has been disposed");
      this.options.log("stdin", line.trimEnd());
      // The callback waits for buffered writes, rather than flooding stdin.
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
      });
    });
    this.writes = write.catch(() => {});
    return await write;
  }

  dispose(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.disposed = true;
    this.rejectPending(new Error("Pi session has been disposed"));
    this.stopping = this.stop();
    return this.stopping;
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const terminate = setTimeout(() => child.kill("SIGTERM"), 5000);
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 10000);
      child.once("close", () => {
        clearTimeout(terminate);
        clearTimeout(kill);
        resolve();
      });
      // EOF is Pi's native orderly runtime-disposal path. Keep reading stdout.
      child.stdin.end();
    });
  }

  private send(command: Record<string, unknown>): Promise<PiProcessResponse> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // prompt includes extension command/input preflight, which can wait for a
      // human or run an entire /review. Its acceptance is not a machine deadline.
      // Startup, state inspection and other control RPCs remain bounded.
      const timer =
        command.type === "prompt"
          ? null
          : setTimeout(() => {
              const error = new Error(
                `Pi RPC ${String(command.type)} timed out after ${this.options.requestTimeoutMs}ms`
              );
              this.fail(error);
              this.child?.kill("SIGTERM");
            }, this.options.requestTimeoutMs);
      this.pending.set(id, { command: String(command.type), resolve, reject, timer });
      void this.write({ ...command, id }).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private handleLine(line: string): void {
    this.options.log("stdout", line);
    let parsed: unknown;
    try {
      parsed = parseJsonLine(line);
    } catch {
      this.fail(new Error("Pi stdout contained invalid JSONL"));
      this.child?.kill("SIGTERM");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "response") {
      this.options.onEvent(record);
      return;
    }
    const pending = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
    if (!pending || typeof record.id !== "string") return;
    this.pending.delete(record.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (record.command !== pending.command || typeof record.success !== "boolean") {
      pending.reject(new Error("Invalid Pi RPC response"));
    } else if (record.success) {
      pending.resolve({ success: true, data: record.data });
    } else {
      pending.reject(new Error(typeof record.error === "string" ? record.error : "Pi RPC failed"));
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectPending(error);
    if (!this.disposed) this.options.onDisconnect(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
