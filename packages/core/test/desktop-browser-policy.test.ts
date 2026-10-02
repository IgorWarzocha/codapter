import { describe, expect, it } from "vitest";
import {
  hasCompleteBrowserOverrides,
  resumeBrowserConfig,
  threadBrowserOverrides,
} from "../src/desktop-browser-policy.js";

describe("Browser resume overrides", () => {
  it("retains only Browser roots on partial resume and normalizes nested/quoted paths", () => {
    const previous = {
      browser_use: { allow_history_access: false },
      'browser_use.origins."https://example.test".access': "deny",
      application: { enabled: false },
      "mcp_servers.secret": { env: { TOKEN: "DO_NOT_PERSIST" } },
    };
    const requested = {
      "features.apps": true,
      browser_use: { origins: { "https://example.test": { downloads: "deny" } } },
    };
    expect(resumeBrowserConfig(previous, requested)).toEqual({
      "features.apps": true,
      browser_use: {
        allow_history_access: false,
        origins: { "https://example.test": { access: "deny", downloads: "deny" } },
      },
      application: { enabled: false },
    });
    expect(
      resumeBrowserConfig(previous, {
        'browser_use.origins."https://example.test".access': "allow",
      })
    ).toMatchObject({
      browser_use: { origins: { "https://example.test": { access: "allow" } } },
    });
    expect(previous.browser_use).toEqual({ allow_history_access: false });
    expect(resumeBrowserConfig(previous, null)).toEqual(previous);
    expect(resumeBrowserConfig(previous, { browser_use: null })).toEqual({
      browser_use: null,
      application: { enabled: false },
    });
    expect(resumeBrowserConfig(null, { "features.apps": true })).toEqual({ "features.apps": true });
  });

  it("keeps profile verification policy without retaining profile credentials", () => {
    expect(
      resumeBrowserConfig(
        {
          profile: "selected",
          "profiles.selected.browser_use.default_origin_policy.access": "deny",
          profiles: {
            selected: { mcp_servers: { secret: { env: { TOKEN: "DO_NOT_PERSIST" } } } },
            model_only: { model: "ignore" },
          },
        },
        { "features.apps": true }
      )
    ).toEqual({
      "features.apps": true,
      profile: "selected",
      profiles: {
        selected: { browser_use: { default_origin_policy: { access: "deny" } } },
        model_only: {},
      },
    });
    expect(resumeBrowserConfig({ profile: "invalid", profiles: "DO_NOT_PERSIST" }, {})).toEqual({
      profile: "invalid",
      profiles: null,
    });
  });

  it("persists only understood policy and profile verification metadata", () => {
    const source = {
      'browser_use.origins."https://example.test".access': "deny",
      "browser_use.allow_history_access": false,
      "application.network.enabled": true,
      'application.network.domains."example.test"': "deny",
      profile: "selected",
      profiles: {
        selected: {
          browser_use: { arbitrary: "DO_NOT_PERSIST" },
          mcp_servers: { secret: { env: { TOKEN: "DO_NOT_PERSIST" } } },
        },
        model_only: { model: "DO_NOT_PERSIST" },
      },
      mcp_servers: { secret: { env: { TOKEN: "DO_NOT_PERSIST" } } },
      developerInstructions: "DO_NOT_PERSIST",
    };
    expect(threadBrowserOverrides(source)).toEqual({
      browser_use: {
        allow_history_access: false,
        origins: { "https://example.test": { access: "deny" } },
      },
      application: { network: { enabled: true, domains: { "example.test": "deny" } } },
      profile: "selected",
      profiles: { selected: { browser_use: {} }, model_only: {} },
    });
    expect(threadBrowserOverrides({ browser_use: null, application: null, profile: null })).toEqual(
      {
        browser_use: null,
        application: null,
        profile: null,
      }
    );
    for (const invalid of [
      { browser_use: { env: { TOKEN: "DO_NOT_PERSIST" } } },
      { browser_use: { allow_history_access: "DO_NOT_PERSIST" } },
      { browser_use: { default_origin_policy: { access: "DO_NOT_PERSIST" } } },
      { application: { network: { domains: { "example.test": "DO_NOT_PERSIST" } } } },
      { application: { network: { env: { TOKEN: "DO_NOT_PERSIST" } } } },
    ]) {
      expect(() => threadBrowserOverrides(invalid)).toThrow();
    }
    expect(hasCompleteBrowserOverrides({ "features.apps": true })).toBe(false);
    expect(
      hasCompleteBrowserOverrides({ browser_use: null, application: null, profile: null })
    ).toBe(true);
  });

  it("rejects unsafe path/value keys without exposing override contents", () => {
    expect(() => resumeBrowserConfig(null, { "browser_use.__proto__.access": "SECRET" })).toThrow(
      "Invalid configuration key"
    );
    expect(() =>
      resumeBrowserConfig(null, {
        browser_use: JSON.parse('{"constructor":"SECRET"}'),
      })
    ).toThrow("Invalid configuration key");
    expect(Object.prototype).not.toHaveProperty("access");
  });
});
