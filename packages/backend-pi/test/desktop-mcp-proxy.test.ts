import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DesktopMcpCallEvent } from "../src/chatgpt-apps-relay.js";
import { DesktopBridge, type DesktopMcpElicitationRequest } from "../src/desktop-bridge.js";
import { DesktopAuthProviderClient } from "../src/desktop-extension/auth-client.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.js";
import { waitFor } from "./pi-fixture.js";

let root: string;
let proxy: string;
const owned: (() => Promise<void>)[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codapter-mcp-proxy-test-"));
  proxy = join(root, "desktop-mcp-proxy.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/desktop-mcp-proxy.ts", import.meta.url))],
    outfile: proxy,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
});
afterEach(async () => {
  for (const close of owned.splice(0).reverse()) await close();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Message {
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: unknown;
}
type HostFixture =
  | { kind: "ordinary"; stubborn?: boolean }
  | { kind: "packaged"; command: string; codex?: string };

async function start(fixture: HostFixture = { kind: "ordinary" }) {
  const events: DesktopMcpCallEvent[] = [];
  const elicitations: DesktopMcpElicitationRequest[] = [];
  const bridge = new DesktopBridge(
    { tools: [], mcpServers: { node_repl: { command: process.execPath } }, instructions: [] },
    () => {},
    (event) => events.push(event),
    undefined,
    (request) => elicitations.push(request)
  );
  const path = await bridge.start();
  owned.push(() => bridge.dispose());
  const capture = join(root, `${Math.random()}.jsonl`);
  await writeFile(capture, "");
  const config = {
    command: fixture.kind === "packaged" ? fixture.command : process.execPath,
    args:
      fixture.kind === "packaged"
        ? []
        : [
            fileURLToPath(new URL("fixtures/desktop-mcp-host.mjs", import.meta.url)),
            ...(fixture.stubborn ? ["--stubborn"] : []),
          ],
    cwd: root,
    env: {
      CAPTURE: capture,
      EXPLICIT: "$$literal",
      NODE_REPL_AUTH_TOKEN: "must-not-inherit",
      ...(fixture.kind === "packaged" && fixture.codex ? { CODEX_CLI_PATH: fixture.codex } : {}),
    },
  };
  const child = spawn(process.execPath, [proxy], {
    env: {
      ...process.env,
      CODAPTER_DESKTOP_UDS: path,
      CODAPTER_DESKTOP_MCP_CONFIG: Buffer.from(JSON.stringify(config)).toString("base64"),
      CAPTURE: capture,
      EXPLICIT: "$literal",
      AMBIENT_SECRET: "must-not-inherit",
      NODE_REPL_AUTH_TOKEN: "must-not-inherit",
      ...(fixture.kind === "packaged" && fixture.codex ? { CODEX_CLI_PATH: fixture.codex } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const messages: Message[] = [];
  const stopReader = attachJsonlLineReader(child.stdout, (line) => {
    messages.push(JSON.parse(line));
  });
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code))
  );
  owned.push(async () => {
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 7000);
    await exited;
    clearTimeout(kill);
    stopReader();
  });
  const send = (message: Message & { params?: unknown }) =>
    child.stdin.write(serializeJsonLine({ jsonrpc: "2.0", ...message }));
  const response = async (id: string | number) => {
    return waitFor(() => messages.find((message) => message.id === id));
  };
  send({ id: "init", method: "initialize", params: {} });
  await response("init");
  return {
    bridge,
    path,
    events,
    elicitations,
    child,
    send,
    response,
    messages,
    capture,
    exited,
    stderr: () => stderr,
  };
}

describe("Desktop node_repl metadata proxy", () => {
  it("uses actual GUI scope, preserves rich replies and strips ambient credentials from the native host", async () => {
    const run = await start();
    run.send({ id: "idle", method: "tools/call", params: { name: "js", arguments: {} } });
    expect(await run.response("idle")).toMatchObject({
      error: { message: expect.stringContaining("active GUI turn") },
    });
    run.bridge.beginTurn("gui-thread", "turn-1");
    run.send({
      id: 2,
      method: "tools/call",
      params: {
        name: "js",
        arguments: { code: "opaque $value", threadId: "application-thread" },
        _meta: {
          arbitrary: true,
          threadId: "forged",
          "x-codex-turn-metadata": { session_id: "forged" },
        },
      },
    });
    const reply = await run.response(2);
    expect(reply).toMatchObject({
      result: {
        structuredContent: {
          args: { code: "opaque $value", threadId: "application-thread" },
          requestMeta: {
            arbitrary: true,
            threadId: "gui-thread",
            "x-codex-turn-metadata": {
              session_id: "gui-thread",
              thread_id: "gui-thread",
              turn_id: "turn-1",
              thread_source: "user",
            },
          },
          env: { EXPLICIT: "$literal" },
          clientCapabilities: { elicitation: { form: {}, url: {} } },
        },
        _meta: { "openai/outputTemplate": "ui://test/widget", threadId: "opaque-app-thread" },
      },
    });
    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain("must-not-inherit");
    expect(serialized).not.toContain("CODAPTER_DESKTOP_");
    expect(run.events.map((event) => event.phase)).toEqual(["started", "completed"]);
    expect(run.events[1].result).toEqual(reply?.result);
    run.bridge.cancelTurn("done", "Stop");
    await expect.poll(() => readFile(run.capture, "utf8")).toContain("Stop");
    expect(JSON.parse((await readFile(run.capture, "utf8")).trim())).toEqual({
      hook_event_name: "Stop",
      session_id: "gui-thread",
      turn_id: "turn-1",
    });
    run.send({ id: "barrier", method: "ping" });
    await run.response("barrier");
    expect(run.messages.some((message) => String(message.id).startsWith("codapter_hook_"))).toBe(
      false
    );
    expect(run.stderr()).toBe("");
  });

  it("passes cancellation while a call is outstanding and refreshes scope for the next turn", async () => {
    const run = await start();
    run.bridge.beginTurn("gui-thread", "turn-1");
    run.send({ id: "hang", method: "tools/call", params: { name: "hang", arguments: {} } });
    await waitFor(() =>
      run.messages.find((message) => message.method === "notifications/progress")
    );
    run.bridge.cancelTurn("interrupted");
    run.send({ method: "notifications/cancelled", params: { requestId: "hang" } });
    expect(await run.response("hang")).toMatchObject({ error: { code: -32800 } });
    run.bridge.beginTurn("gui-thread", "turn-2");
    run.send({ id: "next", method: "tools/call", params: { name: "js", arguments: {} } });
    expect(await run.response("next")).toMatchObject({
      result: {
        structuredContent: { requestMeta: { "x-codex-turn-metadata": { turn_id: "turn-2" } } },
      },
    });
    expect(
      run.events.filter((event) => event.turnId === "turn-1").map((event) => event.phase)
    ).toEqual(["started", "completed"]);
    expect(run.events[1].error).toMatchObject({ code: -32800 });
    await expect.poll(() => readFile(run.capture, "utf8")).toContain("Interrupt");
    expect(run.stderr()).toBe("");
  });

  it("completes raw calls when the host crashes instead of leaving a running GUI item", async () => {
    const run = await start();
    run.bridge.beginTurn("gui-thread", "turn-crash");
    run.send({ id: "crash", method: "tools/call", params: { name: "crash", arguments: {} } });
    expect(await run.exited).toBe(1);
    expect(run.events.map((event) => event.phase)).toEqual(["started", "completed"]);
    expect(run.events[1].error).toMatchObject({ message: "Desktop MCP host disconnected" });
    expect(run.stderr()).toContain("Desktop MCP host exited (17)");
  });

  it("routes real permission decisions and cancellation to the MCP host without involving Pi's unsupported handler", async () => {
    const run = await start();
    run.bridge.beginTurn("gui-thread", "turn-permission");
    run.send({ id: "ask", method: "tools/call", params: { name: "permission", arguments: {} } });
    const request = await waitFor(() => run.elicitations[0]);
    expect(request).toMatchObject({
      threadId: "gui-thread",
      turnId: "turn-permission",
      serverName: "node_repl",
      request: {
        mode: "form",
        requestedSchema: { type: "object", properties: { note: { type: "string" } } },
        _meta: { app: { threadId: "opaque-application-id" } },
      },
    });
    expect(run.messages.some((message) => message.method === "elicitation/create")).toBe(false);
    const result = {
      action: "accept",
      content: { note: "user answer" },
      _meta: { decision: "user" },
    };
    expect(run.bridge.resolve(request.requestId, { result })).toBe(true);
    expect(await run.response("ask")).toMatchObject({
      result: { structuredContent: { id: "permission-ask", result } },
    });
    run.send({ id: "cancel", method: "tools/call", params: { name: "permission", arguments: {} } });
    const cancelled = await waitFor(() => run.elicitations[1]);
    run.bridge.cancelTurn("interrupted");
    expect(await run.response("cancel")).toMatchObject({
      result: { structuredContent: { error: { code: -32800 } } },
    });
    expect(run.bridge.resolve(cancelled.requestId, { result })).toBe(false);
    expect(run.stderr()).toBe("");
  });

  it("interrupts browser resources on EOF and hard-stops a stubborn owned host", async () => {
    const run = await start({ kind: "ordinary", stubborn: true });
    run.bridge.beginTurn("gui-thread", "turn-close");
    run.send({ id: "pid", method: "tools/call", params: { name: "js", arguments: {} } });
    const reply = await run.response("pid");
    const result = reply?.result as { structuredContent: { pid: number } };
    run.child.stdin.end();
    expect(await run.exited).toBe(0);
    expect(() => process.kill(result.structuredContent.pid, 0)).toThrow();
    expect(JSON.parse((await readFile(run.capture, "utf8")).trim())).toEqual({
      hook_event_name: "Interrupt",
      session_id: "gui-thread",
      turn_id: "turn-close",
    });
    expect(run.stderr()).toBe("");
  });

  it.each([true, false])(
    "binds private auth and sandbox endpoints with a configured CLI override: %s",
    async (includeCliPath) => {
      const packageRoot = await mkdtemp(join(root, "packaged-"));
      owned.push(() => rm(packageRoot, { recursive: true, force: true }));
      const resources = join(packageRoot, "resources");
      const command = join(resources, "cua_node", "bin", "node_repl");
      const codex = join(resources, "codex");
      await mkdir(dirname(command), { recursive: true });
      await copyFile(
        fileURLToPath(new URL("fixtures/desktop-packaged-host.mjs", import.meta.url)),
        command
      );
      await copyFile(
        fileURLToPath(new URL("fixtures/desktop-packaged-sandbox.mjs", import.meta.url)),
        codex
      );
      await Promise.all([chmod(command, 0o755), chmod(codex, 0o755)]);
      const run = await start({ kind: "packaged", command, ...(includeCliPath ? { codex } : {}) });
      const token = "controlled-native-provider-token";
      let reads = 0;
      const provider = new DesktopAuthProviderClient(run.path, async (name) => {
        expect(name).toBe("openai-codex");
        reads += 1;
        return { auth: { apiKey: token } };
      });
      owned.push(async () => provider.dispose());
      await provider.start();
      run.bridge.beginTurn("gui-thread", "turn-host-services");
      run.send({
        id: "host-services",
        method: "tools/call",
        params: { name: "auth-and-sandbox", arguments: {} },
      });
      const reply = await run.response("host-services");
      expect(reply).toMatchObject({
        result: {
          structuredContent: {
            auth: { authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true },
            sandbox: {
              argv: ["sandbox", "--policy", "fixture-policy", "--", "opaque argument"],
              envKeys: [],
            },
            helperEnvKeys: [],
          },
        },
      });
      const result = reply?.result as { structuredContent: { helper: string } };
      const helper = result.structuredContent.helper;
      expect(dirname(helper)).toBe(dirname(run.path));
      expect(helper).toMatch(/\/host-[a-f0-9-]+\.mjs$/);
      expect((await stat(helper)).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(helper))).mode & 0o777).toBe(0o700);
      const launcher = await readFile(helper, "utf8");
      expect(launcher).toContain(JSON.stringify(run.path));
      expect(launcher).toContain(JSON.stringify(codex));
      expect(launcher).not.toContain(token);
      expect(reads).toBe(1);
      run.child.stdin.end();
      expect(await run.exited).toBe(0);
      await expect(stat(helper)).rejects.toMatchObject({ code: "ENOENT" });
      // Keep the bridge alive: removal must belong to the proxy, not directory teardown.
      expect((await stat(run.path)).isSocket()).toBe(true);
      expect(run.stderr()).toBe("");
    }
  );
});
