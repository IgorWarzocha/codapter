import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopAuthBridge } from "../src/desktop-auth.js";
import {
  BROWSER_POLICY_UNAVAILABLE,
  readDesktopBrowserPolicy,
} from "../src/desktop-browser-policy.js";
import { DesktopAuthProviderClient } from "../src/desktop-extension/auth-client.js";
import { runDesktopHostServices } from "../src/desktop-host-services.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("relays actual policy through helper stdio without caller cwd rescoping or exposing native credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "codapter-policy-helper-"));
  const path = join(root, "rpc.sock");
  const auth = new DesktopAuthBridge();
  let plan = "plus";
  let managed = false;
  const providerReads = vi.fn(async () => ({
    auth: {
      apiKey: `header.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_plan_type: plan },
        })
      ).toString("base64url")}.private-signature`,
    },
  }));
  const inspectPath = vi.fn(async () => {
    if (managed) return {};
    throw Object.assign(new Error("private-device-data"), { code: "ENOENT" });
  });
  const config = {
    browser_use: { origins: { "https://associated-thread.test": { access: "deny" } } },
    application: { network: { domains: ["associated-thread.test"] } },
  };
  const frames: unknown[] = [];
  const sockets = new Set<Socket>();
  // Controlled private endpoint with the real policy and provider owners.
  // Device lookup is injected so this regression cannot rely on the test host's policy state.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const stop = attachJsonlLineReader(socket, (line) => {
      const request = JSON.parse(line);
      if (auth.handle(socket, request)) return;
      frames.push(request);
      void readDesktopBrowserPolicy({ browserConfig: { config } }, () => auth.read(false), {
        platform: "linux",
        inspectPath,
      }).then(
        (result) => socket.write(serializeJsonLine({ jsonrpc: "2.0", id: request.id, result })),
        () =>
          socket.write(
            serializeJsonLine({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: BROWSER_POLICY_UNAVAILABLE },
            })
          )
      );
    });
    socket.once("close", () => {
      stop();
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    auth.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const provider = new DesktopAuthProviderClient(path, providerReads);
  cleanup.push(async () => provider.dispose());
  await provider.start();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const controller = new AbortController();
  const done = runDesktopHostServices({ path, stdin, stdout, signal: controller.signal });
  const waiters = new Map<number, (value: unknown) => void>();
  const stop = attachJsonlLineReader(stdout, (line) => {
    const value = JSON.parse(line);
    waiters.get(value.id)?.(value);
    waiters.delete(value.id);
  });
  cleanup.push(async () => {
    controller.abort();
    stdin.end();
    await done;
    stop();
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) => {
    const next = ++id;
    const received = new Promise<unknown>((resolve) => waiters.set(next, resolve));
    stdin.write(serializeJsonLine({ id: next, method, params }));
    return received;
  };
  await request("initialize");
  const read = await request("config/read", { includeLayers: true, cwd: "/different-project" });
  expect(read).toMatchObject({ result: { config, origins: {}, layers: null } });
  expect(await request("configRequirements/read")).toMatchObject({
    result: { requirements: null },
  });
  expect(providerReads).toHaveBeenCalledTimes(2);
  expect(inspectPath).toHaveBeenCalledTimes(4);
  expect(frames).toEqual([
    { jsonrpc: "2.0", id: expect.any(String), method: "desktop/browser-policy/read", params: {} },
    { jsonrpc: "2.0", id: expect.any(String), method: "desktop/browser-policy/read", params: {} },
  ]);
  expect(JSON.stringify(read)).not.toContain("private-signature");
  for (const [method, params] of [
    ["config/read", { cwd: 3 }],
    ["config/read", { includeLayers: "private-token" }],
    ["config/read", { config: { browser_use: null } }],
    ["configRequirements/read", { cwd: "/different-project" }],
  ] as const) {
    expect(await request(method, params)).toMatchObject({ error: { code: -32602 } });
  }
  expect(providerReads).toHaveBeenCalledTimes(2);
  plan = "enterprise";
  expect(await request("configRequirements/read")).toMatchObject({
    error: {
      code: -32000,
      message: BROWSER_POLICY_UNAVAILABLE,
    },
  });
  plan = "plus";
  managed = true;
  expect(await request("config/read")).toMatchObject({
    error: {
      code: -32000,
      message: BROWSER_POLICY_UNAVAILABLE,
    },
  });
  expect(providerReads).toHaveBeenCalledTimes(4);
});
