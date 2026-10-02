import { lstat } from "node:fs/promises";
import type { DesktopSessionCapabilities } from "@codapter/core";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopBridge } from "../src/desktop-bridge.js";
import { BROWSER_POLICY_UNAVAILABLE } from "../src/desktop-browser-policy.js";
import { DesktopAuthProviderClient } from "../src/desktop-extension/auth-client.js";
import { desktopRequest } from "../src/desktop-extension/client.js";
import { waitFor } from "./pi-fixture.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  lstat: vi.fn(async () => {
    throw Object.assign(new Error("private-device-data"), { code: "ENOENT" });
  }),
}));

vi.mock("../src/desktop-browser-policy.js", async (original) => {
  const policy = await original<typeof import("../src/desktop-browser-policy.js")>();
  return {
    ...policy,
    // Exercise the real evaluator with controlled device sources on every test host.
    readDesktopBrowserPolicy: (...args: Parameters<typeof policy.readDesktopBrowserPolicy>) =>
      policy.readDesktopBrowserPolicy(args[0], args[1], { platform: "linux" }),
  };
});

const snapshot: DesktopSessionCapabilities = {
  tools: [],
  mcpServers: {},
  instructions: [],
  browserConfig: {
    config: {
      browser_use: { origins: { "https://associated-thread.test": { access: "deny" } } },
      application: { network: { domains: ["associated-thread.test"] } },
    },
  },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.mocked(lstat).mockClear();
  vi.mocked(lstat).mockImplementation(async () => {
    throw Object.assign(new Error("private-device-data"), { code: "ENOENT" });
  });
});

async function setup(capabilities = snapshot) {
  const bridge = new DesktopBridge(capabilities, () => {});
  cleanup.push(() => bridge.dispose());
  const path = await bridge.start();
  let plan = "plus";
  const providerReads = vi.fn(async () => ({
    auth: {
      apiKey: `header.${Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } })
      ).toString("base64url")}.private-signature`,
    },
  }));
  const provider = new DesktopAuthProviderClient(path, providerReads);
  cleanup.push(async () => provider.dispose());
  await provider.start();
  const read = (params: unknown = {}) =>
    desktopRequest(path, "desktop/browser-policy/read", params);
  return {
    bridge,
    path,
    read,
    providerReads,
    setPlan: (value: string) => {
      plan = value;
    },
  };
}

it("returns only the associated-thread policy and verifies current plan and managed sources on each private read", async () => {
  const { bridge, read, providerReads, setPlan } = await setup();
  expect(await read()).toEqual({ config: snapshot.browserConfig?.config, requirements: null });
  expect(JSON.stringify(await read())).not.toContain("private-signature");
  expect(providerReads).toHaveBeenCalledTimes(2);
  expect(vi.mocked(lstat).mock.calls.map(([path]) => path)).toEqual([
    "/etc/codex/requirements.toml",
    "/etc/codex/managed_config.toml",
    "/etc/codex/requirements.toml",
    "/etc/codex/managed_config.toml",
  ]);
  for (const params of [{ cwd: "/other-project" }, { config: {} }, null])
    await expect(read(params)).rejects.toThrow("Invalid Desktop Browser policy parameters");
  expect(providerReads).toHaveBeenCalledTimes(2);
  setPlan("enterprise");
  await expect(read()).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  setPlan("plus");
  vi.mocked(lstat).mockRejectedValueOnce(
    Object.assign(new Error("private-device-data"), { code: "EACCES" })
  );
  await expect(read()).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  bridge.refresh({ ...snapshot, browserConfig: { config: { browser_use: { enabled: false } } } });
  expect(await read()).toEqual({ config: { browser_use: { enabled: false } }, requirements: null });
});

it("rejects missing or unverifiable snapshots without reading native credentials", async () => {
  const { read, bridge, providerReads } = await setup({
    tools: [],
    mcpServers: {},
    instructions: [],
  });
  await expect(read()).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  bridge.refresh({ ...snapshot, browserConfig: { error: "private-config-data" } });
  await expect(read()).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  expect(providerReads).not.toHaveBeenCalled();
  expect(lstat).not.toHaveBeenCalled();
});

it("does not complete stale policy reads after refresh, helper disconnect or bridge disposal", async () => {
  const { bridge, path, read, providerReads } = await setup();
  let release: (() => void) | undefined;
  const delay = () =>
    providerReads.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        auth: {
          apiKey: `header.${Buffer.from(
            JSON.stringify({
              "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
            })
          ).toString("base64url")}.private-signature`,
        },
      };
    });
  delay();
  const stale = expect(read()).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  await waitFor(() => release);
  bridge.refresh({ ...snapshot, browserConfig: { config: {} } });
  release?.();
  await stale;
  release = undefined;
  delay();
  const abort = new AbortController();
  const cancelled = expect(
    desktopRequest(path, "desktop/browser-policy/read", {}, abort.signal)
  ).rejects.toThrow("Helper closed");
  await waitFor(() => release);
  abort.abort(new Error("Helper closed"));
  await cancelled;
  release?.();
  expect(await read()).toEqual({ config: {}, requirements: null });
  release = undefined;
  delay();
  const disconnected = expect(read()).rejects.toThrow();
  await waitFor(() => release);
  await bridge.dispose();
  await disconnected;
  release?.();
});
