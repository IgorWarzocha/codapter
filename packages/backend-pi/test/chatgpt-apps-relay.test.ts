import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  Server,
  type ServerResponse,
} from "node:http";
import type { RequestOptions } from "node:https";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_APPS_MCP_URL,
  type ChatGptAppsPolicy,
  ChatGptAppsRelay,
  type DesktopMcpCallEvent,
} from "../src/chatgpt-apps-relay.js";
import { DesktopBridge } from "../src/desktop-bridge.js";
import { desktopRequest } from "../src/desktop-extension/client.js";
import { waitFor } from "./pi-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const tool = (name: string, id?: string) => ({
  name,
  description: "fixture tool",
  inputSchema: { type: "object" },
  ...(id === undefined
    ? {}
    : { _meta: { connector_id: id, "openai/outputTemplate": "ui://fixture/template" } }),
});
const catalogue = [
  tool("misleading_disabled_prefix", "allowed"),
  tool("looks_safe", "disabled"),
  tool("no_metadata"),
  tool("empty_metadata", " "),
];

async function setup(
  handler: (
    value: Record<string, unknown> | undefined,
    response: ServerResponse,
    request: IncomingMessage
  ) => void,
  disabled: readonly string[] = ["disabled"],
  disabledTools: ChatGptAppsPolicy["disabledTools"] = {},
  requestElicitation?: (request: unknown, signal: AbortSignal) => Promise<unknown>
) {
  const forwarded: RequestOptions[] = [];
  const requests: {
    value: Record<string, unknown> | undefined;
    headers: IncomingMessage["headers"];
  }[] = [];
  const events: DesktopMcpCallEvent[] = [];
  const diagnostics: string[] = [];
  let context: { threadId: string; turnId: string } | null = {
    threadId: "actual-gui-thread",
    turnId: "actual-gui-turn",
  };
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const value = bytes.length
        ? (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>)
        : undefined;
      requests.push({ value, headers: request.headers });
      handler(value, response, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture upstream did not bind");
  cleanup.push(async () => {
    const closed = new Promise<void>((resolve) => upstream.close(() => resolve()));
    upstream.closeAllConnections();
    await closed;
  });
  const relay = new ChatGptAppsRelay({
    serverName: "codex_apps",
    disabledConnectors: disabled,
    disabledTools,
    ...(requestElicitation ? { requestElicitation } : {}),
    getContext: () => context,
    onEvent: (event) => events.push(event),
    onDiagnostic: (message) => diagnostics.push(message),
    requestUpstream: (options, listener) => {
      forwarded.push(options);
      return httpRequest(
        { ...options, protocol: "http:", hostname: "127.0.0.1", port: address.port },
        listener
      );
    },
  });
  cleanup.push(() => relay.dispose());
  const url = await relay.start();
  let counter = 0;
  const send = (
    method: string,
    params?: unknown,
    options: {
      id?: string | number;
      url?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {}
  ) =>
    fetch(options.url ?? url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "native-session",
        ...options.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: options.id ?? ++counter, method, params }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  return {
    relay,
    url,
    send,
    events,
    diagnostics,
    forwarded,
    requests,
    setContext: (next: typeof context) => {
      context = next;
    },
  };
}

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, {
    "content-type": "application/json",
    "mcp-session-id": "native-session",
    "set-cookie": "do-not-forward=1",
  });
  response.end(JSON.stringify(value));
}

describe("fixed-target ChatGPT apps MCP relay", () => {
  it("injects canonical issuing GUI call metadata upstream without changing opaque arguments or unrelated metadata", async () => {
    const fixture = await setup((value, response) =>
      json(response, {
        jsonrpc: "2.0",
        id: value?.id,
        result: value?.method === "tools/list" ? { tools: catalogue } : { content: [] },
      })
    );
    await (await fixture.send("tools/list")).json();
    const args = { code: "opaque", nested: { threadId: "argument-not-scope", dollars: "$native" } };
    await (
      await fixture.send("tools/call", {
        name: "misleading_disabled_prefix",
        arguments: args,
        _meta: {
          progressToken: "pi-progress",
          opaque: { retained: [1, 2] },
          callId: "forged",
          "x-codex-turn-metadata": { thread_id: "forged", turn_id: "forged", unrelated: "keep" },
          codex_apps: { call_id: "forged", opaque: "keep" },
        },
      })
    ).json();
    const started = fixture.events.find((event) => event.phase === "started");
    expect(fixture.requests[1].value).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "misleading_disabled_prefix",
        arguments: args,
        _meta: {
          progressToken: "pi-progress",
          opaque: { retained: [1, 2] },
          callId: started?.callId,
          "x-codex-turn-metadata": {
            session_id: "actual-gui-thread",
            thread_id: "actual-gui-thread",
            thread_source: "user",
            turn_id: "actual-gui-turn",
            unrelated: "keep",
          },
          codex_apps: { call_id: started?.callId, opaque: "keep" },
        },
      },
    });
    expect(started?.callId).toMatch(/^desktop_mcp_/);
    fixture.setContext({ threadId: "replacement-thread", turnId: "replacement-turn" });
    await (
      await fixture.send("tools/call", { name: "misleading_disabled_prefix", arguments: args })
    ).json();
    expect(fixture.requests[2].value).toMatchObject({
      params: {
        arguments: args,
        _meta: {
          callId: fixture.events[2].callId,
          "x-codex-turn-metadata": { thread_id: "replacement-thread", turn_id: "replacement-turn" },
          codex_apps: { call_id: fixture.events[2].callId },
        },
      },
    });
    expect(fixture.events[2].callId).not.toBe(started?.callId);
  });

  it("revokes accepted 202 calls and their GET stream, suppresses stale completion/questions, and scopes replacement-turn elicitation", async () => {
    const streams: ServerResponse[] = [];
    const asked: unknown[] = [];
    const fixture = await setup(
      (value, response, request) => {
        if (request.method === "GET") {
          streams.push(response);
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": connected\n\n");
        } else if (value?.method === "tools/list")
          json(response, { jsonrpc: "2.0", id: value.id, result: { tools: catalogue } });
        else if (value?.method === "tools/call") response.writeHead(202).end();
        else if (value?.id === "fresh-question") {
          response.writeHead(202).end();
          streams[1]?.end(
            'data: {"jsonrpc":"2.0","id":"fresh-id","result":{"content":[],"_meta":{"fresh":true}}}\n\n'
          );
        }
      },
      ["disabled"],
      {},
      async (request) => {
        asked.push(request);
        return { action: "decline", content: null, _meta: null };
      }
    );
    await (await fixture.send("tools/list")).json();
    const accepted = await fixture.send(
      "tools/call",
      { name: "misleading_disabled_prefix" },
      { id: "old-id" }
    );
    expect(accepted.status).toBe(202);
    await accepted.text();
    const oldCall = fixture.events[0];
    const previous = await fetch(fixture.url, { headers: { "mcp-session-id": "native-session" } });
    const closed = expect(previous.text()).rejects.toThrow();
    fixture.relay.cancelTurn("interrupted");
    fixture.setContext({ threadId: "actual-gui-thread", turnId: "replacement-turn" });
    await closed;
    await waitFor(() => (streams[0]?.destroyed ? true : undefined));
    expect(fixture.events.at(-1)).toMatchObject({
      callId: oldCall.callId,
      phase: "completed",
      error: { code: -32800 },
    });
    // Reusing a cancelled ID on this same session would make a GET result ambiguous.
    await expect(
      (
        await fixture.send("tools/call", { name: "misleading_disabled_prefix" }, { id: "old-id" })
      ).json()
    ).resolves.toMatchObject({ error: { message: expect.stringContaining("cancelled") } });
    const fresh = await fixture.send(
      "tools/call",
      { name: "misleading_disabled_prefix" },
      { id: "fresh-id" }
    );
    expect(fresh.status).toBe(202);
    await fresh.text();
    const freshCall = fixture.events.find(
      (event) => event.phase === "started" && event.turnId === "replacement-turn"
    );
    const current = await fetch(fixture.url, { headers: { "mcp-session-id": "native-session" } });
    const output = current.text();
    const question = (id: string, callId?: string) => ({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: {
        message: id,
        requestedSchema: { type: "object" },
        ...(callId ? { _meta: { codex_apps: { call_id: callId } } } : {}),
      },
    });
    const legitimate = question("fresh-question", freshCall?.callId);
    streams[1]?.write(
      [
        {
          jsonrpc: "2.0",
          id: "old-id",
          result: { content: [{ type: "text", text: "LATE_SUCCESS" }] },
        },
        question("late-question", oldCall.callId),
        question("ambiguous-late-question"),
        { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        legitimate,
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join("")
    );
    const text = await output;
    expect(text).not.toContain("LATE_SUCCESS");
    expect(text).not.toContain("late-question");
    expect(text).toContain("notifications/progress");
    expect(text).toContain('"fresh":true');
    expect(asked).toEqual([legitimate.params]);
    expect(
      fixture.requests.find((request) => request.value?.id === "fresh-question")?.value
    ).toEqual({
      jsonrpc: "2.0",
      id: "fresh-question",
      result: { action: "decline", content: null, _meta: null },
    });
    expect(fixture.events.filter((event) => event.phase === "completed")).toHaveLength(2);
    expect(fixture.events.at(-1)).toMatchObject({
      callId: freshCall?.callId,
      turnId: "replacement-turn",
      result: { _meta: { fresh: true } },
    });
  });

  it.each(["accept", "decline", "cancel"])(
    "delegates HTTP elicitation %s to GUI and posts the exact reply only to the authorized upstream",
    async (action) => {
      const raw = {
        mode: "form",
        message: "Allow this operation?",
        requestedSchema: { type: "object", properties: { opaque: { type: "string" } } },
        _meta: { opaque: "native-handle" },
      };
      const result = { action, content: { opaque: "native-handle" }, _meta: { preserved: true } };
      let stream: ServerResponse | undefined;
      let toolId: unknown;
      let answer: ((result: unknown) => void) | undefined;
      const asked: unknown[] = [];
      const fixture = await setup(
        (value, response) => {
          if (value?.method === "initialize")
            json(response, { jsonrpc: "2.0", id: value.id, result: {} });
          else if (value?.method === "tools/list")
            json(response, { jsonrpc: "2.0", id: value.id, result: { tools: catalogue } });
          else if (value?.method === "tools/call") {
            stream = response;
            toolId = value.id;
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "mcp-session-id": "native-session",
            });
            response.write(
              `id: permission-event\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "server-question", method: "elicitation/create", params: raw })}\n\n`
            );
          } else if (value?.id === "server-question") {
            response.writeHead(202).end();
            stream?.end(
              `id: completed-event\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: toolId, result: { content: [], _meta: { rich: true } } })}\n\n`
            );
          }
        },
        ["disabled"],
        {},
        (request) => {
          asked.push(request);
          return new Promise((resolve) => {
            answer = resolve;
          });
        }
      );
      await (
        await fixture.send("initialize", { capabilities: { roots: { listChanged: true } } })
      ).json();
      expect(fixture.requests[0].value).toMatchObject({
        params: {
          capabilities: { roots: { listChanged: true }, elicitation: { form: {}, url: {} } },
        },
      });
      await (await fixture.send("tools/list")).json();
      const response = await fixture.send(
        "tools/call",
        { name: "misleading_disabled_prefix" },
        {
          headers: {
            authorization: "Bearer fixture-only",
            "chatgpt-account-id": "fixture-account",
          },
        }
      );
      const output = response.text();
      await waitFor(() => answer);
      expect(asked).toEqual([raw]);
      expect(fixture.requests.some((request) => request.value?.id === "server-question")).toBe(
        false
      );
      answer?.(result);
      const text = await output;
      expect(text).toContain("id: permission-event");
      expect(text).not.toContain('"elicitation/create"');
      expect(text).not.toContain("Allow this operation?");
      expect(text).toContain('"rich":true');
      const reply = fixture.requests.find((request) => request.value?.id === "server-question");
      expect(reply?.value).toEqual({ jsonrpc: "2.0", id: "server-question", result });
      expect(reply?.headers).toMatchObject({
        authorization: "Bearer fixture-only",
        "chatgpt-account-id": "fixture-account",
        "mcp-session-id": "native-session",
      });
      expect(fixture.events.at(-1)).toMatchObject({
        phase: "completed",
        result: { _meta: { rich: true } },
      });
    }
  );

  it("posts exact GUI elicitation errors upstream and cancels human waits on disposal", async () => {
    let stream: ServerResponse | undefined;
    let toolId: unknown;
    const rawError = { code: 403, message: "GUI declined", data: { opaque: "native-handle" } };
    let requests = 0;
    let waitingSignal: AbortSignal | undefined;
    const fixture = await setup(
      (value, response) => {
        if (value?.method === "tools/list")
          json(response, { jsonrpc: "2.0", id: value.id, result: { tools: catalogue } });
        else if (value?.method === "tools/call") {
          stream = response;
          toolId = value.id;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: "question", method: "elicitation/create", params: { message: "Approve?", requestedSchema: { type: "object", properties: {} } } })}\n\n`
          );
        } else if (value?.id === "question") {
          response.writeHead(202).end();
          stream?.end(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: toolId, error: { code: -32000, message: "permission failed" } })}\n\n`
          );
        }
      },
      ["disabled"],
      {},
      async (_request, signal) => {
        if (++requests === 1)
          throw Object.assign(new Error("GUI declined"), { rpcError: rawError });
        waitingSignal = signal;
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        );
      }
    );
    await (await fixture.send("tools/list")).json();
    await (await fixture.send("tools/call", { name: "misleading_disabled_prefix" })).text();
    expect(fixture.requests.find((request) => request.value?.id === "question")?.value).toEqual({
      jsonrpc: "2.0",
      id: "question",
      error: rawError,
    });
    const second = await fixture.send("tools/call", { name: "misleading_disabled_prefix" });
    const disconnected = expect(second.text()).rejects.toThrow();
    await waitFor(() => waitingSignal);
    await fixture.relay.dispose();
    await disconnected;
    expect(waitingSignal?.aborted).toBe(true);
    expect(fixture.requests.filter((request) => request.value?.id === "question")).toHaveLength(1);
  });

  it("filters complete EOF SSE data exactly as native Pi dispatches it", async () => {
    const fixture = await setup((value, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: value?.id, result: { tools: catalogue } })}`
      );
    });
    const text = await (await fixture.send("tools/list")).text();
    expect(text).toContain('"tools":[{"name":"misleading_disabled_prefix"');
    expect(text).not.toContain('"looks_safe"');
    expect(text).not.toContain('"no_metadata"');
  });

  it("correlates overlapping stateless client IDs by their HTTP response stream", async () => {
    let first: ServerResponse | undefined;
    let calls = 0;
    const fixture = await setup((value, response) => {
      if (value?.method === "tools/list") {
        json(response, { jsonrpc: "2.0", id: value.id, result: { tools: catalogue } });
      } else if (++calls === 1) {
        first = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": pending\n\n");
      } else
        json(response, {
          jsonrpc: "2.0",
          id: value?.id,
          result: { content: [], _meta: { owner: "second" } },
        });
    });
    const options = { id: 2, headers: { "mcp-session-id": "" } };
    await (await fixture.send("tools/list", undefined, options)).json();
    const one = await fixture.send("tools/call", { name: "misleading_disabled_prefix" }, options);
    const body = one.text();
    expect(
      await (
        await fixture.send("tools/call", { name: "misleading_disabled_prefix" }, options)
      ).json()
    ).toMatchObject({ result: { _meta: { owner: "second" } } });
    first?.end(
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[],"_meta":{"owner":"first"}}}\n\n'
    );
    expect(await body).toContain('"owner":"first"');
    expect(
      fixture.events.filter((event) => event.phase === "completed").map((event) => event.result)
    ).toEqual([
      { content: [], _meta: { owner: "second" } },
      { content: [], _meta: { owner: "first" } },
    ]);
  });

  it("ends old same-session pending state on initialize so fresh clients can reuse IDs", async () => {
    const fixture = await setup((value, response) => {
      if (value?.method === "tools/call") response.writeHead(202).end();
      else json(response, { jsonrpc: "2.0", id: value?.id, result: { tools: catalogue } });
    });
    await (await fixture.send("tools/list")).json();
    await (
      await fixture.send("tools/call", { name: "misleading_disabled_prefix" }, { id: 22 })
    ).text();
    await (await fixture.send("initialize")).json();
    expect(fixture.events.at(-1)).toMatchObject({
      phase: "completed",
      error: { code: -32800, message: expect.stringContaining("reinitialized") },
    });
    const reused = await fixture.send("tools/list", undefined, { id: 22 });
    expect(await reused.json()).toMatchObject({ result: { tools: [catalogue[0]] } });
  });

  it("rejects ambiguous asynchronous GET IDs rather than assigning a result to another client", async () => {
    const fixture = await setup((value, response, request) => {
      if (request.method === "GET")
        json(response, {
          jsonrpc: "2.0",
          id: "shared",
          result: { content: [], _meta: { mustNotBeAssigned: true } },
        });
      else if (value?.method === "tools/list")
        json(response, { jsonrpc: "2.0", id: value.id, result: { tools: catalogue } });
      else response.writeHead(202).end();
    });
    await (await fixture.send("tools/list")).json();
    for (let i = 0; i < 2; i++)
      await (
        await fixture.send("tools/call", { name: "misleading_disabled_prefix" }, { id: "shared" })
      ).text();
    const result = await (
      await fetch(fixture.url, { headers: { "mcp-session-id": "native-session" } })
    ).json();
    expect(result).toMatchObject({ error: { message: expect.stringContaining("Ambiguous") } });
    const completions = fixture.events.filter((event) => event.phase === "completed");
    expect(completions).toHaveLength(2);
    expect(
      completions.every((event) => event.result === undefined && event.error !== undefined)
    ).toBe(true);
  });

  it("filters exact per-connector original names and titles without dropping other tools or inferring prefixes", async () => {
    const tools = [
      tool("chatgpt_space.create_presentation", " connector_openai_pages "),
      { ...tool("other_raw_name", "other_connector"), title: "chatgpt_space.create_presentation" },
      tool("capture_file_upload", "connector_openai_pages"),
      {
        ...tool("raw_upstream_name", "connector_openai_pages"),
        title: "chatgpt_space.create_canvas",
      },
      tool("chatgpt_space.create_presentation_similar", "connector_openai_pages"),
      tool("missing"),
    ];
    const fixture = await setup(
      (value, response) =>
        json(response, {
          jsonrpc: "2.0",
          id: value?.id,
          result: value?.method === "tools/list" ? { tools } : { content: [] },
        }),
      [],
      {
        connector_openai_pages: [
          "chatgpt_space.create_presentation",
          "chatgpt_space.create_canvas",
        ],
      }
    );
    expect(await (await fixture.send("tools/list")).json()).toMatchObject({
      result: { tools: [tools[1], tools[2], tools[4]] },
    });
    for (const name of ["raw_upstream_name", "missing"]) {
      const count = fixture.requests.length;
      expect(await (await fixture.send("tools/call", { name })).json()).toMatchObject({
        error: {
          message: expect.stringContaining(
            name === "missing" ? "missing _meta" : "tool is disabled"
          ),
        },
      });
      expect(fixture.requests).toHaveLength(count);
    }
    expect(
      await (await fixture.send("tools/call", { name: "capture_file_upload" })).json()
    ).toMatchObject({ result: { content: [] } });
    expect(
      await (
        await fixture.send("tools/call", { name: "chatgpt_space.create_presentation_similar" })
      ).json()
    ).toMatchObject({ result: { content: [] } });
  });

  it("rotates and invalidates the catalogue on per-tool policy changes but not ordering changes", async () => {
    const fixture = await setup(
      (value, response) =>
        json(response, {
          jsonrpc: "2.0",
          id: value?.id,
          result: { tools: [tool("write", "app"), tool("read", "app")] },
        }),
      [],
      { app: ["write"] }
    );
    await (await fixture.send("tools/list")).json();
    fixture.relay.updatePolicy({
      disabledConnectors: [],
      disabledTools: { app: ["write", "write"] },
    });
    expect(await fixture.relay.start()).toBe(fixture.url);
    fixture.relay.updatePolicy({ disabledConnectors: [], disabledTools: { app: ["read"] } });
    const next = await fixture.relay.start();
    expect(next).not.toBe(fixture.url);
    expect((await fixture.send("tools/list")).status).toBe(404);
    expect(await (await fixture.send("tools/list", undefined, { url: next })).json()).toMatchObject(
      { result: { tools: [tool("write", "app")] } }
    );
  });

  it("closes the loopback listener when disposed during partial startup", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const relay = new ChatGptAppsRelay({
      serverName: "codex_apps",
      disabledConnectors: [],
      getContext: () => null,
    });
    const starting = expect(relay.start()).rejects.toThrow("disposed");
    const server = listen.mock.contexts[0];
    try {
      await relay.dispose();
      await starting;
      expect(server.listening).toBe(false);
      await expect(relay.start()).rejects.toThrow("disposed");
    } finally {
      // Capture the real HTTP listener, so a regression cannot leave the runner open.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      listen.mockRestore();
      await relay.dispose();
    }
  });

  it("keeps metadata-free tools when unrestricted, while requiring a known catalogue before calling", async () => {
    const fixture = await setup((value, response) => {
      json(response, {
        jsonrpc: "2.0",
        id: value?.id,
        result: value?.method === "tools/list" ? { tools: catalogue } : { content: [] },
      });
    }, []);
    expect(await (await fixture.send("tools/call", { name: "no_metadata" })).json()).toMatchObject({
      error: { message: expect.stringContaining("unknown or stale") },
    });
    expect(await (await fixture.send("tools/list")).json()).toMatchObject({
      result: { tools: catalogue },
    });
    expect(await (await fixture.send("tools/call", { name: "no_metadata" })).json()).toMatchObject({
      result: { content: [] },
    });
    expect(fixture.diagnostics).toEqual([]);
    expect(fixture.events.at(-1)).toMatchObject({ phase: "completed", tool: "no_metadata" });
  });

  it("filters exact trusted connector metadata, preserves pagination and blocks denied/missing/unknown calls", async () => {
    const fixture = await setup((value, response) => {
      if (value?.method === "tools/list") {
        const params = value.params as { cursor?: string } | undefined;
        json(response, {
          jsonrpc: "2.0",
          id: value.id,
          result: params?.cursor
            ? {
                tools: [tool("page_two", "allowed")],
              }
            : { tools: catalogue, nextCursor: "next", _meta: { retained: true } },
        });
      } else
        json(response, {
          jsonrpc: "2.0",
          id: value?.id,
          result: { content: [{ type: "text", text: "ok" }] },
        });
    });
    let response = await fixture.send("tools/list");
    expect(response.headers.get("mcp-session-id")).toBe("native-session");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({
      result: { tools: [catalogue[0]], nextCursor: "next", _meta: { retained: true } },
    });
    expect(fixture.diagnostics).toEqual([
      "ChatGPT apps MCP omitted 2 tools without _meta.connector_id required by Desktop connector policy",
    ]);
    await (await fixture.send("tools/list", { cursor: "next" })).json();
    for (const [name, reason] of [
      ["looks_safe", "connector is disabled"],
      ["no_metadata", "missing _meta.connector_id"],
      ["empty_metadata", "missing _meta.connector_id"],
      ["invented", "unknown or stale"],
    ]) {
      const count = fixture.requests.length;
      response = await fixture.send("tools/call", { name });
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining(reason) },
      });
      expect(fixture.requests).toHaveLength(count);
      expect(fixture.events.at(-2)).toMatchObject({ phase: "started", tool: name });
      expect(fixture.events.at(-1)).toMatchObject({
        phase: "completed",
        tool: name,
        error: { code: -32000, message: expect.stringContaining(reason) },
      });
    }
    await (
      await fixture.send("tools/call", {
        name: "misleading_disabled_prefix",
        arguments: { threadId: "opaque-data" },
      })
    ).json();
    await (await fixture.send("tools/call", { name: "page_two" })).json();
    expect(fixture.events.filter((event) => event.phase === "started")).toHaveLength(6);
    expect(fixture.events.filter((event) => event.phase === "completed")).toHaveLength(6);
    expect(
      fixture.events.find((event) => event.tool === "misleading_disabled_prefix")
    ).toMatchObject({
      threadId: "actual-gui-thread",
      turnId: "actual-gui-turn",
      arguments: { threadId: "opaque-data" },
    });
  });

  it("passes provider authentication only to the fixed target, strips cookies, blocks redirects and rejects nonprivate routes", async () => {
    const fixture = await setup((value, response) => {
      if (value?.method === "redirect") {
        response
          .writeHead(307, { location: "https://attacker.invalid/steal", "set-cookie": "bad=1" })
          .end();
      } else json(response, { jsonrpc: "2.0", id: value?.id, result: { tools: catalogue } });
    });
    const response = await fixture.send("tools/list", undefined, {
      headers: {
        authorization: "Bearer fixture-only",
        "chatgpt-account-id": "fixture-account",
        cookie: "private-cookie=1",
        "x-openai-product-sku": "codex",
        "proxy-authorization": "must-not-forward",
        "x-upstream-url": "https://attacker.invalid",
      },
    });
    await response.json();
    expect(fixture.forwarded[0]).toMatchObject({
      protocol: "https:",
      hostname: "chatgpt.com",
      port: 443,
      path: "/backend-api/ps/mcp",
    });
    expect(fixture.requests[0].headers).toMatchObject({
      authorization: "Bearer fixture-only",
      "chatgpt-account-id": "fixture-account",
      "x-openai-product-sku": "codex",
    });
    expect(fixture.requests[0].headers.cookie).toBeUndefined();
    expect(fixture.requests[0].headers["proxy-authorization"]).toBeUndefined();
    expect(fixture.requests[0].headers["x-upstream-url"]).toBeUndefined();
    const redirect = await fixture.send("redirect");
    expect(redirect.status).toBe(502);
    expect(redirect.headers.get("location")).toBeNull();
    expect(await redirect.json()).toMatchObject({
      error: { message: "ChatGPT apps MCP redirects are not allowed" },
    });
    const wrongRoute = await fetch(new URL("/mcp/not-the-secret", fixture.url));
    expect(wrongRoute.status).toBe(404);
    expect(
      fixture.forwarded.every(
        (options) => options.hostname === "chatgpt.com" && options.path === "/backend-api/ps/mcp"
      )
    ).toBe(true);
    expect(fixture.requests).toHaveLength(2);
  });

  it("retains content-rich chunked SSE, event ids, progress, elicitations and raw call metadata", async () => {
    const result = {
      content: [
        { type: "text", text: "snowman \u2603" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      structuredContent: { rich: true },
      _meta: { "openai/outputTemplate": "ui://fixture/widget", gui: { retained: true } },
    };
    const fixture = await setup((value, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": "native-session",
        "cache-control": "no-cache",
      });
      const payload = value?.method === "tools/list" ? { tools: catalogue } : result;
      const events = [
        ": heartbeat\r\n\r\n",
        'event: message\r\nid: progress-id\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1,"progressToken":"owned-token"}}\r\n\r\n',
        'event: message\r\nid: question-id\r\ndata: {"jsonrpc":"2.0","id":"server-question","method":"elicitation/create","params":{"message":"Continue?"}}\r\n\r\n',
        `event: message\r\nid: final-id\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: value?.id, result: payload })}\r\n\r\n`,
      ].join("");
      const bytes = Buffer.from(events);
      for (let offset = 0; offset < bytes.length; offset += 7)
        response.write(bytes.subarray(offset, offset + 7));
      response.end();
    });
    let response = await fixture.send("tools/list");
    const listed = await response.text();
    expect(listed).toContain("id: final-id");
    expect(listed).toContain('"tools":[{"name":"misleading_disabled_prefix"');
    expect(listed).not.toContain('"name":"looks_safe"');
    expect(listed).toContain('"method":"elicitation/create"');
    response = await fixture.send("tools/call", { name: "misleading_disabled_prefix" });
    const text = await response.text();
    expect(text).toContain(": heartbeat\r\n\r\n");
    expect(text).toContain("id: progress-id\r\n");
    expect(text).toContain('"progressToken":"owned-token"');
    expect(text).toContain('"openai/outputTemplate":"ui://fixture/widget"');
    expect(fixture.events.at(-1)).toMatchObject({ phase: "completed", result });
    // Server response records are MCP protocol traffic, not tool invocations.
    await (await fixture.send("", { answer: "not-a-tool" })).text();
  });

  it("invalidates list_changed and policy updates, rotates the private endpoint and rejects stale calls", async () => {
    const fixture = await setup((value, response) => {
      json(
        response,
        value?.method === "change"
          ? { jsonrpc: "2.0", method: "notifications/tools/list_changed" }
          : { jsonrpc: "2.0", id: value?.id, result: { tools: catalogue } }
      );
    });
    await (await fixture.send("tools/list")).json();
    await (await fixture.send("change")).json();
    expect(
      await (await fixture.send("tools/call", { name: "misleading_disabled_prefix" })).json()
    ).toMatchObject({
      error: {
        message: expect.stringContaining("unknown or stale"),
      },
    });
    fixture.relay.updatePolicy({ disabledConnectors: ["allowed"] });
    const next = await fixture.relay.start();
    expect(next).not.toBe(fixture.url);
    expect((await fixture.send("tools/list", undefined, { url: fixture.url })).status).toBe(404);
    const result = await (await fixture.send("tools/list", undefined, { url: next })).json();
    expect(result).toMatchObject({ result: { tools: [catalogue[1]] } });
    expect(
      await (
        await fixture.send("tools/call", { name: "misleading_disabled_prefix" }, { url: next })
      ).json()
    ).toMatchObject({
      error: {
        message: expect.stringContaining("connector is disabled"),
      },
    });
  });

  it("retains accepted requests across the GET stream and forwards native elicitation replies without intercepting them", async () => {
    let callId: unknown;
    let stream: ServerResponse | undefined;
    const raw = { content: [{ type: "text", text: "accepted" }], _meta: { widget: "preserved" } };
    const fixture = await setup((value, response, request) => {
      if (request.method === "GET") {
        stream = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'id: elicitation-event\ndata: {"jsonrpc":"2.0","id":"server-question","method":"elicitation/create","params":{"message":"Approve?"}}\n\n'
        );
      } else if (value?.method === "tools/list") {
        json(response, { jsonrpc: "2.0", id: value.id, result: { tools: catalogue } });
      } else if (value?.method === "tools/call") {
        callId = value.id;
        response.writeHead(202).end();
      } else if (value?.id === "server-question") {
        stream?.end(
          `id: completed-event\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: callId, result: raw })}\n\n`
        );
        response.writeHead(202).end();
      }
    });
    await (await fixture.send("tools/list")).json();
    const accepted = await fixture.send("tools/call", { name: "misleading_disabled_prefix" });
    expect(accepted.status).toBe(202);
    await accepted.text();
    const events = await fetch(fixture.url, {
      headers: { "mcp-session-id": "native-session", "last-event-id": "previous-event" },
    });
    const output = events.text();
    const reply = {
      jsonrpc: "2.0",
      id: "server-question",
      result: { action: "accept", content: { answer: true } },
    };
    const replyResponse = await fetch(fixture.url, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "native-session" },
      body: JSON.stringify(reply),
    });
    expect(replyResponse.status).toBe(202);
    await replyResponse.text();
    expect(await output).toContain('"method":"elicitation/create"');
    expect(fixture.requests.at(-1)?.value).toEqual(reply);
    expect(
      fixture.requests.find((request) => request.value === undefined)?.headers["last-event-id"]
    ).toBe("previous-event");
    expect(fixture.events.at(-1)).toMatchObject({ phase: "completed", result: raw });
    expect(fixture.events.filter((event) => event.phase === "completed")).toHaveLength(1);
  });

  it("cancels/disposes active streams, forwards session/status headers and decodes filtered gzip", async () => {
    let closed = 0;
    const fixture = await setup((value, response) => {
      if (value?.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        response.end(
          gzipSync(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { tools: catalogue } }))
        );
      } else if (value?.method === "unauthorized") {
        response.writeHead(401, {
          "www-authenticate": "Bearer fixture",
          "retry-after": "3",
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: "fixture unauthorized" }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting\n\n");
        response.once("close", () => {
          closed++;
        });
      }
    });
    const list = await fixture.send("tools/list");
    expect(list.headers.get("content-encoding")).toBeNull();
    expect(await list.json()).toMatchObject({ result: { tools: [catalogue[0]] } });
    const unauthorized = await fixture.send("unauthorized");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer fixture");
    expect(unauthorized.headers.get("retry-after")).toBe("3");
    await unauthorized.text();
    const abort = new AbortController();
    const first = await fixture.send(
      "tools/call",
      { name: "misleading_disabled_prefix" },
      { signal: abort.signal }
    );
    const firstBody = first.text();
    const rejected = expect(firstBody).rejects.toThrow();
    abort.abort();
    await rejected;
    await waitFor(() => (closed >= 1 ? true : undefined));
    const second = await fixture.send("tools/call", { name: "misleading_disabled_prefix" });
    const secondBody = second.text();
    const disposed = expect(secondBody).rejects.toThrow();
    await fixture.relay.dispose();
    await disposed;
    await waitFor(() => (closed >= 2 ? true : undefined));
    expect(fixture.events.filter((event) => event.phase === "completed")).toHaveLength(2);
    await expect(fetch(fixture.url)).rejects.toThrow();
  });

  it("consumes only canonical ChatGPT marker configs before native Pi registration and rejects arbitrary targets", async () => {
    const capabilities = {
      tools: [],
      instructions: [],
      mcpServers: {
        codex_apps: {
          url: CHATGPT_APPS_MCP_URL,
          auth: { provider: "openai-codex" },
          _codapter: { disabledConnectors: ["disabled"] },
        },
      },
    };
    const bridge = new DesktopBridge(capabilities, () => {});
    cleanup.push(() => bridge.dispose());
    const path = await bridge.start();
    const rewritten = (await desktopRequest(path, "desktop/capabilities")) as typeof capabilities;
    expect(bridge.instrumentedMcpServers(false)).toEqual(["codex_apps"]);
    expect(rewritten.mcpServers.codex_apps).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/),
      auth: { provider: "openai-codex" },
    });
    expect(() =>
      bridge.refresh({
        ...capabilities,
        mcpServers: {
          codex_apps: {
            ...capabilities.mcpServers.codex_apps,
            url: "https://attacker.invalid/mcp",
          },
        },
      })
    ).toThrow("canonical ChatGPT");
    await expect(desktopRequest(path, "desktop/capabilities")).rejects.toThrow("canonical ChatGPT");
  });

  it("cancels proxy MCP events exactly once and prevents late completions entering another GUI turn", async () => {
    const events: DesktopMcpCallEvent[] = [];
    const bridge = new DesktopBridge(
      undefined,
      () => {},
      (event) => events.push(event)
    );
    cleanup.push(() => bridge.dispose());
    const path = await bridge.start();
    const started = {
      phase: "started",
      threadId: "forged-thread",
      turnId: "forged-turn",
      callId: "proxy-call",
      server: "node_repl",
      tool: "js",
      arguments: { code: "opaque" },
    };
    await expect(desktopRequest(path, "desktop/mcp/event", started)).rejects.toThrow(
      "active GUI turn"
    );
    bridge.beginTurn("actual-thread", "first-turn");
    await desktopRequest(path, "desktop/mcp/event", started);
    await expect(desktopRequest(path, "desktop/mcp/event", started)).rejects.toThrow("Duplicate");
    bridge.beginTurn("actual-thread", "second-turn");
    expect(events).toMatchObject([
      { phase: "started", threadId: "actual-thread", turnId: "first-turn" },
      {
        phase: "completed",
        threadId: "actual-thread",
        turnId: "first-turn",
        error: { code: -32800 },
      },
    ]);
    await expect(
      desktopRequest(path, "desktop/mcp/event", {
        phase: "completed",
        callId: "proxy-call",
        result: { _meta: { stale: true } },
      })
    ).rejects.toThrow("Unknown or cancelled");
    await desktopRequest(path, "desktop/mcp/event", { ...started, callId: "next-call" });
    await bridge.dispose();
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      callId: "next-call",
      turnId: "second-turn",
      error: { code: -32800, message: "Desktop bridge disposed" },
    });
  });

  it("recognizes node_repl instrumentation only for the enabled stdio config with an actual proxy path", () => {
    const capabilities = {
      tools: [],
      instructions: [],
      mcpServers: {
        node_repl: { command: "/native/node-repl" },
        ordinary: { command: "/native/ordinary" },
      },
    };
    const bridge = new DesktopBridge(capabilities, () => {});
    cleanup.push(() => bridge.dispose());
    expect(bridge.instrumentedMcpServers(false)).toEqual([]);
    expect(bridge.instrumentedMcpServers(true)).toEqual(["node_repl"]);
    bridge.refresh({
      ...capabilities,
      mcpServers: { node_repl: { command: "/native/node-repl", enabled: false } },
    });
    expect(bridge.instrumentedMcpServers(true)).toEqual([]);
    bridge.refresh({
      ...capabilities,
      mcpServers: { node_repl: { url: "https://example.invalid" } },
    });
    expect(bridge.instrumentedMcpServers(true)).toEqual([]);
  });
});
