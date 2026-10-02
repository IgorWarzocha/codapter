import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopBridge } from "../src/desktop-bridge.js";
import {
  DesktopAuthProviderClient,
  type NativeProviderAuthResolver,
} from "../src/desktop-extension/auth-client.js";
import { runDesktopHostServices } from "../src/desktop-host-services.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(resolve: NativeProviderAuthResolver, timeout = 1000) {
  const bridge = new DesktopBridge(undefined, () => {});
  const path = await bridge.start();
  cleanup.push(() => bridge.dispose());
  const provider = new DesktopAuthProviderClient(path, resolve);
  cleanup.push(async () => provider.dispose());
  await provider.start();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const controller = new AbortController();
  const done = runDesktopHostServices({
    path,
    stdin,
    stdout,
    signal: controller.signal,
    requestTimeoutMs: timeout,
  });
  const responses: Record<string, unknown>[] = [];
  const waiting = new Map<string | number | null, (message: Record<string, unknown>) => void>();
  const stop = attachJsonlLineReader(stdout, (line) => {
    const message = JSON.parse(line);
    responses.push(message);
    const waiter = waiting.get(message.id);
    if (waiter) {
      waiting.delete(message.id);
      waiter(message);
    }
  });
  cleanup.push(async () => {
    controller.abort();
    stdin.end();
    await done;
    stop();
  });
  let id = 0;
  const wait = (id: string | number | null) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
    });
  const request = (method: string, params: unknown = {}, versioned = false) => {
    const nextId = ++id;
    const response = wait(nextId);
    stdin.write(
      serializeJsonLine({
        ...(versioned ? { jsonrpc: "2.0" } : {}),
        id: nextId,
        method,
        params,
      })
    );
    return response;
  };
  return { bridge, provider, request, responses, wait, stdin, controller, done };
}

describe("NodeRepl host auth services", () => {
  it("serves native initialization and request-time auth without exposing tokens on metadata reads", async () => {
    let token = "first-private-token";
    const resolve = vi.fn(async () => ({ auth: { apiKey: token } }));
    const f = await setup(resolve);
    expect(await f.request("getAuthStatus")).toMatchObject({ error: { code: -32600 } });
    expect(resolve).not.toHaveBeenCalled();
    expect(
      await f.request("initialize", { clientInfo: { name: "node-repl", version: "1" } }, true)
    ).toMatchObject({
      jsonrpc: "2.0",
      result: {
        userAgent: expect.stringContaining("codapter/"),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      },
    });
    f.stdin.write(serializeJsonLine({ method: "initialized" }));
    const hidden = await f.request("getAuthStatus", { includeToken: false, refreshToken: true });
    expect(hidden).toMatchObject({
      result: {
        authMethod: "chatgpt",
        authToken: null,
        requiresOpenaiAuth: true,
      },
    });
    expect(JSON.stringify(hidden)).not.toContain(token);
    const account = await f.request("account/read");
    expect(account).toMatchObject({
      result: {
        account: null,
        requiresOpenaiAuth: true,
      },
    });
    expect(JSON.stringify(account)).not.toContain(token);
    token = "rotated-private-token";
    expect(await f.request("getAuthStatus", { includeToken: true }, true)).toMatchObject({
      jsonrpc: "2.0",
      result: {
        authMethod: "chatgpt",
        authToken: token,
        requiresOpenaiAuth: true,
      },
    });
    expect(resolve).toHaveBeenCalledTimes(3);
    f.stdin.end();
    await f.done;
    expect(f.responses).toHaveLength(5);
  });

  it("reports signed-out state and rejects all unsupported command, login and inference methods", async () => {
    const resolve = vi.fn(async () => undefined);
    const f = await setup(resolve);
    await f.request("initialize");
    expect(await f.request("getAuthStatus", { includeToken: true })).toMatchObject({
      result: { authMethod: null, authToken: null, requiresOpenaiAuth: true },
    });
    expect(await f.request("account/read")).toMatchObject({
      result: { account: null, requiresOpenaiAuth: true },
    });
    for (const method of [
      "thread/start",
      "turn/start",
      "account/login/start",
      "sandbox",
      "command/exec",
    ]) {
      expect(await f.request(method, { command: ["node", "private-token"] })).toMatchObject({
        error: { code: -32601, message: "Unsupported Desktop host service method" },
      });
    }
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.responses)).not.toContain("private-token");
  });

  it("validates and redacts malformed parameters and parse errors without native auth resolution", async () => {
    const resolve = vi.fn(async () => undefined);
    const f = await setup(resolve);
    await f.request("initialize");
    expect(await f.request("initialize")).toMatchObject({ error: { code: -32600 } });
    expect(await f.request("getAuthStatus", { includeToken: "private-token" })).toMatchObject({
      error: { code: -32602 },
    });
    expect(await f.request("account/read", { refreshToken: "private-token" })).toMatchObject({
      error: { code: -32602 },
    });
    const malformed = f.wait(null);
    f.stdin.write('{"private-token"\n');
    expect(await malformed).toMatchObject({
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(f.responses)).not.toContain("private-token");
  });

  it("does not stall other envelopes behind a pending native refresh and aborts without a late token reply", async () => {
    let started: () => void = () => {};
    let finish: (value: { auth: { apiKey: string } }) => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await setup(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        })
    );
    await f.request("initialize");
    void f.request("getAuthStatus", { includeToken: true });
    await entered;
    expect(await f.request("turn/start")).toMatchObject({ error: { code: -32601 } });
    f.controller.abort();
    await f.done;
    finish({ auth: { apiKey: "late-private-token" } });
    expect(f.responses).toHaveLength(2);
    expect(JSON.stringify(f.responses)).not.toContain("late-private-token");
  });

  it.each(["timeout", "provider failure", "provider disconnect"])(
    "fails visibly without leaking credentials on %s",
    async (failure) => {
      let started: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const f = await setup(async () => {
        started();
        if (failure === "provider failure") throw new Error("Bearer private-native-token");
        return await new Promise<undefined>(() => {});
      }, 20);
      await f.request("initialize");
      const reading = f.request("getAuthStatus", { includeToken: true });
      await entered;
      if (failure === "provider disconnect") f.provider.dispose();
      expect(await reading).toMatchObject({
        error: {
          code: -32000,
          message: "Native Pi authentication is unavailable",
        },
      });
      expect(JSON.stringify(f.responses)).not.toContain("private-native-token");
    }
  );

  it("never delegates other host commands to the native sandbox executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-host-dispatch-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const f = await setup(async () => undefined);
    const proxy = join(root, "desktop-mcp-proxy.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/desktop-mcp-proxy.ts", import.meta.url))],
      outfile: proxy,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      banner: {
        js: 'import { createRequire } from "node:module";const require = createRequire(import.meta.url);',
      },
    });
    const sandbox = join(root, "sandbox-fixture.cjs");
    const capture = join(root, "sandbox-args.json");
    await writeFile(
      sandbox,
      [
        `#!${process.execPath}`,
        `require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`,
      ].join("\n")
    );
    await chmod(sandbox, 0o755);
    const exec = promisify(execFile);
    const env = {
      ...process.env,
      CODAPTER_DESKTOP_UDS: await f.bridge.start(),
      CODAPTER_DESKTOP_SANDBOX_COMMAND: sandbox,
    };
    for (const args of [
      ["exec", "private-token"],
      ["login", "private-token"],
      ["app-server", "--listen", "ws://127.0.0.1:0"],
      ["app-server", "-c", "private-token"],
    ]) {
      await expect(exec(process.execPath, [proxy, ...args], { env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(
          /Unsupported Desktop host command|Desktop host services only support stdio/
        ),
      });
      await expect(stat(capture)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await exec(process.execPath, [proxy, "sandbox", "--policy", "literal argument"], { env });
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual([
      "sandbox",
      "--policy",
      "literal argument",
    ]);
  });
});
