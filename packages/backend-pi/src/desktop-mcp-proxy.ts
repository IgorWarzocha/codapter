#!/usr/bin/env node
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DesktopTurnContext, type DesktopTurnEnded, isRecord } from "./desktop-bridge.js";
import { desktopRequest } from "./desktop-extension/client.js";
import { runDesktopHostServices } from "./desktop-host-services.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";

type RpcId = string | number;
interface PendingCall extends DesktopTurnContext {
  readonly callId: string;
  ended: boolean;
}
interface ProxyConfig {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly hostLauncher?: string;
}

// Match native Codex's stdio MCP environment boundary, not Pi's ambient credentials.
const DEFAULT_ENV = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "__CF_USER_TEXT_ENCODING",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
];
const CERT_ENV = [
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "CARGO_HTTP_CAINFO",
  "PIP_CERT",
  "BUNDLE_SSL_CA_CERT",
  "npm_config_cafile",
  "NPM_CONFIG_CAFILE",
];
const PRIVATE_ENV = new Set([
  "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
  "NODE_REPL_AUTH_TOKEN",
  "CODEX_GUARDIAN_DECISIONS_API_KEY",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
]);

function proxyConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(env.CODAPTER_DESKTOP_MCP_CONFIG ?? "", "base64").toString("utf8")
    );
  } catch {
    throw new Error("Invalid Desktop MCP proxy configuration");
  }
  if (
    !isRecord(value) ||
    typeof value.command !== "string" ||
    !value.command.trim() ||
    (value.args !== undefined &&
      (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) ||
    (value.cwd !== undefined && typeof value.cwd !== "string") ||
    (value.env !== undefined &&
      (!isRecord(value.env) || !Object.values(value.env).every((item) => typeof item === "string")))
  )
    throw new Error("Invalid Desktop MCP proxy configuration");
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_ENV) if (env[key] !== undefined) childEnv[key] = env[key];
  for (const key of CERT_ENV) if (env[key]) childEnv[key] = resolve(env[key]);
  // Pi resolves these configured literal values before launching us. Do not interpolate again.
  for (const key of Object.keys(value.env ?? {})) {
    if (env[key] === undefined) throw new Error("Missing resolved Desktop MCP environment value");
    childEnv[key] = env[key];
  }
  for (const key of Object.keys(childEnv))
    if (PRIVATE_ENV.has(key.toUpperCase()) || key.startsWith("CODAPTER_DESKTOP_"))
      delete childEnv[key];
  let hostLauncher: string | undefined;
  if (basename(value.command) === "node_repl" || childEnv.CODEX_CLI_PATH) {
    // Packaged node_repl uses this CLI for authentication and its JS sandbox. Own
    // the auth RPC even without an explicit override, so its native fallback cannot
    // start a Codex app-server. Retain the shipped sandbox binary and policy verbatim.
    const nativeSandbox = resolve(dirname(value.command), "../../codex");
    const proxy = fileURLToPath(import.meta.url);
    try {
      if (!isAbsolute(value.command)) throw new Error();
      accessSync(nativeSandbox, constants.X_OK);
      accessSync(proxy, constants.R_OK);
    } catch {
      throw new Error("Desktop browser requires the packaged sandbox and proxy bundle");
    }
    // NodeRepl clears ambient variables for sandbox launches. Bind the two local
    // endpoints in our private launcher, not OAuth credentials or inherited env.
    hostLauncher = resolve(dirname(env.CODAPTER_DESKTOP_UDS ?? ""), `host-${randomUUID()}.mjs`);
    writeFileSync(
      hostLauncher,
      [
        "#!/usr/bin/env node",
        `import { runDesktopHostCommand } from ${JSON.stringify(import.meta.url)};`,
        `runDesktopHostCommand(process.argv.slice(2), ${JSON.stringify({ path: env.CODAPTER_DESKTOP_UDS, sandbox: nativeSandbox })}).catch(() => { process.stderr.write("Desktop host service failed\\n"); process.exitCode = 1; });`,
        "",
      ].join("\n"),
      { mode: 0o700, flag: "wx" }
    );
    childEnv.CODEX_CLI_PATH = hostLauncher;
  }
  return {
    command: value.command,
    args: (value.args ?? []) as string[],
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    env: childEnv,
    ...(hostLauncher ? { hostLauncher } : {}),
  };
}

function context(value: unknown): DesktopTurnContext | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.threadId !== "string" || typeof value.turnId !== "string")
    throw new Error("Invalid Desktop turn context");
  return { threadId: value.threadId, turnId: value.turnId };
}

/** Native node_repl stays the browser host. This process adds GUI scope and lifecycle hooks. */
class DesktopMcpProxy {
  private child: ChildProcessWithoutNullStreams | null = null;
  private subscription: Socket | null = null;
  private turn: DesktopTurnContext | null = null;
  private readonly calls = new Map<RpcId, PendingCall>();
  private readonly hooks = new Map<string, { finish(error?: Error): void; done: Promise<void> }>();
  private readonly hookPrefix = `codapter_hook_${randomUUID()}_`;
  private readonly work = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private closing = false;
  private stopInput: (() => void) | undefined;
  private stopOutput: (() => void) | undefined;
  private stopSubscription: (() => void) | undefined;
  private finish: (error?: Error) => void = () => {};

  constructor(
    private readonly path: string,
    private readonly config: ProxyConfig
  ) {}

  async run(): Promise<void> {
    const finished = new Promise<void>((resolveDone, reject) => {
      this.finish = (error) => {
        this.closing = true;
        if (error) reject(error);
        else resolveDone();
      };
    });
    // An early child/subscription error can arrive before startup has finished.
    void finished.catch(() => {});
    const stop = () => this.finish();
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdin.once("end", stop);
    process.stdin.once("error", this.finish);
    process.stdout.once("error", this.finish);
    try {
      await Promise.race([this.subscribe(), finished]);
      if (this.closing) return;
      const child = spawn(this.config.command, this.config.args, {
        env: this.config.env,
        ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      child.once("error", this.finish);
      child.stdin.on("error", this.finish);
      child.stderr.pipe(process.stderr, { end: false });
      child.once("exit", (code, signal) => {
        for (const hook of this.hooks.values()) hook.finish(new Error("Desktop MCP host exited"));
        this.finish(
          this.closing ? undefined : new Error(`Desktop MCP host exited (${code ?? signal})`)
        );
      });
      this.stopOutput = attachJsonlLineReader(child.stdout, (line) =>
        this.track(this.fromHost(line))
      );
      // Queue only preparation/writes. Never await an MCP reply before forwarding cancellation.
      let input = Promise.resolve();
      this.stopInput = attachJsonlLineReader(process.stdin, (line) => {
        input = input.then(() => this.toHost(line));
        this.track(input);
      });
      await finished;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      process.stdin.off("end", stop);
      process.stdin.off("error", this.finish);
      process.stdout.off("error", this.finish);
      await this.close();
    }
  }

  private track(work: Promise<void>): void {
    this.work.add(work);
    void work.then(
      () => this.work.delete(work),
      (error: unknown) => {
        this.work.delete(work);
        this.finish(error instanceof Error ? error : new Error(String(error)));
      }
    );
  }

  private subscribe(): Promise<void> {
    return new Promise((resolveReady, reject) => {
      const socket = createConnection(this.path);
      this.subscription = socket;
      let ready = false;
      const fail = (error: Error) => {
        reject(error);
        this.finish(error);
      };
      socket.once("error", fail);
      socket.once("close", () => {
        if (!this.closing) fail(new Error("Desktop bridge disconnected"));
      });
      this.stopSubscription = attachJsonlLineReader(socket, (line) => {
        try {
          const message: unknown = JSON.parse(line);
          if (!isRecord(message)) throw new Error("Invalid Desktop subscription message");
          if (!ready) {
            if (message.id !== "subscribe" || !("result" in message))
              throw new Error("Desktop subscription failed");
            this.turn = context(message.result);
            ready = true;
            resolveReady();
          } else if (message.method === "desktop/turn-started") {
            this.turn = context(message.params);
          } else if (message.method === "desktop/turn-ended") {
            const ended = context(message.params);
            if (
              !ended ||
              !isRecord(message.params) ||
              !["Stop", "Interrupt"].includes(String(message.params.hookEventName))
            )
              throw new Error("Invalid Desktop turn end");
            this.endTurn({
              ...ended,
              hookEventName: message.params.hookEventName as DesktopTurnEnded["hookEventName"],
              reason: "Turn ended",
            });
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("connect", () =>
        socket.write(
          serializeJsonLine({ jsonrpc: "2.0", id: "subscribe", method: "desktop/subscribe" })
        )
      );
    });
  }

  private async toHost(line: string): Promise<void> {
    if (this.closing) return;
    const message: unknown = JSON.parse(line);
    if (!isRecord(message)) throw new Error("Invalid MCP client message");
    if (message.method === "initialize" && isRecord(message.params)) {
      message.params = {
        ...message.params,
        capabilities: {
          ...(isRecord(message.params.capabilities) ? message.params.capabilities : {}),
          elicitation: { form: {}, url: {} },
        },
      };
    }
    if (message.method === "tools/call") {
      const id = message.id;
      if (typeof id !== "string" && typeof id !== "number")
        throw new Error("MCP call requires a request id");
      const params = message.params;
      const turn = this.turn;
      if (!turn || !isRecord(params) || typeof params.name !== "string") {
        this.reply(id, "Desktop MCP call requires an active GUI turn");
        return;
      }
      if (this.calls.has(id)) throw new Error("Duplicate MCP call id");
      const callId = `desktop_mcp_${randomUUID()}`;
      const pending: PendingCall = { ...turn, callId, ended: false };
      this.calls.set(id, pending);
      try {
        await desktopRequest(
          this.path,
          "desktop/mcp/event",
          {
            phase: "started",
            callId,
            server: "node_repl",
            tool: params.name,
            arguments: params.arguments ?? {},
          },
          this.abort.signal
        );
      } catch (error) {
        this.calls.delete(id);
        this.reply(id, error instanceof Error ? error.message : "Desktop MCP call rejected");
        return;
      }
      if (pending.ended || this.closing) {
        this.calls.delete(id);
        this.reply(id, "Desktop turn ended");
        return;
      }
      message.params = {
        ...params,
        _meta: {
          ...(isRecord(params._meta) ? params._meta : {}),
          threadId: turn.threadId,
          "x-codex-turn-metadata": {
            session_id: turn.threadId,
            thread_id: turn.threadId,
            thread_source: "user",
            turn_id: turn.turnId,
          },
        },
      };
    }
    this.child?.stdin.write(serializeJsonLine(message));
  }

  private async fromHost(line: string): Promise<void> {
    const message: unknown = JSON.parse(line);
    if (!isRecord(message)) throw new Error("Invalid MCP host message");
    if (
      message.method === "elicitation/create" &&
      (typeof message.id === "string" || typeof message.id === "number")
    ) {
      // Pi's MCP client does not handle elicitation. The actual GUI owns the decision.
      let response: { result: unknown } | { error: unknown };
      try {
        response = {
          result: await desktopRequest(
            this.path,
            "desktop/mcp/elicitation",
            { server: "node_repl", request: message.params },
            this.abort.signal
          ),
        };
      } catch (error) {
        response = {
          error:
            error instanceof Error && "rpcError" in error
              ? error.rpcError
              : { code: -32000, message: "Desktop MCP permission request failed" },
        };
      }
      if (!this.closing)
        this.child?.stdin.write(serializeJsonLine({ jsonrpc: "2.0", id: message.id, ...response }));
      return;
    }
    if (
      typeof message.id === "string" &&
      message.id.startsWith(this.hookPrefix) &&
      !message.method
    ) {
      const hook = this.hooks.get(message.id);
      if (hook) {
        hook.finish(
          message.error || (isRecord(message.result) && message.result.isError)
            ? new Error("Desktop browser cleanup hook failed")
            : undefined
        );
      }
      return;
    }
    if ((typeof message.id === "string" || typeof message.id === "number") && !message.method) {
      const call = this.calls.get(message.id);
      if (call) {
        this.calls.delete(message.id);
        if (!call.ended) {
          try {
            await desktopRequest(
              this.path,
              "desktop/mcp/event",
              {
                phase: "completed",
                callId: call.callId,
                result: message.result,
                error: message.error,
              },
              this.abort.signal
            );
          } catch (error) {
            if (!call.ended && !this.closing && this.turn?.turnId === call.turnId) throw error;
          }
        }
      }
    }
    if (!this.closing) process.stdout.write(serializeJsonLine(message));
  }

  private reply(id: RpcId, message: string): void {
    if (!this.closing)
      process.stdout.write(
        serializeJsonLine({ jsonrpc: "2.0", id, error: { code: -32000, message } })
      );
  }

  private endTurn(turn: DesktopTurnEnded): void {
    if (this.turn?.turnId === turn.turnId) this.turn = null;
    for (const call of this.calls.values()) if (call.turnId === turn.turnId) call.ended = true;
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const id = `${this.hookPrefix}${randomUUID()}`;
    let done: () => void = () => {};
    const promise = new Promise<void>((resolveDone) => {
      done = resolveDone;
    });
    const finish = (error?: Error) => {
      if (!this.hooks.delete(id)) return;
      clearTimeout(timer);
      if (error) process.stderr.write(`[codapter] ${error.message}\n`);
      done();
    };
    const timer = setTimeout(
      () => finish(new Error("Desktop browser cleanup hook timed out")),
      3000
    );
    this.hooks.set(id, { finish, done: promise });
    this.child.stdin.write(
      serializeJsonLine({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "turn_ended",
          arguments: {
            hook_event_name: turn.hookEventName,
            session_id: turn.threadId,
            turn_id: turn.turnId,
          },
          _meta: { threadId: turn.threadId },
        },
      })
    );
  }

  private async close(): Promise<void> {
    this.closing = true;
    this.stopInput?.();
    process.stdin.pause();
    await Promise.all(
      [...this.calls.values()]
        .filter((call) => !call.ended)
        .map(async (call) => {
          try {
            await desktopRequest(
              this.path,
              "desktop/mcp/event",
              {
                phase: "completed",
                callId: call.callId,
                error: { code: -32000, message: "Desktop MCP host disconnected" },
              },
              AbortSignal.timeout(3000)
            );
          } catch {
            // Bridge turn cancellation/disposal already completes accepted calls.
          }
        })
    );
    this.abort.abort(new Error("Desktop MCP proxy closed"));
    if (this.turn)
      this.endTurn({ ...this.turn, hookEventName: "Interrupt", reason: "Proxy closed" });
    this.stopSubscription?.();
    this.subscription?.destroy();
    await Promise.all([...this.hooks.values()].map((hook) => hook.done));
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveDone) => {
        const terminate = setTimeout(() => child.kill("SIGTERM"), 500);
        const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
        child.once("close", () => {
          clearTimeout(terminate);
          clearTimeout(kill);
          resolveDone();
        });
        child.stdin.end();
      });
    }
    this.stopOutput?.();
    await Promise.allSettled(this.work);
    if (this.config.hostLauncher) rmSync(this.config.hostLauncher, { force: true });
  }
}

export async function runDesktopMcpProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = env.CODAPTER_DESKTOP_UDS;
  if (!path) throw new Error("Desktop MCP proxy requires a private bridge endpoint");
  await new DesktopMcpProxy(path, proxyConfig(env)).run();
}

export async function runDesktopHostCommand(
  argv: readonly string[],
  options: { path: string | undefined; sandbox: string | undefined }
): Promise<void> {
  const [command, ...args] = argv;
  if (!options.path) throw new Error("Desktop host services require a private bridge endpoint");
  if (command === "app-server") {
    if (
      args.length !== 0 &&
      !(args.length === 2 && args[0] === "--listen" && args[1] === "stdio://")
    )
      throw new Error("Desktop host services only support stdio");
    return runDesktopHostServices({ path: options.path });
  }
  if (command !== "sandbox") throw new Error("Unsupported Desktop host command");
  const sandbox = options.sandbox;
  if (!sandbox || !isAbsolute(sandbox) || sandbox === fileURLToPath(import.meta.url))
    throw new Error("Desktop native sandbox is unavailable");
  const child = spawn(sandbox, ["sandbox", ...args], { stdio: "inherit" });
  let kill: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    child.kill(signal);
    kill ??= setTimeout(() => child.kill("SIGKILL"), 1500);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await new Promise<void>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
        resolveDone();
      });
    });
  } finally {
    clearTimeout(kill);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work =
    process.argv.length > 2
      ? runDesktopHostCommand(process.argv.slice(2), {
          path: process.env.CODAPTER_DESKTOP_UDS,
          sandbox: process.env.CODAPTER_DESKTOP_SANDBOX_COMMAND,
        })
      : runDesktopMcpProxy();
  work.catch((error: unknown) => {
    process.stderr.write(
      `[codapter] ${error instanceof Error ? error.message : "Desktop MCP proxy failed"}\n`
    );
    process.exitCode = 1;
  });
}
