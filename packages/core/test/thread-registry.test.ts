import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRegistry } from "../src/thread-registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), "codapter-thread-registry-"));
  tempDirs.push(directory);
  return new ThreadRegistry(join(directory, "threads.json"));
}

describe("ThreadRegistry", () => {
  it("sanitizes thread Browser overrides across create, update, and disk reload without masking unknown legacy state", async () => {
    const registry = await createRegistry();
    expect(
      (await registry.create({ backendSessionId: "unknown", backendType: "pi" })).browserOverrides
    ).toBeNull();
    expect(
      (
        await registry.create({
          backendSessionId: "known",
          backendType: "pi",
          browserOverrides: {},
        })
      ).browserOverrides
    ).toEqual({});
    const base = await registry.create({
      backendSessionId: "session",
      backendType: "pi",
      browserOverrides: {
        "browser_use.default_origin_policy.access": "deny",
        "browser_use.allow_history_access": false,
        profile: "selected",
        profiles: {
          selected: {
            model: "DO_NOT_PERSIST",
            mcp_servers: { secret: { env: { TOKEN: "DO_NOT_PERSIST" } } },
          },
        },
        mcp_servers: { secret: { env: { TOKEN: "DO_NOT_PERSIST" } } },
      },
    });
    expect(base.browserOverrides).toEqual({
      browser_use: { default_origin_policy: { access: "deny" }, allow_history_access: false },
      profile: "selected",
      profiles: { selected: {} },
    });
    expect(await readFile(registry.path, "utf8")).not.toContain("DO_NOT_PERSIST");
    const disk = new ThreadRegistry(registry.path);
    expect((await disk.get(base.threadId))?.browserOverrides).toEqual(base.browserOverrides);
    await disk.update(base.threadId, {
      browserOverrides: { browser_use: { allow_history_access: true }, model: "DO_NOT_PERSIST" },
    });
    expect((await new ThreadRegistry(registry.path).get(base.threadId))?.browserOverrides).toEqual({
      browser_use: { allow_history_access: true },
    });
    expect(await readFile(registry.path, "utf8")).not.toContain("DO_NOT_PERSIST");
    await writeFile(
      registry.path,
      JSON.stringify({
        threads: [
          { ...base, threadId: "legacy", browserOverrides: undefined },
          {
            ...base,
            threadId: "corrupt",
            browserOverrides: {
              browser_use: { default_origin_policy: { access: "DO_NOT_EXPOSE" } },
            },
          },
        ],
      })
    );
    const warn = vi.fn();
    const restored = new ThreadRegistry(registry.path, { warn });
    expect((await restored.get("legacy"))?.browserOverrides).toBeNull();
    expect(await restored.get("corrupt")).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("DO_NOT_EXPOSE");
    await restored.update("legacy", { name: "renamed" });
    expect((await new ThreadRegistry(registry.path).get("legacy"))?.browserOverrides).toBeNull();
  });

  it("restores disabled plugin lists, migrates missing lists, and isolates corrupt metadata", async () => {
    const registry = await createRegistry();
    const ids = ["browser@openai-bundled"];
    const base = await registry.create({
      backendSessionId: "session",
      backendType: "pi",
      disabledPluginIds: ids,
    });
    ids.push("not-in-store");
    expect(base.disabledPluginIds).toEqual(["browser@openai-bundled"]);
    await writeFile(
      registry.path,
      JSON.stringify({
        threads: [
          { ...base, threadId: "disabled" },
          { ...base, threadId: "legacy", disabledPluginIds: undefined },
          { ...base, threadId: "corrupt", disabledPluginIds: [123] },
        ],
      })
    );
    const warn = vi.fn();
    const restored = new ThreadRegistry(registry.path, { warn });
    expect((await restored.get("disabled"))?.disabledPluginIds).toEqual(["browser@openai-bundled"]);
    expect((await restored.get("legacy"))?.disabledPluginIds).toEqual([]);
    expect(await restored.get("corrupt")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    await restored.update("disabled", { disabledPluginIds: [] });
    expect((await new ThreadRegistry(registry.path).get("disabled"))?.disabledPluginIds).toEqual(
      []
    );
  });

  it("migrates legacy dynamic tools and rejects corrupt definitions without losing valid threads", async () => {
    const registry = await createRegistry();
    const base = await registry.create({ backendSessionId: "session", backendType: "pi" });
    const legacy = {
      name: "click",
      namespace: "gui",
      description: "Click",
      inputSchema: {},
      exposeToContext: false,
      authentication: "DO_NOT_COPY",
    };
    await writeFile(
      registry.path,
      JSON.stringify({
        threads: [
          { ...base, threadId: "legacy", dynamicTools: [legacy] },
          { ...base, threadId: "old", dynamicTools: undefined },
          { ...base, threadId: "corrupt", dynamicTools: [{ ...legacy, namespace: 12 }] },
        ],
      })
    );
    const warn = vi.fn();
    const restored = new ThreadRegistry(registry.path, { warn });
    expect((await restored.get("legacy"))?.dynamicTools).toEqual([
      {
        type: "namespace",
        name: "gui",
        description: "",
        tools: [
          {
            type: "function",
            name: "click",
            description: "Click",
            inputSchema: {},
            deferLoading: true,
          },
        ],
      },
    ]);
    expect((await restored.get("old"))?.dynamicTools).toEqual([]);
    expect(await restored.get("corrupt")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    await restored.update("legacy", { name: "Renamed" });
    expect(await readFile(registry.path, "utf8")).not.toContain("DO_NOT_COPY");
    expect((await new ThreadRegistry(registry.path).get("legacy"))?.dynamicTools).toEqual(
      (await restored.get("legacy"))?.dynamicTools
    );
  });
  it("persists concurrent mutations in order even within the same millisecond", async () => {
    const registry = await createRegistry();
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      const entries = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          registry.create({
            threadId: `thread_${index}`,
            backendSessionId: `session_${index}`,
            backendType: "pi",
          })
        )
      );
      await Promise.all(
        entries.map((entry, index) => registry.update(entry.threadId, { name: `name_${index}` }))
      );
      const disk = await new ThreadRegistry(registry.path).list();
      expect(disk).toHaveLength(12);
      expect(disk.map((entry) => entry.name).sort()).toEqual(
        entries.map((_, index) => `name_${index}`).sort()
      );
    } finally {
      now.mockRestore();
    }
  });

  it("creates, reads, updates, lists, and deletes entries", async () => {
    const registry = await createRegistry();
    const created = await registry.create({
      backendSessionId: "session_1",
      backendType: "pi",
      cwd: "/repo",
      preview: "hello",
      gitInfo: null,
    });

    expect(created.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    expect(await registry.get(created.threadId)).toMatchObject({
      backendSessionId: "session_1",
      backendType: "pi",
      hidden: false,
      path: null,
      cwd: "/repo",
      preview: "hello",
      archived: false,
    });

    const updated = await registry.update(created.threadId, {
      archived: true,
      name: "Renamed",
      path: "/sessions/session_1.jsonl",
      model: "anthropic/claude-opus-4-6",
      modelProvider: "openai",
      reasoningEffort: "medium",
      gitInfo: { sha: "abc", branch: "main", originUrl: null },
    });
    expect(updated).toMatchObject({
      archived: true,
      name: "Renamed",
      path: "/sessions/session_1.jsonl",
      model: "anthropic/claude-opus-4-6",
      modelProvider: "openai",
      reasoningEffort: "medium",
      gitInfo: { sha: "abc", branch: "main", originUrl: null },
    });

    expect(await registry.list()).toHaveLength(1);

    await registry.delete(created.threadId);
    expect(await registry.get(created.threadId)).toBeNull();
    expect(await registry.list()).toHaveLength(0);
  });

  it("recovers from a corrupt registry file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-thread-registry-"));
    tempDirs.push(directory);

    const filePath = join(directory, "threads.json");
    await writeFile(filePath, "{not-json", "utf8");

    const warn = vi.fn();
    const registry = new ThreadRegistry(filePath, { warn });

    expect(await registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips invalid entries and keeps valid entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-thread-registry-"));
    tempDirs.push(directory);

    const filePath = join(directory, "threads.json");
    await writeFile(
      filePath,
      JSON.stringify({
        threads: [
          {
            threadId: "thread_valid",
            backendSessionId: "session_valid",
            backendType: "pi",
            name: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archived: false,
            cwd: null,
            preview: null,
            modelProvider: null,
            gitInfo: null,
          },
          {
            threadId: 123,
          },
        ],
      }),
      "utf8"
    );

    const warn = vi.fn();
    const registry = new ThreadRegistry(filePath, { warn });

    expect(await registry.list()).toHaveLength(1);
    expect(await registry.get("thread_valid")).toMatchObject({
      backendSessionId: "session_valid",
      hidden: false,
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("persists atomically to disk", async () => {
    const registry = await createRegistry();
    const created = await registry.create({
      backendSessionId: "session_2",
      backendType: "pi",
    });

    const payload = JSON.parse(await readFile(registry.path, "utf8")) as {
      threads: Array<{ threadId: string }>;
    };

    expect(payload.threads.map((entry) => entry.threadId)).toContain(created.threadId);
  });
});
