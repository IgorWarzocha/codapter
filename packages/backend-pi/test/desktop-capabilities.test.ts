import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendAppServerEvent, DesktopSessionCapabilities } from "@codapter/core";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { CHATGPT_APPS_MCP_URL } from "../src/chatgpt-apps-relay.js";
import { DesktopBridge } from "../src/desktop-bridge.js";
import { desktopRequest } from "../src/desktop-extension/client.js";
import { desktopToolName } from "../src/desktop-extension/index.js";
import { createPiBackend, type PiBackend } from "../src/index.js";
import { attachJsonlLineReader } from "../src/jsonl.js";
import { PiProcessSession } from "../src/pi-process.js";
import { waitFor } from "./pi-fixture.js";

const capabilities: DesktopSessionCapabilities = {
  tools: [
    {
      name: "open",
      namespace: "browser",
      description: "Open page",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      deferLoading: false,
    },
  ],
  mcpServers: {
    desktop_apps: {
      url: "https://example.invalid/mcp",
      exposure: "deferred",
      auth: { provider: "openai-codex" },
      headers: { Authorization: "secret-not-for-disk" },
    },
  },
  instructions: ["Desktop guidance"],
};
const name = desktopToolName(capabilities.tools[0]);
type Request = Extract<BackendAppServerEvent, { kind: "serverRequest" }>;
interface Capture {
  pid: number;
  argv: string[];
  endpoint: string;
  prompts: {
    tools: { name: string; exposure: string; parameters?: unknown }[];
    mcp: Record<string, unknown>;
    instructions: string;
  }[];
  results: { result: { content: unknown[]; details: unknown }; isError: boolean }[];
  sessionMcp: string[][];
  mcpRegistrations: string[];
}

const owned: { backend?: PiBackend; root: string }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    await item.backend?.dispose();
    await rm(item.root, { recursive: true, force: true });
  }
});

async function setup(
  extra: { desktopMcpProxyPath?: string } = {},
  extraEnv: NodeJS.ProcessEnv = {}
) {
  const root = await mkdtemp(join(tmpdir(), "codapter-desktop-test-"));
  const capturePath = join(root, "capture.json");
  const extensionPath = join(root, "desktop-extension.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/desktop-extension/index.ts", import.meta.url))],
    outfile: extensionPath,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const options = {
    sessionDir: root,
    command: process.execPath,
    args: [
      fileURLToPath(new URL("fixtures/desktop-pi.mjs", import.meta.url)),
      "--extension",
      "native-user-extension",
    ],
    desktopExtensionPath: extensionPath,
    env: { ...extraEnv, CODAPTER_DESKTOP_CAPTURE: capturePath },
    requestTimeoutMs: 250,
    idleTimeoutMs: 0,
    ...extra,
  };
  const backend = createPiBackend(options);
  owned.push({ root, backend });
  await backend.initialize();
  const start = async (threadId = "gui-thread", desktopCapabilities = capabilities) => {
    const { threadHandle } = await backend.threadStart({
      threadId,
      cwd: root,
      model: null,
      reasoningEffort: null,
      launchConfig: { desktopCapabilities },
    });
    const events: BackendAppServerEvent[] = [];
    backend.onEvent(threadHandle, (event) => events.push(event));
    return { threadHandle, threadId, events };
  };
  const capture = async () => JSON.parse(await readFile(capturePath, "utf8")) as Capture;
  const turn = async (
    threadHandle: string,
    turnId: string,
    spec: unknown = { tool: name, args: { url: "https://example.test" } },
    desktopCapabilities?: DesktopSessionCapabilities,
    threadId = "gui-thread"
  ) => {
    await backend.turnStart({
      threadHandle,
      threadId,
      turnId,
      cwd: root,
      model: null,
      reasoningEffort: null,
      input: [{ type: "text", text: JSON.stringify(spec), text_elements: [] }],
      desktopCapabilities,
    });
  };
  return { root, options, backend, start, turn, capture };
}

function request(events: BackendAppServerEvent[], index = 0) {
  return waitFor(
    () =>
      events.filter(
        (event): event is Request =>
          event.kind === "serverRequest" && event.method === "item/tool/call"
      )[index]
  );
}
function settled(events: BackendAppServerEvent[], turnId: string) {
  return waitFor(() =>
    events.find(
      (event) =>
        event.kind === "notification" &&
        event.method === "turn/completed" &&
        JSON.stringify(event.params).includes(turnId)
    )
  );
}

describe("Desktop capabilities through native Pi process and bundled extension", () => {
  it("fails closed for strict auto review instead of offering unsupported Guardian review as a GUI approval", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    await turn(first.threadHandle, "strict-review");
    const tool = await request(first.events);
    const actual = await capture();
    const raw = {
      mode: "openai/form",
      message: "Approve Browser action?",
      requestedSchema: { type: "object" },
      _meta: { codex_strict_auto_review: true, opaque: "retained" },
    };
    await expect(
      desktopRequest(actual.endpoint, "desktop/mcp/elicitation", {
        server: "desktop_apps",
        request: raw,
      })
    ).rejects.toThrow("strict_auto_review");
    expect(
      first.events.filter(
        (event) =>
          event.kind === "serverRequest" && event.method === "mcpServer/elicitation/request"
      )
    ).toEqual([]);
    const response = desktopRequest(actual.endpoint, "desktop/mcp/elicitation", {
      server: "desktop_apps",
      request: { ...raw, _meta: { ...raw._meta, codex_strict_auto_review: false } },
    });
    const pending = await waitFor(() =>
      first.events.find(
        (event): event is Request =>
          event.kind === "serverRequest" && event.method === "mcpServer/elicitation/request"
      )
    );
    expect(pending.params).toMatchObject({
      mode: raw.mode,
      _meta: { codex_strict_auto_review: false, opaque: "retained" },
    });
    await backend.resolveServerRequest({
      threadHandle: first.threadHandle,
      requestId: pending.requestId,
      response: { result: { action: "decline", content: null, _meta: null } },
    });
    expect(await response).toEqual({ action: "decline", content: null, _meta: null });
    await backend.resolveServerRequest({
      threadHandle: first.threadHandle,
      requestId: tool.requestId,
      response: { success: true, contentItems: [] },
    });
    await settled(first.events, "strict-review");
  });

  it("routes native MCP form elicitation to the real GUI turn, preserves schema/meta and waits beyond the RPC deadline", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    await turn(first.threadHandle, "elicitation");
    const tool = await request(first.events);
    const actual = await capture();
    const raw = {
      threadId: "forged",
      turnId: "forged",
      serverName: "forged",
      message: "Confirm read-only access?",
      requestedSchema: {
        type: "object",
        properties: {
          approved: { type: "boolean" },
          opaque: { type: "string", enum: [first.threadHandle] },
        },
      },
      _meta: { opaque: first.threadHandle },
    };
    const response = desktopRequest(actual.endpoint, "desktop/mcp/elicitation", {
      server: "desktop_apps",
      request: raw,
    });
    const pending = await waitFor(() =>
      first.events.find(
        (event): event is Request =>
          event.kind === "serverRequest" && event.method === "mcpServer/elicitation/request"
      )
    );
    expect(pending.params).toEqual({
      ...raw,
      threadId: "gui-thread",
      turnId: "elicitation",
      serverName: "desktop_apps",
      mode: "form",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = {
      action: "accept",
      content: { opaque: first.threadHandle },
      _meta: { original: first.threadHandle },
    };
    await backend.resolveServerRequest({
      threadHandle: first.threadHandle,
      requestId: pending.requestId,
      response: { result },
    });
    expect(await response).toEqual(result);
    const denied = desktopRequest(actual.endpoint, "desktop/mcp/elicitation", {
      server: "desktop_apps",
      request: raw,
    });
    const error = { code: 403, message: "GUI denied", data: { opaque: first.threadHandle } };
    const rejected = expect(denied).rejects.toMatchObject({ rpcError: error });
    const second = await waitFor(
      () =>
        first.events.filter(
          (event): event is Request =>
            event.kind === "serverRequest" && event.method === "mcpServer/elicitation/request"
        )[1]
    );
    await backend.resolveServerRequest({
      threadHandle: first.threadHandle,
      requestId: second.requestId,
      response: { error },
    });
    await rejected;
    await backend.resolveServerRequest({
      threadHandle: first.threadHandle,
      requestId: tool.requestId,
      response: { success: true, contentItems: [] },
    });
    await settled(first.events, "elicitation");
  });

  it("rejects idle/unknown MCP elicitation and returns cancellation instead of approving interrupted requests", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    const actual = await capture();
    const params = {
      server: "desktop_apps",
      request: {
        mode: "url",
        message: "Sign in?",
        url: "https://example.test/auth",
        elicitationId: "upstream-request",
        _meta: { retained: true },
      },
    };
    await expect(
      desktopRequest(actual.endpoint, "desktop/mcp/elicitation", params)
    ).rejects.toThrow("active GUI turn");
    await turn(first.threadHandle, "elicitation-cancel");
    await request(first.events);
    await expect(
      desktopRequest(actual.endpoint, "desktop/mcp/elicitation", { ...params, server: "unknown" })
    ).rejects.toThrow("disabled or unknown");
    const response = desktopRequest(actual.endpoint, "desktop/mcp/elicitation", params);
    const cancelled = expect(response).rejects.toMatchObject({ rpcError: { code: -32800 } });
    const pending = await waitFor(() =>
      first.events.find(
        (event): event is Request =>
          event.kind === "serverRequest" && event.method === "mcpServer/elicitation/request"
      )
    );
    await backend.turnInterrupt({ ...first, turnId: "elicitation-cancel" });
    await cancelled;
    await expect(
      backend.resolveServerRequest({
        threadHandle: first.threadHandle,
        requestId: pending.requestId,
        response: { action: "accept", content: null, _meta: null },
      })
    ).rejects.toThrow("Unknown or cancelled");
    await settled(first.events, "elicitation-cancel");
  });

  it("defers owned MCP connections until input across startup, new-session, attach and clone", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    const boot = await capture();
    expect(boot.sessionMcp).toEqual([["native"], ["native"]]);
    expect(boot.mcpRegistrations).toEqual([]);
    await turn(first.threadHandle, "registration", {});
    await settled(first.events, "registration");
    expect((await capture()).mcpRegistrations).toEqual(["desktop_apps"]);
    await backend.forkSession(first.threadHandle);
    const forked = await capture();
    expect(forked.sessionMcp).toEqual([["native"], ["native"], ["native"]]);
    expect(forked.mcpRegistrations).toEqual([]);
  });

  it.each([
    { transport: "relay", failed: false },
    { transport: "relay", failed: true },
    { transport: "proxy", failed: false },
    { transport: "proxy", failed: true },
  ])(
    "does not duplicate native direct MCP output for $transport with failure=$failed",
    async ({ transport, failed }) => {
      const server = transport === "relay" ? "codex_apps" : "node_repl";
      const { backend, start, turn, capture } = await setup(
        transport === "proxy" ? { desktopMcpProxyPath: "/private/desktop-mcp-proxy.mjs" } : {}
      );
      const first = await start("gui-thread", {
        ...capabilities,
        mcpServers:
          transport === "relay"
            ? {
                codex_apps: {
                  url: CHATGPT_APPS_MCP_URL,
                  auth: { provider: "openai-codex" },
                  _codapter: { disabledConnectors: [] },
                },
              }
            : { node_repl: { command: "/native/node-repl" } },
      });
      const args = { code: "opaque" };
      // The controlled native fixture pauses its direct tool via a real GUI response route.
      // Raw notifications are driven separately to exercise ordering across stdout and UDS.
      await turn(first.threadHandle, "direct-mcp", {
        tool: `mcp__${server}__js`,
        executeAs: name,
        args,
      });
      const pending = await request(first.events);
      const actual = await capture();
      await desktopRequest(actual.endpoint, "desktop/mcp/event", {
        phase: "started",
        callId: "raw-direct-call",
        server,
        tool: "js",
        arguments: args,
      });
      const completion = failed
        ? { error: { code: -32000, message: "upstream failed" } }
        : {
            result: {
              content: [{ type: "text", text: "raw result" }],
              _meta: { widget: "retained" },
            },
          };
      await desktopRequest(actual.endpoint, "desktop/mcp/event", {
        phase: "completed",
        callId: "raw-direct-call",
        ...completion,
      });
      await backend.resolveServerRequest({
        threadHandle: first.threadHandle,
        requestId: pending.requestId,
        response: {
          success: !failed,
          contentItems: [{ type: "inputText", text: "native duplicate" }],
        },
      });
      await settled(first.events, "direct-mcp");
      expect(
        first.events.filter(
          (event) => event.kind === "notification" && event.method === "desktop/mcp/event"
        )
      ).toHaveLength(2);
      expect(
        first.events.filter(
          (event) => event.kind === "notification" && event.method === "item/started"
        )
      ).toEqual([]);
      expect(first.events).toContainEqual(
        expect.objectContaining({
          method: "desktop/mcp/event",
          params: expect.objectContaining({ phase: "completed", ...completion }),
        })
      );
    }
  );

  it("registers the private apps relay with native authentication and relays raw MCP events in actual GUI scope", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start("gui-thread", {
      ...capabilities,
      mcpServers: {
        codex_apps: {
          url: CHATGPT_APPS_MCP_URL,
          auth: { provider: "openai-codex" },
          exposure: "codemode",
          _codapter: { disabledConnectors: ["disabled"] },
        },
      },
    });
    await turn(first.threadHandle, "mcp-events");
    const pending = await request(first.events);
    const actual = await capture();
    expect(actual.prompts[0].mcp.codex_apps).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+$/),
      auth: { provider: "openai-codex" },
      exposure: "codemode",
    });
    await desktopRequest(actual.endpoint, "desktop/mcp/event", {
      phase: "started",
      callId: "stdio-call",
      server: "node_repl",
      tool: "js",
      threadId: "forged-thread",
      turnId: "forged-turn",
      arguments: { threadId: first.threadHandle },
    });
    const result = {
      content: [{ type: "text", text: "ok" }],
      _meta: { "openai/outputTemplate": "ui://browser/widget", opaque: first.threadHandle },
    };
    await desktopRequest(actual.endpoint, "desktop/mcp/event", {
      phase: "completed",
      callId: "stdio-call",
      result,
    });
    const completed = await waitFor(() =>
      first.events.find(
        (event) =>
          event.kind === "notification" &&
          event.method === "desktop/mcp/event" &&
          (event.params as { phase?: string }).phase === "completed"
      )
    );
    expect(completed).toMatchObject({
      kind: "notification",
      params: {
        threadId: first.threadId,
        turnId: "mcp-events",
        callId: "stdio-call",
        server: "node_repl",
        tool: "js",
        arguments: { threadId: first.threadHandle },
        result,
      },
    });
    await expect(
      desktopRequest(actual.endpoint, "desktop/mcp/event", {
        phase: "completed",
        callId: "stdio-call",
        result,
      })
    ).rejects.toThrow("Unknown or cancelled");
    await backend.resolveServerRequest({
      ...first,
      requestId: pending.requestId,
      response: { result: { success: true, contentItems: [] } },
    });
    await settled(first.events, "mcp-events");
  });

  it("does not inject Desktop endpoints or extensions into model probes and history readers", async () => {
    const { backend, options, start, capture, root } = await setup();
    await backend.listModels();
    let probe = await capture();
    expect(probe.endpoint).toBeUndefined();
    expect(probe.argv).not.toContain(options.desktopExtensionPath);
    expect(probe.argv).toContain("native-user-extension");
    const first = await start();
    await backend.disposeSession(first.threadHandle);
    await backend.threadRead({ ...first, cwd: root, includeTurns: true });
    probe = await capture();
    expect(probe.endpoint).toBeUndefined();
    expect(probe.argv).not.toContain(options.desktopExtensionPath);
    expect(probe.argv).toContain("native-user-extension");
  });

  it("keeps legal tuple identities distinct, normalizes boolean schemas and preserves nested exec calls", async () => {
    const { backend, start, turn, capture } = await setup();
    const pairs = [
      { namespace: null, name: "x" },
      { namespace: "global", name: "x" },
      { namespace: "a__b", name: "c" },
      { namespace: "a", name: "b__c" },
    ];
    const tools = pairs.map((pair, index) => ({
      ...capabilities.tools[0],
      ...pair,
      inputSchema: index === 0,
    }));
    const names = tools.map(desktopToolName);
    expect(new Set(names).size).toBe(4);
    expect(names.every((toolName) => toolName.length <= 64)).toBe(true);
    const first = await start("gui-thread", { tools, mcpServers: {}, instructions: [] });
    const args = {
      threadId: first.threadHandle,
      thread: { id: first.threadHandle },
      url: "https://example.test",
    };
    await turn(first.threadHandle, "nested", { tool: names[0], args, callId: "exec-call/0" });
    const call = await request(first.events);
    expect(call.params).toEqual({
      threadId: first.threadId,
      turnId: "nested",
      callId: "exec-call/0",
      namespace: null,
      tool: "x",
      arguments: args,
    });
    await backend.resolveServerRequest({
      ...first,
      requestId: call.requestId,
      response: { result: { success: true, contentItems: [] } },
    });
    await settled(first.events, "nested");
    const actual = await capture();
    expect(actual.prompts[0].tools.find((tool) => tool.name === names[0])?.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: true,
    });
    expect(actual.prompts[0].tools.find((tool) => tool.name === names[1])?.parameters).toEqual({
      type: "object",
      properties: {},
      not: {},
    });
  });

  it("wraps only Desktop node_repl stdio MCP in the injected metadata proxy", async () => {
    const proxy = "/private/desktop-mcp-proxy.mjs";
    const { start, turn, capture } = await setup({ desktopMcpProxyPath: proxy });
    const stdio = {
      command: "/native/node_repl",
      args: ["--flag"],
      env: { KEEP: "yes" },
      exposure: "deferred",
      toolExposure: { js: "deferred", js_reset: "hidden", "*": "hidden" },
      timeout: 200,
    };
    const first = await start("gui-thread", {
      ...capabilities,
      mcpServers: {
        node_repl: stdio,
        ordinary: { command: "/native/ordinary" },
        ...capabilities.mcpServers,
      },
    });
    await turn(first.threadHandle, "proxy", {});
    await settled(first.events, "proxy");
    const actual = await capture();
    expect(actual.prompts[0].mcp.node_repl).toEqual({
      ...stdio,
      command: process.execPath,
      args: [proxy],
      env: {
        KEEP: "yes",
        CODAPTER_DESKTOP_UDS: actual.endpoint,
        CODAPTER_DESKTOP_MCP_CONFIG: Buffer.from(JSON.stringify(stdio)).toString("base64"),
      },
    });
    expect(actual.prompts[0].mcp.ordinary).toEqual({ command: "/native/ordinary" });
    expect(actual.prompts[0].mcp.desktop_apps).toEqual(capabilities.mcpServers.desktop_apps);
  });

  it("preserves and refreshes core-normalized MCP whitelists and denials without changing native policies", async () => {
    const { start, turn, capture } = await setup();
    const server = {
      url: "https://example.invalid/mcp",
      auth: { provider: "openai-codex" },
      exposure: "hidden",
      toolExposure: { read: "deferred", remove: "hidden", "*": "hidden" },
    };
    const first = await start("gui-thread", {
      ...capabilities,
      mcpServers: { restricted_apps: server },
    });
    await turn(first.threadHandle, "whitelist", {});
    await settled(first.events, "whitelist");
    let actual = await capture();
    expect(actual.prompts[0].mcp.restricted_apps).toEqual(server);
    expect(actual.prompts[0].mcp.native).toEqual({ command: "native-server" });
    const revoked = {
      ...server,
      toolExposure: { read: "hidden", remove: "hidden", "*": "hidden" },
    };
    await turn(
      first.threadHandle,
      "denied",
      {},
      { ...capabilities, mcpServers: { restricted_apps: revoked } }
    );
    await settled(first.events, "denied");
    actual = await capture();
    expect(actual.prompts[1].mcp.restricted_apps).toEqual(revoked);
    expect(actual.prompts[1].mcp.native).toEqual({ command: "native-server" });
  });

  it("adds guidance to native forced prompts without replacing their contents", async () => {
    const { start, turn, capture } = await setup();
    const first = await start();
    await turn(first.threadHandle, "custom-prompt", { forcePrompt: "Native custom prompt" });
    await settled(first.events, "custom-prompt");
    expect((await capture()).prompts[0].instructions).toBe(
      "Native custom prompt\n\nDesktop guidance"
    );
  });

  it("revokes owned capabilities if native refresh fails instead of leaving stale MCPs active", async () => {
    const { start, turn, capture } = await setup({}, { CODAPTER_DESKTOP_MCP_REJECT: "rejected" });
    const first = await start();
    await turn(
      first.threadHandle,
      "failed-refresh",
      {},
      { ...capabilities, mcpServers: { rejected: { url: "https://rejected.invalid" } } }
    );
    await settled(first.events, "failed-refresh");
    const actual = await capture();
    expect(actual.prompts[0].tools.find((tool) => tool.name === name)?.exposure).toBe("hidden");
    expect(actual.prompts[0].mcp).toEqual({ native: { command: "native-server" } });
    expect(actual.prompts[0].instructions).toBe("Native instructions");
    expect(first.events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        code: "PI_EXTENSION_ERROR",
        message: "MCP registration rejected by native runtime",
      })
    );
  });

  it("does not prompt after preflight interruption or cancel a newer prepared turn", async () => {
    const { options } = await setup();
    const session = new PiProcessSession({ ...options, opaqueSessionId: "preflight-session" });
    try {
      await session.startFresh();
      session.prepareDesktopTurn("gui-thread", "old-turn", capabilities);
      await session.abort();
      await expect(session.prompt("old-turn", "{}")).rejects.toThrow("aborted");
      session.prepareDesktopTurn("gui-thread", "new-turn", capabilities);
      session.cancelDesktopTurn("old-turn", "Stale failure");
      await expect(session.prompt("old-turn", "{}")).rejects.toThrow(
        "interrupted before prompting"
      );
      await expect(session.prompt("new-turn", "{}")).resolves.toBeUndefined();
    } finally {
      await session.dispose();
    }
  });

  it("registers without replacing native resources and returns text, images and tool failures", async () => {
    const { backend, start, turn, capture, root } = await setup();
    const { threadHandle, threadId, events } = await start();
    const initial = await capture();
    expect(initial.argv).toContain("native-user-extension");
    expect((await stat(initial.endpoint)).mode & 0o777).toBe(0o600);
    await turn(threadHandle, "first");
    const call = await request(events);
    expect(call.params).toEqual({
      threadId,
      turnId: "first",
      callId: "gui-call",
      namespace: "browser",
      tool: "open",
      arguments: { url: "https://example.test" },
    });
    // Tool calls are not subject to machine RPC deadlines.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await backend.resolveServerRequest({
      threadId,
      threadHandle,
      requestId: call.requestId,
      response: {
        result: {
          success: false,
          contentItems: [
            { type: "inputText", text: "Page unavailable" },
            { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
          ],
        },
      },
    });
    await settled(events, "first");
    const actual = await capture();
    expect(actual.prompts[0].tools).toEqual(
      expect.arrayContaining([
        { name: "exec", exposure: "direct" },
        { name, exposure: "direct", parameters: capabilities.tools[0].inputSchema },
      ])
    );
    expect(actual.prompts[0].mcp).toEqual({
      native: { command: "native-server" },
      ...capabilities.mcpServers,
    });
    expect(actual.prompts[0].instructions).toBe("Native instructions\n\nDesktop guidance");
    expect(actual.results[0]).toMatchObject({
      isError: true,
      result: {
        content: [
          { type: "text", text: "Page unavailable" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
    });
    const persisted = await readFile(join(root, ".codapter-pi-backend.json"), "utf8");
    expect(persisted).toContain("Desktop guidance");
    expect(persisted).not.toContain("secret-not-for-disk");
    expect(persisted).not.toContain("https://example.invalid/mcp");
  });

  it("preserves GUI JSON-RPC errors and rejects cross-session responses", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    const second = await start("other-thread");
    await turn(first.threadHandle, "errors");
    const call = await request(first.events);
    await expect(
      backend.resolveServerRequest({
        threadHandle: second.threadHandle,
        threadId: second.threadId,
        requestId: call.requestId,
        response: { success: true, contentItems: [] },
      })
    ).rejects.toThrow("Unknown or cancelled");
    const error = { code: -32001, message: "Permission denied", data: { permission: "browser" } };
    await backend.resolveServerRequest({
      ...first,
      requestId: call.requestId,
      response: { error },
    });
    await settled(first.events, "errors");
    expect((await capture()).results.at(-1)).toMatchObject({
      isError: true,
      result: {
        content: [{ type: "text", text: "Permission denied" }],
        details: { response: { error } },
      },
    });
  });

  it("cancels waiting calls on interruption and disposal", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    await turn(first.threadHandle, "cancel");
    const call = await request(first.events);
    await backend.turnInterrupt({ ...first, turnId: "cancel" });
    await expect(
      backend.resolveServerRequest({
        ...first,
        requestId: call.requestId,
        response: { success: true, contentItems: [] },
      })
    ).rejects.toThrow("cancelled");
    await settled(first.events, "cancel");
    const second = await start("dispose-thread");
    await turn(second.threadHandle, "dispose", undefined, undefined, second.threadId);
    const waiting = await request(second.events);
    const { endpoint } = await capture();
    await backend.disposeSession(second.threadHandle);
    await expect(stat(endpoint)).rejects.toThrow();
    await expect(
      backend.resolveServerRequest({ ...second, requestId: waiting.requestId, response: {} })
    ).rejects.toThrow("cancelled");
  });

  it("rejects pending GUI routes immediately when its native subprocess exits", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    await turn(first.threadHandle, "process-failure");
    const call = await request(first.events);
    const { pid, endpoint } = await capture();
    process.kill(pid, "SIGKILL");
    await waitFor(() => first.events.find((event) => event.kind === "disconnect"));
    await expect(
      backend.resolveServerRequest({
        ...first,
        requestId: call.requestId,
        response: { result: { success: true, contentItems: [] } },
      })
    ).rejects.toThrow("cancelled");
    await backend.dispose();
    await expect(stat(endpoint)).rejects.toThrow();
  });

  it("revokes and re-enables tools/MCP and replaces instructions before subsequent prompts", async () => {
    const { backend, start, turn, capture } = await setup();
    const first = await start();
    await turn(
      first.threadHandle,
      "revoke",
      {},
      { tools: [], mcpServers: {}, instructions: ["New guidance"] }
    );
    await settled(first.events, "revoke");
    let actual = await capture();
    expect(actual.prompts[0].tools.find((tool) => tool.name === name)?.exposure).toBe("hidden");
    expect(actual.prompts[0].mcp).toEqual({ native: { command: "native-server" } });
    expect(actual.prompts[0].instructions).toBe("Native instructions\n\nNew guidance");
    const deferred = {
      ...capabilities,
      tools: capabilities.tools.map((tool) => ({ ...tool, deferLoading: true })),
    };
    await turn(first.threadHandle, "enable", { tool: name }, deferred);
    const call = await request(first.events);
    await backend.resolveServerRequest({
      ...first,
      requestId: call.requestId,
      response: { success: true, contentItems: [] },
    });
    await settled(first.events, "enable");
    actual = await capture();
    expect(actual.prompts[1].tools.find((tool) => tool.name === name)?.exposure).toBe("deferred");
    expect(actual.results.at(-1)?.isError).toBe(false);
  });

  it("restores definitions/instructions across cold restart without saving MCP credentials", async () => {
    const { backend, options, start, root } = await setup();
    const first = await start();
    await backend.dispose();
    const restarted = createPiBackend(options);
    owned.push({ root, backend: restarted });
    await restarted.initialize();
    await restarted.threadResume({ ...first, cwd: root, model: null, reasoningEffort: null });
    const capture = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as Capture;
    const restored = await desktopRequest(capture.endpoint, "desktop/capabilities");
    expect(restored).toEqual({
      tools: capabilities.tools,
      instructions: capabilities.instructions,
      mcpServers: {},
    });
  });
});

describe("Desktop UDS cancellation", () => {
  it("does not echo malformed auth-bearing JSON frame fragments", async () => {
    const bridge = new DesktopBridge(undefined, () => {});
    const path = await bridge.start();
    const socket = createConnection(path);
    try {
      const line = new Promise<string>((resolve) => {
        attachJsonlLineReader(socket, resolve);
      });
      socket.write('{"authToken":"fixture-secret-fragment", BROKEN}\n');
      const response = await line;
      expect(JSON.parse(response)).toMatchObject({
        error: { message: "Invalid Desktop JSON-RPC frame" },
      });
      expect(response).not.toContain("fixture-secret-fragment");
    } finally {
      socket.destroy();
      await bridge.dispose();
    }
  });

  it("closes aborted and failed calls and deletes pending response routes", async () => {
    const calls: string[] = [];
    const bridge = new DesktopBridge(capabilities, (call) => calls.push(call.requestId));
    const path = await bridge.start();
    try {
      bridge.beginTurn("thread", "turn");
      const abort = new AbortController();
      const pending = desktopRequest(
        path,
        "desktop/tool/call",
        { tool: "open", namespace: "browser", callId: "call", arguments: {} },
        abort.signal
      );
      const rejected = expect(pending).rejects.toThrow("Stopped");
      await waitFor(() => calls[0]);
      abort.abort(new Error("Stopped"));
      await rejected;
      // A UDS close is asynchronous on the owner side, even after client rejection.
      await waitFor(() => (bridge.hasPendingRequest(calls[0]) ? undefined : true));
      expect(bridge.resolve(calls[0], {})).toBe(false);
      const next = desktopRequest(path, "desktop/tool/call", {
        tool: "open",
        namespace: "browser",
        callId: "call2",
        arguments: {},
      });
      const disconnected = expect(next).rejects.toThrow();
      await waitFor(() => calls[1]);
      await bridge.dispose();
      await disconnected;
      expect(bridge.resolve(calls[1], {})).toBe(false);
    } finally {
      await bridge.dispose();
    }
  });

  it("publishes GUI-scoped turn lifecycle for proxy metadata and closes subscriptions", async () => {
    const bridge = new DesktopBridge(capabilities, () => {});
    const path = await bridge.start();
    const socket = createConnection(path);
    const messages: Record<string, unknown>[] = [];
    const stop = attachJsonlLineReader(socket, (line) => messages.push(JSON.parse(line)));
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "subscribe", method: "desktop/subscribe" })}\n`
      );
      await waitFor(() => messages[0]);
      expect(messages[0]).toEqual({ jsonrpc: "2.0", id: "subscribe", result: null });
      bridge.beginTurn("actual-gui-thread", "first-turn");
      expect(await desktopRequest(path, "desktop/context")).toEqual({
        threadId: "actual-gui-thread",
        turnId: "first-turn",
      });
      bridge.cancelTurn("completed", "Stop");
      bridge.beginTurn("actual-gui-thread", "second-turn");
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      await bridge.dispose();
      await closed;
      expect(messages.slice(1)).toEqual([
        {
          jsonrpc: "2.0",
          method: "desktop/turn-started",
          params: { threadId: "actual-gui-thread", turnId: "first-turn" },
        },
        {
          jsonrpc: "2.0",
          method: "desktop/turn-ended",
          params: {
            threadId: "actual-gui-thread",
            turnId: "first-turn",
            reason: "completed",
            hookEventName: "Stop",
          },
        },
        {
          jsonrpc: "2.0",
          method: "desktop/turn-started",
          params: { threadId: "actual-gui-thread", turnId: "second-turn" },
        },
        {
          jsonrpc: "2.0",
          method: "desktop/turn-ended",
          params: {
            threadId: "actual-gui-thread",
            turnId: "second-turn",
            reason: "Desktop bridge disposed",
            hookEventName: "Interrupt",
          },
        },
      ]);
    } finally {
      stop();
      socket.destroy();
      await bridge.dispose();
    }
  });
});
