import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopSessionCapabilities } from "@codapter/core";
import {
  CHATGPT_APPS_MCP_URL,
  type ChatGptAppsPolicy,
  ChatGptAppsRelay,
  type DesktopMcpCallEvent,
} from "./chatgpt-apps-relay.js";
import { DesktopAuthBridge } from "./desktop-auth.js";
import { BROWSER_POLICY_UNAVAILABLE, readDesktopBrowserPolicy } from "./desktop-browser-policy.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";

export const EMPTY_DESKTOP_CAPABILITIES: DesktopSessionCapabilities = {
  tools: [],
  mcpServers: {},
  instructions: [],
};

export interface DesktopToolCall {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly namespace: string | null;
  readonly tool: string;
  readonly arguments: unknown;
}

export interface DesktopTurnContext {
  readonly threadId: string;
  readonly turnId: string;
}

export interface DesktopTurnEnded extends DesktopTurnContext {
  readonly reason: string;
  readonly hookEventName: "Stop" | "Interrupt";
}

export interface DesktopMcpElicitationRequest extends DesktopTurnContext {
  readonly requestId: string;
  readonly serverName: string;
  readonly request: Readonly<Record<string, unknown>>;
}

type PendingCall =
  | { readonly kind: "tool"; readonly socket: Socket; readonly rpcId: string }
  | {
      readonly kind: "elicitation";
      readonly socket: Socket | null;
      readonly server: string;
      readonly reply: (result?: unknown, error?: unknown) => void;
    };

/** One private endpoint per native process. Socket closure cancels its GUI call. */
export class DesktopBridge {
  private server: Server | null = null;
  private directory: string | null = null;
  private starting: Promise<string> | null = null;
  private disposed = false;
  private readonly sockets = new Set<Socket>();
  private readonly subscribers = new Set<Socket>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly appsRelays = new Map<string, ChatGptAppsRelay>();
  private readonly externalMcpCalls = new Map<
    string,
    { event: DesktopMcpCallEvent; startedAt: number }
  >();
  private readonly auth = new DesktopAuthBridge();
  private turn: DesktopTurnContext | null = null;
  private capabilities: DesktopSessionCapabilities;

  constructor(
    capabilities: DesktopSessionCapabilities | undefined,
    private readonly emit: (call: DesktopToolCall) => void,
    private readonly emitMcpEvent?: (event: DesktopMcpCallEvent) => void,
    private readonly emitDiagnostic?: (message: string) => void,
    private readonly emitElicitation?: (request: DesktopMcpElicitationRequest) => void
  ) {
    this.capabilities = structuredClone(capabilities ?? EMPTY_DESKTOP_CAPABILITIES);
  }

  start(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error("Desktop bridge disposed"));
    this.starting ??= this.listen();
    return this.starting;
  }

  private async listen(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "codapter-desktop-"));
    this.directory = directory;
    await chmod(directory, 0o700);
    if (this.disposed) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Desktop bridge disposed");
    }
    const path = join(directory, "rpc.sock");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (this.disposed) throw new Error("Desktop bridge disposed");
      await chmod(path, 0o600);
      return path;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  refresh(capabilities: DesktopSessionCapabilities): void {
    this.capabilities = structuredClone(capabilities);
    for (const pending of this.pending.values()) {
      if (pending.kind === "elicitation" && !this.enabledServer(pending.server))
        pending.reply(undefined, { code: -32800, message: "Desktop MCP server disabled" });
    }
    try {
      for (const [name, relay] of this.appsRelays) {
        const config = this.capabilities.mcpServers[name];
        if (!isRecord(config) || config._codapter === undefined) {
          void relay.dispose();
          this.appsRelays.delete(name);
        } else relay.updatePolicy(appsPolicy(config));
      }
    } catch (error) {
      for (const relay of this.appsRelays.values()) void relay.dispose();
      this.appsRelays.clear();
      throw error;
    }
  }

  beginTurn(threadId: string, turnId: string): void {
    this.cancelTurn("Desktop turn replaced");
    this.turn = { threadId, turnId };
    this.notify("desktop/turn-started", this.turn);
  }

  cancelTurn(
    message: string,
    hookEventName: DesktopTurnEnded["hookEventName"] = "Interrupt"
  ): void {
    const turn = this.turn;
    this.turn = null;
    if (turn)
      this.notify("desktop/turn-ended", {
        ...turn,
        reason: message,
        hookEventName,
      } satisfies DesktopTurnEnded);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.kind === "tool")
        this.reply(pending.socket, pending.rpcId, undefined, { code: -32800, message });
      else pending.reply(undefined, { code: -32800, message });
    }
    for (const relay of this.appsRelays.values()) relay.cancelTurn(message);
    for (const [callId, pending] of this.externalMcpCalls) {
      this.emitMcpEvent?.({
        ...pending.event,
        phase: "completed",
        error: { code: -32800, message },
        durationMs: Date.now() - pending.startedAt,
      });
      this.externalMcpCalls.delete(callId);
    }
  }

  resolve(requestId: string, response: unknown): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    if (pending.kind === "elicitation") {
      if (isRecord(response) && "error" in response) pending.reply(undefined, response.error);
      else {
        const result = isRecord(response) && "result" in response ? response.result : response;
        if (
          !isRecord(result) ||
          typeof result.action !== "string" ||
          !["accept", "decline", "cancel"].includes(result.action)
        )
          pending.reply(undefined, {
            code: -32602,
            message: "Invalid Desktop MCP elicitation response",
          });
        else pending.reply(result);
      }
      return true;
    }
    // Core preserves JSON-RPC envelopes. Session-oriented callers may pass raw results.
    if (isRecord(response) && "error" in response) {
      this.reply(pending.socket, pending.rpcId, undefined, response.error);
    } else {
      this.reply(
        pending.socket,
        pending.rpcId,
        isRecord(response) && "result" in response ? response.result : response
      );
    }
    return true;
  }

  hasPendingRequest(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  instrumentedMcpServers(proxyEnabled: boolean): readonly string[] {
    const servers = [...this.appsRelays.keys()];
    const nodeRepl = this.capabilities.mcpServers.node_repl;
    if (
      proxyEnabled &&
      isRecord(nodeRepl) &&
      typeof nodeRepl.command === "string" &&
      nodeRepl.enabled !== false
    )
      servers.push("node_repl");
    return servers;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    let received = false;
    const stop = attachJsonlLineReader(socket, (line) => {
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        this.requestError(socket, undefined, new Error("Invalid Desktop JSON-RPC frame"));
        return;
      }
      try {
        if (this.auth.handle(socket, request)) return;
        if (received) {
          socket.destroy();
          return;
        }
        received = true;
        void this.request(socket, request).catch((error: unknown) =>
          this.requestError(socket, request, error)
        );
      } catch (error) {
        this.requestError(socket, request, error);
      }
    });
    socket.once("close", () => {
      stop();
      this.sockets.delete(socket);
      this.subscribers.delete(socket);
      for (const [id, pending] of this.pending) {
        if (pending.socket === socket) {
          if (pending.kind === "tool") this.pending.delete(id);
          else
            pending.reply(undefined, { code: -32800, message: "Desktop elicitation disconnected" });
        }
      }
    });
  }

  private requestError(socket: Socket, request: unknown, error: unknown): void {
    const id = isRecord(request) && typeof request.id === "string" ? request.id : null;
    if (error instanceof Error && "rpcError" in error) {
      this.reply(socket, id, undefined, error.rpcError);
      return;
    }
    this.reply(socket, id, undefined, {
      code: -32602,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async request(socket: Socket, request: unknown): Promise<void> {
    if (!isRecord(request) || request.jsonrpc !== "2.0")
      throw new Error("Invalid Desktop JSON-RPC request");
    if (request.method === "desktop/mcp/event") {
      this.mcpEvent(request.params);
      if (typeof request.id === "string") this.reply(socket, request.id, null);
      else socket.end();
      return;
    }
    if (typeof request.id !== "string") throw new Error("Invalid Desktop JSON-RPC request id");
    if (request.method === "desktop/capabilities") {
      this.reply(socket, request.id, await this.prepareCapabilities());
      return;
    }
    if (request.method === "desktop/context") {
      this.reply(socket, request.id, this.turn);
      return;
    }
    if (request.method === "desktop/browser-policy/read") {
      if (
        request.params !== undefined &&
        (!isRecord(request.params) || Object.keys(request.params).length !== 0)
      )
        throw new Error("Invalid Desktop Browser policy parameters");
      const capabilities = this.capabilities;
      const abort = new AbortController();
      const closed = () => abort.abort();
      socket.once("close", closed);
      if (socket.destroyed) closed();
      try {
        const result = await readDesktopBrowserPolicy(capabilities, () =>
          this.auth.read(false, abort.signal)
        );
        // Never complete a revoked snapshot or a disconnected helper's read.
        if (this.disposed || abort.signal.aborted || capabilities !== this.capabilities)
          throw new Error(BROWSER_POLICY_UNAVAILABLE);
        this.reply(socket, request.id, result);
      } finally {
        socket.off("close", closed);
      }
      return;
    }
    if (request.method === "desktop/subscribe") {
      this.subscribers.add(socket);
      socket.write(serializeJsonLine({ jsonrpc: "2.0", id: request.id, result: this.turn }));
      return;
    }
    if (request.method === "desktop/mcp/elicitation") {
      if (!isRecord(request.params) || typeof request.params.server !== "string")
        throw new Error("Invalid Desktop MCP elicitation request");
      this.reply(
        socket,
        request.id,
        await this.elicit(request.params.server, request.params.request, socket)
      );
      return;
    }
    if (request.method !== "desktop/tool/call") throw new Error("Unknown Desktop method");
    const params = request.params;
    if (
      !isRecord(params) ||
      typeof params.callId !== "string" ||
      typeof params.tool !== "string" ||
      !(params.namespace === null || typeof params.namespace === "string")
    )
      throw new Error("Invalid Desktop tool call");
    if (!this.turn) throw new Error("Desktop tool call has no active GUI turn");
    if (
      !this.capabilities.tools.some(
        (tool) => tool.name === params.tool && tool.namespace === params.namespace
      )
    )
      throw new Error("Desktop tool is no longer available");
    const requestId = `desktop_${randomUUID()}`;
    this.pending.set(requestId, { kind: "tool", socket, rpcId: request.id });
    this.emit({
      requestId,
      ...this.turn,
      callId: params.callId,
      namespace: params.namespace,
      tool: params.tool,
      arguments: params.arguments,
    });
  }

  private enabledServer(server: string): boolean {
    const config = this.capabilities.mcpServers[server];
    return (
      Object.hasOwn(this.capabilities.mcpServers, server) &&
      isRecord(config) &&
      config.enabled !== false
    );
  }

  private elicit(
    server: string,
    request: unknown,
    socket: Socket | null,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.turn || this.disposed)
      throw new Error("Desktop MCP elicitation requires an active GUI turn");
    if (!this.enabledServer(server))
      throw new Error("Desktop MCP elicitation server is disabled or unknown");
    const emit = this.emitElicitation;
    if (!emit) throw new Error("Desktop GUI elicitation is unavailable");
    if (!isRecord(request) || typeof request.message !== "string")
      throw new Error("Invalid Desktop MCP elicitation request");
    // Native Codex requires Guardian for this marker. A GUI acceptance cannot
    // substitute for that review, and Pi has no equivalent evaluator.
    if (isRecord(request._meta) && request._meta.codex_strict_auto_review === true)
      throw new Error("Desktop MCP strict_auto_review requires unsupported Guardian review");
    const mode = request.mode ?? "form";
    if (typeof mode !== "string" || !["form", "openai/form", "openaiForm", "url"].includes(mode))
      throw new Error("Unsupported Desktop MCP elicitation mode");
    if (mode === "url") {
      if (typeof request.url !== "string" || typeof request.elicitationId !== "string")
        throw new Error("Invalid Desktop MCP URL elicitation");
    } else if (!("requestedSchema" in request))
      throw new Error("Missing Desktop MCP elicitation schema");
    const turn = this.turn;
    const requestId = `desktop_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const reply = (result?: unknown, error?: unknown) => {
        if (settled) return;
        settled = true;
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", abort);
        if (error === undefined) resolve(result);
        else
          reject(
            Object.assign(
              new Error(
                isRecord(error) && typeof error.message === "string"
                  ? error.message
                  : "Desktop MCP elicitation failed"
              ),
              { rpcError: error }
            )
          );
      };
      const abort = () =>
        reply(undefined, { code: -32800, message: "Desktop MCP elicitation cancelled" });
      this.pending.set(requestId, { kind: "elicitation", socket, server, reply });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else {
        try {
          emit({
            requestId,
            ...turn,
            serverName: server,
            request: { ...request, mode, _meta: request._meta ?? null },
          });
        } catch (error) {
          reply(undefined, {
            code: -32000,
            message:
              error instanceof Error ? error.message : "Desktop GUI elicitation dispatch failed",
          });
        }
      }
    });
  }

  private async prepareCapabilities(): Promise<DesktopSessionCapabilities> {
    const capabilities = this.capabilities;
    const servers: Record<string, DesktopSessionCapabilities["mcpServers"][string]> = {};
    for (const [name, config] of Object.entries(capabilities.mcpServers)) {
      if (!isRecord(config) || config._codapter === undefined) {
        servers[name] = config;
        continue;
      }
      const policy = appsPolicy(config);
      let relay = this.appsRelays.get(name);
      if (!relay) {
        relay = new ChatGptAppsRelay({
          serverName: name,
          ...policy,
          getContext: () => this.turn,
          ...(this.emitMcpEvent ? { onEvent: this.emitMcpEvent } : {}),
          ...(this.emitDiagnostic ? { onDiagnostic: this.emitDiagnostic } : {}),
          ...(this.emitElicitation
            ? {
                requestElicitation: (request: unknown, signal: AbortSignal) =>
                  this.elicit(name, request, null, signal),
              }
            : {}),
        });
        this.appsRelays.set(name, relay);
      }
      relay.updatePolicy(policy);
      const { _codapter: _marker, ...native } = config;
      servers[name] = { ...native, url: await relay.start() };
    }
    if (this.disposed) throw new Error("Desktop bridge disposed");
    if (capabilities !== this.capabilities) return this.prepareCapabilities();
    return { ...capabilities, mcpServers: servers };
  }

  private mcpEvent(params: unknown): void {
    if (!isRecord(params) || typeof params.callId !== "string")
      throw new Error("Invalid Desktop MCP event");
    if (params.phase === "started") {
      if (!this.turn || typeof params.server !== "string" || typeof params.tool !== "string")
        throw new Error("Desktop MCP call has no active GUI turn");
      if (this.externalMcpCalls.has(params.callId))
        throw new Error("Duplicate Desktop MCP call id");
      const event: DesktopMcpCallEvent = {
        phase: "started",
        ...this.turn,
        callId: params.callId,
        server: params.server,
        tool: params.tool,
        arguments: params.arguments ?? {},
      };
      this.externalMcpCalls.set(params.callId, { event, startedAt: Date.now() });
      this.emitMcpEvent?.(event);
    } else if (params.phase === "completed") {
      const pending = this.externalMcpCalls.get(params.callId);
      if (!pending) throw new Error("Unknown or cancelled Desktop MCP call");
      this.externalMcpCalls.delete(params.callId);
      this.emitMcpEvent?.({
        ...pending.event,
        phase: "completed",
        result: params.result,
        error: params.error,
        durationMs: Date.now() - pending.startedAt,
      });
    } else throw new Error("Invalid Desktop MCP event phase");
  }

  private reply(socket: Socket, id: string | null, result?: unknown, error?: unknown): void {
    if (!socket.destroyed)
      socket.end(
        serializeJsonLine({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) })
      );
  }

  private notify(method: string, params: unknown): void {
    for (const socket of this.subscribers) {
      if (!socket.destroyed) socket.write(serializeJsonLine({ jsonrpc: "2.0", method, params }));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.auth.dispose();
    this.cancelTurn("Desktop bridge disposed");
    await Promise.all([...this.appsRelays.values()].map((relay) => relay.dispose()));
    this.appsRelays.clear();
    for (const socket of this.sockets) socket.end();
    this.sockets.clear();
    this.subscribers.clear();
    if (this.server?.listening) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
    this.server = null;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

function appsPolicy(config: Record<string, unknown>): ChatGptAppsPolicy {
  const marker = config._codapter;
  if (
    config.url !== CHATGPT_APPS_MCP_URL ||
    !isRecord(config.auth) ||
    config.auth.provider !== "openai-codex"
  )
    throw new Error(
      "Desktop apps relay requires the canonical ChatGPT MCP URL and native Pi authentication"
    );
  if (
    !isRecord(marker) ||
    Object.keys(marker).some((key) => !["disabledConnectors", "disabledTools"].includes(key)) ||
    !Array.isArray(marker.disabledConnectors) ||
    !marker.disabledConnectors.every((id) => typeof id === "string" && id.trim())
  )
    throw new Error("Invalid Desktop apps connector policy");
  const disabledTools: Record<string, readonly string[]> = {};
  if (marker.disabledTools !== undefined) {
    if (!isRecord(marker.disabledTools)) throw new Error("Invalid Desktop apps tool policy");
    const ids = new Set<string>();
    for (const [rawId, tools] of Object.entries(marker.disabledTools)) {
      const id = rawId.trim();
      if (
        !id ||
        ids.has(id) ||
        !Array.isArray(tools) ||
        !tools.every((tool) => typeof tool === "string" && tool.trim())
      )
        throw new Error("Invalid Desktop apps tool policy");
      ids.add(id);
      Object.defineProperty(disabledTools, id, { value: [...new Set(tools)], enumerable: true });
    }
  }
  return {
    disabledConnectors: marker.disabledConnectors.map((id: string) => id.trim()),
    disabledTools,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
