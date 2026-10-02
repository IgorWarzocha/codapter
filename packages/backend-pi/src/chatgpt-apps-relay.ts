import { randomBytes, randomUUID } from "node:crypto";
import {
  type ClientRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const CHATGPT_APPS_MCP_URL = "https://chatgpt.com/backend-api/ps/mcp";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "chatgpt-account-id",
  "content-type",
  "last-event-id",
  "mcp-session-id",
  "mcp-protocol-version",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "user-agent",
  "x-codex-turn-metadata",
  "x-openai-product-sku",
]);
const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-type",
  "last-event-id",
  "mcp-session-id",
  "mcp-protocol-version",
  "retry-after",
  "www-authenticate",
  "x-request-id",
]);

export interface DesktopMcpCallEvent {
  readonly phase: "started" | "completed";
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly durationMs?: number;
}

interface PendingRequest {
  readonly session: string;
  readonly id: string | number;
  readonly method: "tools/list" | "tools/call";
  readonly generation: number;
  readonly call?: DesktopMcpCallEvent;
  readonly startedAt: number;
}

interface RequestScope {
  readonly id: string;
  readonly session: string;
  readonly method: string | undefined;
  readonly keys: Set<string>;
}

type UpstreamRequest = (
  options: RequestOptions,
  listener: (response: IncomingMessage) => void
) => ClientRequest;
export interface ChatGptAppsPolicy {
  readonly disabledConnectors: readonly string[];
  readonly disabledTools?: Readonly<Record<string, readonly string[]>>;
}

interface RelayOptions extends ChatGptAppsPolicy {
  readonly serverName: string;
  readonly getContext: () => { threadId: string; turnId: string } | null;
  readonly onEvent?: (event: DesktopMcpCallEvent) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly requestElicitation?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly requestUpstream?: UpstreamRequest;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function rpcError(message: string, code = -32000): { code: number; message: string } {
  return { code, message };
}

function requestKey(scope: string, id: string | number): string {
  return JSON.stringify([scope, id]);
}

function boundedName(name: string): string {
  return name.slice(0, 160);
}

function toolDenials(policy: ChatGptAppsPolicy): Map<string, Set<string>> {
  return new Map(
    Object.entries(policy.disabledTools ?? {})
      .filter(([, tools]) => tools.length > 0)
      .map(([id, tools]) => [id, new Set(tools)])
  );
}

/** A fixed-target transport/filter, not an MCP client or an authentication owner. */
export class ChatGptAppsRelay {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private port: number | null = null;
  private route = this.newRoute();
  private disabled: Set<string>;
  private disabledTools: Map<string, Set<string>>;
  private generation = 0;
  private catalogueSession: string | null = null;
  private readonly tools = new Map<string, { allowed: boolean; reason?: string }>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly active = new Map<AbortController, RequestScope>();
  // A GET response has only session/id, not its originating POST scope. Keep
  // revoked IDs until this endpoint is disposed, so late results cannot be reused.
  private readonly revoked = new Set<string>();
  private readonly revokedSessions = new Set<string>();

  constructor(private readonly options: RelayOptions) {
    this.disabled = new Set(options.disabledConnectors);
    this.disabledTools = toolDenials(options);
  }

  private newRoute(): string {
    return `/mcp/${randomBytes(24).toString("base64url")}`;
  }

  async start(): Promise<string> {
    if (this.disposed) throw new Error("ChatGPT apps relay disposed");
    this.starting ??= this.listen();
    await this.starting;
    if (this.disposed || this.port === null) throw new Error("ChatGPT apps relay disposed");
    return `http://127.0.0.1:${this.port}${this.route}`;
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      void this.serve(request, response).catch(() => {
        if (response.destroyed) return;
        if (response.headersSent) response.destroy();
        else this.localError(response, null, "ChatGPT apps MCP relay request failed", 502);
      });
    });
    this.server = server;
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("ChatGPT apps relay did not bind loopback");
    this.port = address.port;
  }

  updatePolicy(policy: ChatGptAppsPolicy): void {
    const next = new Set(policy.disabledConnectors);
    const nextTools = toolDenials(policy);
    if (
      next.size === this.disabled.size &&
      [...next].every((id) => this.disabled.has(id)) &&
      nextTools.size === this.disabledTools.size &&
      [...nextTools].every(([id, tools]) => {
        const old = this.disabledTools.get(id);
        return old?.size === tools.size && [...tools].every((tool) => old.has(tool));
      })
    )
      return;
    this.disabled = next;
    this.disabledTools = nextTools;
    this.invalidateCatalogue();
    // A new URL makes Pi reconnect/reload instead of leaving a revoked schema searchable.
    this.route = this.newRoute();
    for (const controller of this.active.keys()) controller.abort();
    for (const key of this.pending.keys())
      this.complete(key, undefined, rpcError("ChatGPT app policy changed"));
  }

  cancelTurn(message: string): void {
    const keys = new Set<string>();
    const sessions = new Set<string>();
    for (const [key, pending] of this.pending) {
      if (pending.method !== "tools/call") continue;
      keys.add(key);
      sessions.add(pending.session);
      this.complete(key, undefined, rpcError(message, -32800));
    }
    this.abortCallScopes(keys, sessions);
  }

  private abortCallScopes(keys: ReadonlySet<string>, sessions: ReadonlySet<string>): void {
    for (const [controller, scope] of this.active) {
      if (
        [...scope.keys].some((key) => keys.has(key)) ||
        (scope.method === "GET" && sessions.has(scope.session))
      )
        controller.abort();
    }
  }

  private invalidateCatalogue(): void {
    this.generation++;
    this.catalogueSession = null;
    this.tools.clear();
  }

  private prepareRequest(value: unknown, session: string, scope: RequestScope): void {
    if (Array.isArray(value)) {
      for (const entry of value) this.prepareRequest(entry, session, scope);
      return;
    }
    if (!record(value)) throw new Error("Invalid ChatGPT apps MCP JSON-RPC request");
    if (value.method === "initialize") {
      this.invalidateCatalogue();
      for (const [key, pending] of this.pending) {
        if (pending.session === session)
          this.complete(key, undefined, rpcError("ChatGPT apps MCP session reinitialized", -32800));
      }
      for (const [controller, previous] of this.active) {
        if (previous.session === session && previous.id !== scope.id) controller.abort();
      }
    }
    if (
      value.method === "notifications/cancelled" &&
      record(value.params) &&
      rpcId(value.params.requestId)
    ) {
      for (const [key, pending] of this.pending) {
        if (pending.session === session && pending.id === value.params.requestId) {
          this.complete(key, undefined, rpcError("MCP request cancelled", -32800));
          this.abortCallScopes(new Set([key]), new Set([session]));
        }
      }
    }
    if (value.method !== "tools/list" && value.method !== "tools/call") return;
    if (!rpcId(value.id)) throw new Error("ChatGPT apps tools request requires an id");
    const key = requestKey(scope.id, value.id);
    if (this.pending.has(key)) throw new Error("Duplicate ChatGPT apps MCP request id");
    let call: DesktopMcpCallEvent | undefined;
    if (value.method === "tools/list") {
      if (!record(value.params) || value.params.cursor === undefined) this.invalidateCatalogue();
    } else {
      const params = value.params;
      if (!record(params) || typeof params.name !== "string")
        throw new Error("Invalid ChatGPT app tool call");
      const context = this.options.getContext();
      if (!context) throw new Error("ChatGPT app tool call requires an active GUI turn");
      if (this.revoked.has(requestKey(session, value.id)))
        throw new Error("ChatGPT app request id was cancelled; reconnect the MCP session");
      if (params._meta !== undefined && !record(params._meta))
        throw new Error("Invalid ChatGPT app tool metadata");
      call = {
        phase: "started",
        ...context,
        callId: `desktop_mcp_${randomUUID()}`,
        server: this.options.serverName,
        tool: params.name,
        arguments: params.arguments ?? {},
      };
      const meta = record(params._meta) ? params._meta : {};
      params._meta = {
        ...meta,
        callId: call.callId,
        "x-codex-turn-metadata": {
          ...(record(meta["x-codex-turn-metadata"]) ? meta["x-codex-turn-metadata"] : {}),
          session_id: context.threadId,
          thread_id: context.threadId,
          thread_source: "user",
          turn_id: context.turnId,
        },
        codex_apps: {
          ...(record(meta.codex_apps) ? meta.codex_apps : {}),
          call_id: call.callId,
        },
      };
    }
    this.pending.set(key, {
      session,
      id: value.id,
      method: value.method,
      generation: this.generation,
      ...(call ? { call } : {}),
      startedAt: Date.now(),
    });
    scope.keys.add(key);
    if (call) {
      this.options.onEvent?.(call);
      const tool = this.catalogueSession === session ? this.tools.get(call.tool) : undefined;
      if (!tool)
        throw new Error(
          `ChatGPT app tool '${boundedName(call.tool)}' is unknown or stale; refresh tools/list`
        );
      if (!tool.allowed)
        throw new Error(`ChatGPT app tool '${boundedName(call.tool)}' is denied: ${tool.reason}`);
    }
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      this.disposed ||
      request.url !== this.route ||
      request.headers.host !== `127.0.0.1:${this.port}`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (!["GET", "POST", "DELETE"].includes(request.method ?? "")) {
      response.writeHead(405, { allow: "GET, POST, DELETE" }).end();
      return;
    }
    const controller = new AbortController();
    const keys = new Set<string>();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const session =
      typeof request.headers["mcp-session-id"] === "string"
        ? request.headers["mcp-session-id"]
        : "";
    const scope: RequestScope = { id: randomUUID(), session, method: request.method, keys };
    this.active.set(controller, scope);
    let value: unknown;
    let body: Buffer | undefined;
    let accepted = false;
    try {
      if (request.method === "POST") {
        body = await readBody(request);
        try {
          value = JSON.parse(body.toString("utf8"));
          if (
            this.options.requestElicitation &&
            record(value) &&
            value.method === "initialize" &&
            record(value.params)
          ) {
            const capabilities = record(value.params.capabilities) ? value.params.capabilities : {};
            value = {
              ...value,
              params: {
                ...value.params,
                capabilities: { ...capabilities, elicitation: { form: {}, url: {} } },
              },
            };
            body = Buffer.from(JSON.stringify(value));
          }
          this.prepareRequest(value, session, scope);
          body = Buffer.from(JSON.stringify(value));
        } catch (error) {
          const id = record(value) && rpcId(value.id) ? value.id : null;
          const message =
            error instanceof SyntaxError
              ? "Invalid ChatGPT apps MCP JSON-RPC frame"
              : error instanceof Error
                ? error.message
                : "Invalid MCP request";
          for (const key of keys) this.complete(key, undefined, rpcError(message));
          this.localError(response, id, message, 200);
          return;
        }
      }
      const headers: Record<string, string | string[]> = { "accept-encoding": "identity" };
      // Header values flow directly to one fixed TLS target. Never extract credentials or forward cookies.
      for (const [name, header] of Object.entries(request.headers)) {
        if (REQUEST_HEADERS.has(name) && header !== undefined) headers[name] = header;
      }
      if (body) headers["content-length"] = String(body.length);
      const upstream = await this.forward(request.method, headers, body, controller.signal);
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstream.destroy();
        this.localError(
          response,
          record(value) && rpcId(value.id) ? value.id : null,
          "ChatGPT apps MCP redirects are not allowed",
          502
        );
        return;
      }
      for (const [name, header] of Object.entries(upstream.headers)) {
        if (RESPONSE_HEADERS.has(name) && header !== undefined) response.setHeader(name, header);
      }
      response.statusCode = status;
      accepted = status === 202;
      const type = upstream.headers["content-type"] ?? "";
      const stream = decodedStream(upstream);
      const responseScope = request.method === "POST" ? scope : undefined;
      const elicitations = new Map<string | number, Promise<void>>();
      const replyHeaders = {
        ...headers,
        ...(upstream.headers["mcp-session-id"]
          ? { "mcp-session-id": upstream.headers["mcp-session-id"] }
          : {}),
      };
      const filter: (value: unknown) => unknown = (value) => {
        controller.signal.throwIfAborted();
        if (Array.isArray(value))
          return value.flatMap((entry) => {
            const filtered = filter(entry);
            return filtered === undefined ? [] : [filtered];
          });
        if (
          record(value) &&
          value.method === "elicitation/create" &&
          rpcId(value.id) &&
          (this.options.requestElicitation || request.method === "GET")
        ) {
          const owner = this.elicitationOwner(value.params, session, responseScope);
          // A GET can survive an accepted POST. It must not attach an old
          // permission question to whatever GUI turn happens to be current.
          if (owner === undefined) return undefined;
          keys.add(owner);
          if (!this.options.requestElicitation) return value;
          if (!elicitations.has(value.id)) {
            const id = value.id;
            const work = this.replyElicitation(id, value.params, replyHeaders, controller.signal)
              .catch(() => {
                for (const key of keys)
                  this.complete(
                    key,
                    undefined,
                    rpcError(
                      controller.signal.aborted
                        ? "ChatGPT app call cancelled"
                        : "ChatGPT apps MCP elicitation response failed",
                      controller.signal.aborted ? -32800 : -32000
                    )
                  );
                controller.abort();
              })
              .finally(() => elicitations.delete(id));
            elicitations.set(id, work);
          }
          return undefined;
        }
        return this.filterMessage(value, session, responseScope);
      };
      if (type.includes("text/event-stream")) {
        const sse = new SseFrames(filter);
        for await (const chunk of stream) {
          for (const frame of sse.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            await writeChunk(response, frame, controller.signal);
        }
        for (const frame of sse.finish()) await writeChunk(response, frame, controller.signal);
        await Promise.all(elicitations.values());
        controller.signal.throwIfAborted();
        response.end();
      } else if (type.includes("application/json")) {
        const bytes = await readBody(stream);
        const result = bytes.length ? filter(JSON.parse(bytes.toString("utf8"))) : undefined;
        await Promise.all(elicitations.values());
        controller.signal.throwIfAborted();
        response.end(result === undefined ? undefined : JSON.stringify(result));
      } else {
        for await (const chunk of stream) await writeChunk(response, chunk, controller.signal);
        response.end();
      }
      if (request.method === "DELETE") {
        this.invalidateCatalogue();
        this.cancelTurn("ChatGPT apps MCP session closed");
      }
    } finally {
      this.active.delete(controller);
      if (!accepted)
        for (const key of keys)
          this.complete(
            key,
            undefined,
            rpcError(
              controller.signal.aborted
                ? "ChatGPT app call cancelled"
                : "ChatGPT apps MCP response ended without a result",
              controller.signal.aborted ? -32800 : -32000
            )
          );
      controller.abort();
    }
  }

  private forward(
    method: string | undefined,
    headers: Record<string, string | string[]>,
    body: Buffer | undefined,
    signal: AbortSignal
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const outgoing = (this.options.requestUpstream ?? httpsRequest)(
        {
          protocol: "https:",
          hostname: "chatgpt.com",
          port: 443,
          path: "/backend-api/ps/mcp",
          method,
          headers,
          signal,
        },
        resolve
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  }

  private async replyElicitation(
    id: string | number,
    request: unknown,
    headers: Record<string, string | string[]>,
    signal: AbortSignal
  ): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      const result = await this.options.requestElicitation?.(request, signal);
      reply = { jsonrpc: "2.0", id, result };
    } catch (error) {
      reply = {
        jsonrpc: "2.0",
        id,
        error:
          error instanceof Error && "rpcError" in error
            ? error.rpcError
            : rpcError(error instanceof Error ? error.message : "Desktop MCP elicitation failed"),
      };
    }
    signal.throwIfAborted();
    const body = Buffer.from(JSON.stringify(reply));
    const response = await this.forward(
      "POST",
      {
        ...headers,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
      signal
    );
    const status = response.statusCode ?? 502;
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`ChatGPT apps MCP elicitation response failed with HTTP ${status}`);
    }
    await readBody(decodedStream(response));
  }

  private elicitationOwner(
    request: unknown,
    session: string,
    scope?: RequestScope
  ): string | undefined {
    const meta = record(request) && record(request._meta) ? request._meta : {};
    const apps = record(meta.codex_apps) ? meta.codex_apps : {};
    const callId = apps.call_id ?? meta.callId;
    if (callId !== undefined && typeof callId !== "string") return undefined;
    if (apps.call_id !== undefined && meta.callId !== undefined && apps.call_id !== meta.callId)
      return undefined;
    // After cancellation, anonymous GET questions cannot distinguish an old
    // invocation from a new one. Require its canonical call identity then.
    if (!scope && callId === undefined && this.revokedSessions.has(session)) return undefined;
    const matches = [...this.pending].filter(
      ([key, pending]) =>
        pending.session === session &&
        pending.call &&
        (!scope || scope.keys.has(key)) &&
        (callId === undefined || pending.call.callId === callId)
    );
    const owner = matches[0];
    if (matches.length !== 1 || !owner) return undefined;
    const [key, pending] = owner;
    const context = this.options.getContext();
    return context &&
      pending.call?.threadId === context.threadId &&
      pending.call.turnId === context.turnId
      ? key
      : undefined;
  }

  private filterMessage(value: unknown, session: string, scope?: RequestScope): unknown {
    if (Array.isArray(value))
      return value.map((entry) => this.filterMessage(entry, session, scope));
    if (!record(value)) return value;
    if (value.method === "notifications/tools/list_changed") this.invalidateCatalogue();
    if (!rpcId(value.id) || !("result" in value || "error" in value)) return value;
    const matches = scope
      ? []
      : [...this.pending].filter(
          ([, pending]) => pending.session === session && pending.id === value.id
        );
    if (matches.length > 1) {
      const error = rpcError("Ambiguous ChatGPT apps MCP response id; reconnect the session");
      for (const [key] of matches) this.complete(key, undefined, error);
      return { jsonrpc: "2.0", id: value.id, error };
    }
    const key = scope ? requestKey(scope.id, value.id) : matches[0]?.[0];
    if (key === undefined)
      return this.revoked.has(requestKey(session, value.id)) ? undefined : value;
    const pending = this.pending.get(key);
    if (!pending)
      return scope?.keys.has(key)
        ? {
            jsonrpc: "2.0",
            id: value.id,
            error: rpcError("ChatGPT apps MCP request is no longer active"),
          }
        : value;
    if (pending.method === "tools/call") {
      this.complete(key, value.result, value.error);
      return value;
    }
    this.pending.delete(key);
    if ("error" in value) return value;
    if (pending.generation !== this.generation)
      return {
        jsonrpc: "2.0",
        id: value.id,
        error: rpcError("ChatGPT app catalogue changed; refresh tools/list"),
      };
    const result = value.result;
    if (!record(result) || !Array.isArray(result.tools))
      return {
        jsonrpc: "2.0",
        id: value.id,
        error: rpcError("Invalid ChatGPT apps tool catalogue"),
      };
    const filtered: unknown[] = [];
    let missingMetadata = 0;
    for (const tool of result.tools) {
      if (!record(tool) || typeof tool.name !== "string") continue;
      const id =
        record(tool._meta) && typeof tool._meta.connector_id === "string"
          ? tool._meta.connector_id.trim()
          : "";
      const missing = (this.disabled.size > 0 || this.disabledTools.size > 0) && !id;
      const denied = id !== "" && this.disabled.has(id);
      const deniedTools = this.disabledTools.get(id);
      // Codex AppToolPolicyEvaluator checks the original name, then exact tool.title.
      // Policy keys and titles are literals, not namespaces or wildcard expressions.
      const toolDenied =
        deniedTools?.has(tool.name) ||
        (typeof tool.title === "string" && deniedTools?.has(tool.title));
      this.tools.set(tool.name, {
        allowed: !missing && !denied && !toolDenied,
        ...(missing
          ? { reason: "missing _meta.connector_id metadata required by Desktop connector policy" }
          : denied
            ? { reason: "connector is disabled in Desktop" }
            : toolDenied
              ? { reason: "tool is disabled in Desktop" }
              : {}),
      });
      if (missing) missingMetadata++;
      if (!missing && !denied && !toolDenied) filtered.push(tool);
    }
    this.catalogueSession = session;
    if (missingMetadata)
      this.options.onDiagnostic?.(
        `ChatGPT apps MCP omitted ${missingMetadata} tools without _meta.connector_id required by Desktop connector policy`
      );
    return { ...value, result: { ...result, tools: filtered } };
  }

  private complete(key: string, result?: unknown, error?: unknown): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (pending.call && record(error) && error.code === -32800) {
      this.revoked.add(requestKey(pending.session, pending.id));
      this.revokedSessions.add(pending.session);
    }
    if (pending.call)
      this.options.onEvent?.({
        ...pending.call,
        phase: "completed",
        result,
        error,
        durationMs: Date.now() - pending.startedAt,
      });
  }

  private localError(
    response: ServerResponse,
    id: string | number | null,
    message: string,
    status: number
  ): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, error: rpcError(message) }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active.keys()) controller.abort();
    for (const key of this.pending.keys())
      this.complete(key, undefined, rpcError("ChatGPT apps relay disposed", -32800));
    // listen() may not have bound yet. Keep its server owned until startup settles.
    // start() reports startup errors; disposal still closes any allocated resource.
    await this.starting?.catch(() => {});
    const server = this.server;
    if (server?.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    this.server = null;
  }
}

async function readBody(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("ChatGPT apps MCP body exceeds 64 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodedStream(response: IncomingMessage): Readable {
  const encoding = response.headers["content-encoding"];
  if (!encoding || encoding === "identity") return response;
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "br"
        ? createBrotliDecompress()
        : encoding === "deflate"
          ? createInflate()
          : null;
  if (!decoder) {
    response.destroy();
    throw new Error("Unsupported ChatGPT apps MCP content encoding");
  }
  response.once("error", (error) => decoder.destroy(error));
  return response.pipe(decoder);
}

async function writeChunk(
  response: ServerResponse,
  chunk: string | Uint8Array,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("ChatGPT apps MCP client disconnected"));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    response.once("drain", drained);
    response.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Transforms only JSON-RPC data, retaining SSE ids, event names, progress and elicitations. */
class SseFrames {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(private readonly filter: (value: unknown) => unknown) {}

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer) > MAX_BODY_BYTES)
      throw new Error("ChatGPT apps MCP SSE event exceeds 64 MiB");
    const frames: string[] = [];
    while (true) {
      const match = /\r?\n\r?\n|\r\r/.exec(this.buffer);
      if (!match) return frames;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      frames.push(`${this.frame(frame)}${match[0]}`);
    }
  }

  finish(): string[] {
    this.buffer += this.decoder.end();
    if (!this.buffer) return [];
    // Native Pi dispatches EOF data without a blank line, so filter that final event too.
    const tail = this.frame(this.buffer);
    this.buffer = "";
    return [tail];
  }

  private frame(frame: string): string {
    const lines = frame.split(/\r\n|\r|\n/);
    const data = lines.filter((line) => line === "data" || line.startsWith("data:"));
    if (!data.length) return frame;
    const input = data.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    let value: unknown;
    try {
      value = JSON.parse(input);
    } catch {
      return frame;
    }
    const output = this.filter(value);
    if (output === undefined)
      return lines.filter((line) => line !== "data" && !line.startsWith("data:")).join("\n");
    if (JSON.stringify(output) === JSON.stringify(value)) return frame;
    let written = false;
    return lines
      .flatMap((line) => {
        if (line !== "data" && !line.startsWith("data:")) return [line];
        if (written) return [];
        written = true;
        return [`data: ${JSON.stringify(output)}`];
      })
      .join("\n");
  }
}
