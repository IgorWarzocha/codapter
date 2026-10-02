import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthBridge, parseDesktopAuthStatus } from "../src/desktop-auth.js";
import { DesktopBridge } from "../src/desktop-bridge.js";
import {
  DesktopAuthProviderClient,
  type NativeProviderAuthResolver,
  resolveDesktopAuth,
} from "../src/desktop-extension/auth-client.js";
import { desktopRequest } from "../src/desktop-extension/client.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(resolve: NativeProviderAuthResolver, timeout = 60_000) {
  const bridge = new DesktopBridge(undefined, () => {});
  const path = await bridge.start();
  cleanup.push(() => bridge.dispose());
  const client = new DesktopAuthProviderClient(path, resolve, timeout);
  cleanup.push(async () => client.dispose());
  await client.start();
  return { bridge, client, path };
}

async function rawProvider(timeout = 1000) {
  const directory = await mkdtemp(join(tmpdir(), "codapter-auth-test-"));
  const path = join(directory, "rpc.sock");
  const auth = new DesktopAuthBridge(timeout);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const stop = attachJsonlLineReader(socket, (line) => auth.handle(socket, JSON.parse(line)));
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
    await rm(directory, { recursive: true, force: true });
  });
  const provider = createConnection(path);
  provider.on("error", () => {});
  await once(provider, "connect");
  const registered = once(provider, "data");
  provider.write(
    serializeJsonLine({
      jsonrpc: "2.0",
      id: "registration",
      method: "desktop/auth/provider",
      params: { provider: "openai-codex" },
    })
  );
  await registered;
  cleanup.push(async () => provider.destroy());
  return { auth, provider, path };
}

describe("native Desktop authentication", () => {
  it("uses live Pi provider auth for every read, with no token on metadata reads", async () => {
    let token = "first-private-token";
    const resolve = vi.fn(async (provider) => {
      expect(provider).toBe("openai-codex");
      return { auth: { apiKey: token } };
    });
    const f = await setup(resolve);
    expect(resolve).not.toHaveBeenCalled();
    await f.client.start();
    const metadata = await desktopRequest(f.path, "desktop/auth/read", { includeToken: false });
    expect(metadata).toEqual({
      authMethod: "chatgpt",
      authToken: null,
      account: null,
      planType: "unknown",
    });
    expect(JSON.stringify(metadata)).not.toContain(token);
    token = "rotated-private-token";
    expect(await desktopRequest(f.path, "desktop/auth/read", { includeToken: true })).toEqual({
      authMethod: "chatgpt",
      authToken: token,
      account: null,
      planType: "unknown",
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("decodes only in-memory account display metadata and accepts native bearer headers", async () => {
    const payload = {
      "https://api.openai.com/profile": { email: "fixture@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "edu_pro",
        chatgpt_account_id: "not-exported",
      },
    };
    const token = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
    const resolve = vi.fn(async () => ({
      auth: { headers: { AUTHORIZATION: `Bearer ${token}` } },
    }));
    expect(await resolveDesktopAuth(resolve, false)).toEqual({
      authMethod: "chatgpt",
      authToken: null,
      account: { type: "chatgpt", email: "fixture@example.test", planType: "edu_pro" },
      planType: "edu_pro",
    });
    expect(await resolveDesktopAuth(async () => undefined, true)).toEqual({
      authMethod: null,
      authToken: null,
      account: null,
      planType: "unknown",
    });
    expect(
      parseDesktopAuthStatus(
        {
          authMethod: "chatgpt",
          authToken: token,
          account: null,
          headers: { Authorization: token },
        },
        false
      )
    ).toEqual({ authMethod: "chatgpt", authToken: null, account: null, planType: "unknown" });
  });

  it("retains the native plan without requiring an email or exposing the bearer", async () => {
    const token = `header.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      })
    ).toString("base64url")}.signature`;
    const f = await setup(async () => ({ auth: { apiKey: token } }));
    expect(await desktopRequest(f.path, "desktop/auth/read", { includeToken: false })).toEqual({
      authMethod: "chatgpt",
      authToken: null,
      account: null,
      planType: "plus",
    });
  });

  it("correlates concurrent requests despite reversed native completion", async () => {
    const resolvers: ((value: { auth: { apiKey: string } }) => void)[] = [];
    let received: () => void = () => {};
    const both = new Promise<void>((resolve) => {
      received = resolve;
    });
    const f = await setup(
      async () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
          if (resolvers.length === 2) received();
        })
    );
    const first = desktopRequest(f.path, "desktop/auth/read", { includeToken: true });
    const second = desktopRequest(f.path, "desktop/auth/read", { includeToken: false });
    await both;
    const last = resolvers[1];
    const start = resolvers[0];
    if (!last || !start) throw new Error("Missing native auth resolver");
    last({ auth: { apiKey: "second-private-token" } });
    start({ auth: { apiKey: "first-private-token" } });
    expect(await first).toMatchObject({ authToken: "first-private-token" });
    expect(await second).toMatchObject({ authToken: null });
  });

  it("sanitizes provider failures and never falls back to credential files", async () => {
    const f = await setup(async () => {
      throw new Error("Bearer private-provider-token");
    });
    await expect(
      desktopRequest(f.path, "desktop/auth/read", { includeToken: true })
    ).rejects.toThrow(/^Native Pi authentication is unavailable$/);
    f.client.dispose();
    await expect(
      desktopRequest(f.path, "desktop/auth/read", { includeToken: true })
    ).rejects.toThrow(/^Native Pi authentication is unavailable$/);
  });

  it("bounds native provider resolution even when the Pi auth getter never settles", async () => {
    const f = await setup(async () => new Promise<undefined>(() => {}), 100);
    await expect(
      desktopRequest(f.path, "desktop/auth/read", { includeToken: true })
    ).rejects.toThrow(/^Native Pi authentication is unavailable$/);
  });

  it.each(["disconnect", "dispose", "abort", "timeout"])(
    "cancels pending native reads on %s and ignores late responses",
    async (event) => {
      const f = await rawProvider(event === "timeout" ? 20 : 1000);
      const incoming = once(f.provider, "data");
      const controller = new AbortController();
      const result = f.auth.read(true, controller.signal);
      const rejected = expect(result).rejects.toThrow(/disconnected|cancelled|timed out/);
      const [data] = await incoming;
      const request = JSON.parse(data.toString());
      if (event === "disconnect") f.provider.destroy();
      else if (event === "dispose") f.auth.dispose();
      else if (event === "abort") controller.abort();
      await rejected;
      if (!f.provider.destroyed)
        f.provider.write(
          serializeJsonLine({
            jsonrpc: "2.0",
            id: request.id,
            result: { authMethod: "chatgpt", authToken: "late-token", account: null },
          })
        );
    }
  );

  it("replaces a disconnected provider without delivering old native completions", async () => {
    const f = await rawProvider();
    const incoming = once(f.provider, "data");
    const pending = f.auth.read(true);
    const rejected = expect(pending).rejects.toThrow("disconnected");
    await incoming;
    const client = new DesktopAuthProviderClient(f.path, async () => ({
      auth: { apiKey: "new-token" },
    }));
    cleanup.push(async () => client.dispose());
    await client.start();
    await rejected;
    expect(await f.auth.read(true)).toMatchObject({ authToken: "new-token" });
  });
});
