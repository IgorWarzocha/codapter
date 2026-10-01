import { describe, expect, it } from "vitest";
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
