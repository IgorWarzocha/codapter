import type { DesktopSessionCapabilities } from "@codapter/core";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAuthStatus } from "../src/desktop-auth.js";
import {
  BROWSER_POLICY_UNAVAILABLE,
  readDesktopBrowserPolicy,
} from "../src/desktop-browser-policy.js";

const snapshot = {
  browserConfig: {
    config: {
      browser_use: { origins: { "https://fixture.test": { access: "deny" } } },
      application: { network: { domains: ["fixture.test"] } },
    },
  },
} satisfies Pick<DesktopSessionCapabilities, "browserConfig">;
const auth = (planType: string): DesktopAuthStatus => ({
  authMethod: "chatgpt",
  authToken: null,
  account: null,
  planType,
});
const absent = async () => {
  throw Object.assign(new Error("private-device-data"), { code: "ENOENT" });
};

describe("Desktop Browser policy boundary", () => {
  it.each(["free", "go", "plus", "pro", "prolite", "promax", "team"])(
    "returns actual selected config and verified absent requirements for native %s plan",
    async (plan) => {
      const readAuth = vi.fn(async () => auth(plan));
      const inspectPath = vi.fn(absent);
      const result = await readDesktopBrowserPolicy(snapshot, readAuth, {
        platform: "linux",
        inspectPath,
      });
      expect(result).toEqual({ config: snapshot.browserConfig.config, requirements: null });
      expect(result.config).not.toBe(snapshot.browserConfig.config);
      expect(readAuth).toHaveBeenCalledOnce();
      expect(inspectPath.mock.calls).toEqual([
        ["/etc/codex/requirements.toml"],
        ["/etc/codex/managed_config.toml"],
      ]);
    }
  );

  it.each([
    "unknown",
    "business",
    "ent26",
    "enterprise",
    "enterprise_cbp_automation",
    "enterprise_cbp_usage_based",
    "self_serve_business_prolite",
    "self_serve_business_usage_based",
    "edu",
    "edu_plus",
    "edu_pro",
    "Plus",
    "future-plan",
  ])(
    "rejects unsupported or cloud-eligible native plan %s rather than pretending no requirements",
    async (plan) => {
      await expect(
        readDesktopBrowserPolicy(snapshot, async () => auth(plan), {
          platform: "linux",
          inspectPath: absent,
        })
      ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
    }
  );

  it.each(["requirements.toml", "managed_config.toml"])(
    "fails closed if %s exists, even when empty or a dangling link",
    async (file) => {
      await expect(
        readDesktopBrowserPolicy(snapshot, async () => auth("plus"), {
          platform: "linux",
          inspectPath: async (path) => (path.endsWith(file) ? {} : absent()),
        })
      ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
    }
  );

  it.each(["EACCES", "EPERM", "ENOTDIR", "EIO"])(
    "does not convert unreadable managed policy %s into null requirements",
    async (code) => {
      await expect(
        readDesktopBrowserPolicy(snapshot, async () => auth("plus"), {
          platform: "linux",
          inspectPath: async () => {
            throw Object.assign(new Error("private-device-data"), { code });
          },
        })
      ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
    }
  );

  it("uses ProgramData device paths on Windows and rejects macOS/unsupported device source checks", async () => {
    const inspectPath = vi.fn(absent);
    expect(
      await readDesktopBrowserPolicy(snapshot, async () => auth("plus"), {
        platform: "win32",
        programData: "C:\\ProgramData",
        inspectPath,
      })
    ).toEqual({ config: snapshot.browserConfig.config, requirements: null });
    expect(inspectPath.mock.calls).toEqual([
      ["C:\\ProgramData\\OpenAI\\Codex\\requirements.toml"],
      ["C:\\ProgramData\\OpenAI\\Codex\\managed_config.toml"],
    ]);
    for (const platform of ["darwin", "freebsd"] as const) {
      await expect(
        readDesktopBrowserPolicy(snapshot, async () => auth("plus"), {
          platform,
          inspectPath: absent,
        })
      ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
    }
    await expect(
      readDesktopBrowserPolicy(snapshot, async () => auth("plus"), {
        platform: "win32",
        programData: "relative",
        inspectPath: absent,
      })
    ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  });

  it("requires a verified core snapshot and current native plan on every request", async () => {
    const readAuth = vi.fn(async () => auth("plus"));
    for (const browserConfig of [undefined, { error: "private-config-data" }]) {
      await expect(
        readDesktopBrowserPolicy(browserConfig ? { browserConfig } : {}, readAuth, {
          platform: "linux",
          inspectPath: absent,
        })
      ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
    }
    expect(readAuth).not.toHaveBeenCalled();
    let current = auth("plus");
    const liveAuth = vi.fn(async () => current);
    expect(
      await readDesktopBrowserPolicy({ browserConfig: { config: {} } }, liveAuth, {
        platform: "linux",
        inspectPath: absent,
      })
    ).toEqual({ config: {}, requirements: null });
    current = auth("enterprise");
    await expect(
      readDesktopBrowserPolicy(snapshot, liveAuth, {
        platform: "linux",
        inspectPath: absent,
      })
    ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
    expect(liveAuth).toHaveBeenCalledTimes(2);
    await expect(
      readDesktopBrowserPolicy(
        snapshot,
        async () => {
          throw new Error("Bearer private-auth-data");
        },
        { platform: "linux", inspectPath: absent }
      )
    ).rejects.toThrow(BROWSER_POLICY_UNAVAILABLE);
  });
});
