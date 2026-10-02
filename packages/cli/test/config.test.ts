import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { extractCodexConfig, isDesktopConfigOverride, parseBackendOptions } from "../src/config.js";
import { parseListenTargets, resolveCollabExtensionPath } from "../src/index.js";

describe("parseListenTargets", () => {
  it("collects repeated listen flags", () => {
    expect(
      parseListenTargets(["--listen", "ws://127.0.0.1:8080", "--listen=unix:///tmp/codapter.sock"])
    ).toEqual({
      listenTargets: ["ws://127.0.0.1:8080", "unix:///tmp/codapter.sock"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("accepts stdio as a listen target", () => {
    expect(parseListenTargets(["--listen", "stdio"])).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("accepts stdio alongside other listen targets", () => {
    expect(parseListenTargets(["--listen", "stdio", "--listen", "ws://127.0.0.1:8080"])).toEqual({
      listenTargets: ["stdio", "ws://127.0.0.1:8080"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("falls back to CODAPTER_LISTEN when no explicit listen flags are present", () => {
    expect(
      parseListenTargets([], { CODAPTER_LISTEN: "ws://127.0.0.1:8080, unix:///tmp/codapter.sock" })
    ).toEqual({
      listenTargets: ["ws://127.0.0.1:8080", "unix:///tmp/codapter.sock"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("parses --collab alongside listen targets", () => {
    expect(parseListenTargets(["--collab", "--listen", "stdio"])).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: true,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("enables collab via CODAPTER_COLLAB", () => {
    expect(parseListenTargets(["--listen", "stdio"], { CODAPTER_COLLAB: "1" })).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: true,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("treats falsy CODAPTER_COLLAB values as disabled", () => {
    expect(parseListenTargets(["--listen", "stdio"], { CODAPTER_COLLAB: "0" })).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });
});

describe("resolveCollabExtensionPath", () => {
  it("uses CODAPTER_COLLAB_EXTENSION_PATH when provided", () => {
    expect(
      resolveCollabExtensionPath({
        CODAPTER_COLLAB_EXTENSION_PATH: "/tmp/collab-extension/dist/index.js",
      })
    ).toBe("/tmp/collab-extension/dist/index.js");
  });

  it("falls back to the repo-built extension path", () => {
    expect(resolveCollabExtensionPath({})).toContain("/packages/collab-extension/dist/index.js");
  });
});

describe("native config overrides", () => {
  it("accepts quoted and legacy unquoted plugin ids, preserving raw TOML for Codex", () => {
    const arguments_ = [
      'plugins."browser.tools@bundled".enabled=true',
      "plugins.browser@bundled.enabled=false",
      "plugins.'code-review@bundled'.enabled=true",
      'mcp_servers.local.http_headers={Authorization="Bearer token=private"}',
      "model_reasoning_effort=low",
      'browser_use.origins={"https://fixture.test"={access="deny"}}',
      'application.network.domains=["fixture.test"]',
    ];
    const parsed = extractCodexConfig([
      "-c",
      arguments_[0],
      "app-server",
      ...arguments_.slice(1).flatMap((argument) => ["--config", argument]),
    ]);
    expect(parsed.args).toEqual(["app-server"]);
    expect(parsed.overrides.map(({ argument }) => argument)).toEqual(arguments_);
    expect(parsed.overrides.map(isDesktopConfigOverride)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
    ]);
    expect(parseBackendOptions({}, false, new PassThrough(), parsed.overrides).codex?.args).toEqual(
      [...arguments_.flatMap((argument) => ["-c", argument]), "app-server"]
    );
  });

  it("resolves source-run desktop assets from compiled backend siblings, independently of collab", () => {
    const options = parseBackendOptions({}, false, new PassThrough());
    expect(options.pi).toEqual({
      desktopExtensionPath: expect.stringMatching(
        /\/packages\/backend-pi\/dist\/desktop-extension\/index\.js$/
      ),
      desktopMcpProxyPath: expect.stringMatching(
        /\/packages\/backend-pi\/dist\/desktop-mcp-proxy\.js$/
      ),
    });
    expect(
      parseBackendOptions({ CODAPTER_PI_DISABLE: "1" }, true, new PassThrough()).pi
    ).toBeNull();
  });
});
