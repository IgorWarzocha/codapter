import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/app-server.js";
import type { IBackend } from "../src/backend.js";
import type { ThreadItemsListResponse, ThreadTurnsListResponse, Turn } from "../src/protocol.js";
import { ThreadRegistry } from "../src/thread-registry.js";

function fixtureTurn(id: string): Turn {
  return {
    id,
    status: "completed",
    error: null,
    items: [
      { type: "userMessage", id: `${id}-user`, content: [{ type: "text", text: id }] },
      { type: "reasoning", id: `${id}-reasoning`, summary: ["fixture"], content: [] },
      { type: "agentMessage", id: `${id}-answer`, text: `answer ${id}`, phase: "final_answer" },
    ],
  };
}

describe("desktop paginated history", () => {
  let directory: string;
  let connection: AppServerConnection;
  let threadId: string;
  let turns: Turn[];
  let nextId = 0;

  async function request<T>(method: string, params: unknown): Promise<T> {
    const response = await connection.handleMessage({ id: ++nextId, method, params });
    if (!response) throw new Error("Missing RPC response");
    if ("error" in response) throw new Error(response.error.message);
    return response.result as T;
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codapter-history-"));
    vi.stubEnv("CODAPTER_CONFIG_FILE", join(directory, "config.toml"));
    turns = ["old", "middle", "new"].map(fixtureTurn);
    const unexpected = async () => {
      throw new Error("Unexpected backend operation");
    };
    const backend: IBackend = {
      backendType: "pi",
      initialize: async () => {},
      dispose: async () => {},
      isAlive: () => true,
      parseModelSelection: () => null,
      listModels: async () => [],
      threadStart: unexpected,
      threadResume: unexpected,
      threadFork: unexpected,
      threadRead: async ({ threadHandle, includeTurns }) => ({
        threadHandle,
        turns: includeTurns ? structuredClone(turns) : [],
      }),
      threadArchive: unexpected,
      threadSetName: unexpected,
      turnStart: unexpected,
      turnInterrupt: unexpected,
      resolveServerRequest: unexpected,
      onEvent: () => ({ dispose() {} }),
    };
    const registry = new ThreadRegistry(join(directory, "threads.json"));
    const entry = await registry.create({
      backendType: "pi",
      backendSessionId: "native-session",
      cwd: directory,
    });
    threadId = entry.threadId;
    connection = new AppServerConnection({ backend, threadRegistry: registry });
    await request("initialize", { clientInfo: { name: "desktop-history-fixture", version: "1" } });
  });

  afterEach(async () => {
    await connection.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("pages unloaded turns with stable anchors while new turns arrive", async () => {
    // Captured Desktop request shape, verified against Codex 0.159.3 generated types.
    const first = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      cursor: null,
      limit: 2,
      itemsView: "notLoaded",
      sortDirection: "desc",
    });
    expect(first.data.map(({ id }) => id)).toEqual(["new", "middle"]);
    expect(
      first.data.every(({ items, itemsView }) => items.length === 0 && itemsView === "notLoaded")
    ).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.backwardsCursor).toEqual(expect.any(String));
    turns.push(fixtureTurn("newest"));
    const next = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      cursor: first.nextCursor,
      limit: 2,
      sortDirection: "desc",
    });
    expect(next.data.map(({ id }) => id)).toEqual(["old"]);
    expect(next.nextCursor).toBeNull();
    const reversed = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      cursor: first.backwardsCursor,
      sortDirection: "asc",
    });
    expect(reversed.data.map(({ id }) => id)).toEqual(["new", "newest"]);
  });

  it("projects native summary selection without losing full items on later reads", async () => {
    turns[2].items.splice(1, 0, { type: "agentMessage", id: "interim", text: "working" });
    const summary = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 1,
    });
    expect(summary.data[0].itemsView).toBe("summary");
    expect(summary.data[0].items.map(({ id }) => id)).toEqual(["new-user", "new-answer"]);
    const full = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 1,
      itemsView: "full",
    });
    expect(full.data[0].items).toEqual(turns[2].items);
    expect(full.data[0].itemsView).toBe("full");
  });

  it("clamps page sizes to the native range", async () => {
    turns = Array.from({ length: 105 }, (_, index) => fixtureTurn(String(index)));
    const small = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 0,
    });
    const large = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 200,
    });
    expect(small.data).toHaveLength(1);
    expect(large.data).toHaveLength(100);
    expect(large.nextCursor).toEqual(expect.any(String));
  });

  it("hydrates items and supports exclusive turn-scoped item anchors in both directions", async () => {
    const first = await request<ThreadItemsListResponse>("thread/items/list", {
      threadId,
      turnId: "new",
      limit: 2,
    });
    expect(first.data.map(({ item }) => item.id)).toEqual(["new-user", "new-reasoning"]);
    expect(first.data[0]).toMatchObject({ turnId: "new", startedAtMs: null, completedAtMs: null });
    const next = await request<ThreadItemsListResponse>("thread/items/list", {
      threadId,
      turnId: "new",
      cursor: first.nextCursor,
    });
    expect(next.data.map(({ item }) => item.id)).toEqual(["new-answer"]);
    expect(next.nextCursor).toBeNull();
    for (const [sortDirection, expected] of [
      ["asc", "new-answer"],
      ["desc", "new-user"],
    ]) {
      const anchored = await request<ThreadItemsListResponse>("thread/items/list", {
        threadId,
        turnId: "new",
        cursor: { type: "item", itemId: "new-reasoning" },
        sortDirection,
      });
      expect(anchored.data.map(({ item }) => item.id)).toEqual([expected]);
    }
    const reverse = await request<ThreadItemsListResponse>("thread/items/list", {
      threadId,
      turnId: "new",
      cursor: first.backwardsCursor,
      sortDirection: "desc",
    });
    expect(reverse.data.map(({ item }) => item.id)).toEqual(["new-user"]);
  });

  it("lists items across turns and returns explicit empty page boundaries", async () => {
    const page = await request<ThreadItemsListResponse>("thread/items/list", {
      threadId,
      limit: 100,
    });
    expect(page.data.map(({ turnId: id }) => id)).toEqual([
      "old",
      "old",
      "old",
      "middle",
      "middle",
      "middle",
      "new",
      "new",
      "new",
    ]);
    expect(page.nextCursor).toBeNull();
    turns = [];
    expect(await request("thread/turns/list", { threadId })).toEqual({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
    expect(await request("thread/items/list", { threadId })).toEqual({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
  });

  it.each([
    { limit: -1 },
    { limit: 1.5 },
    { sortDirection: "sideways" },
    { cursor: "invalid" },
    { itemsView: "collapsed" },
  ])("rejects invalid page input %j", async (params) => {
    await expect(request("thread/turns/list", { threadId, ...params })).rejects.toThrow();
  });

  it("rejects missing item anchors and cursors from another history scope", async () => {
    await expect(
      request("thread/items/list", { threadId, cursor: { type: "item", itemId: "new-user" } })
    ).rejects.toThrow("turnId");
    await expect(
      request("thread/items/list", {
        threadId,
        turnId: "new",
        cursor: { type: "item", itemId: "absent" },
      })
    ).rejects.toThrow("anchor");
    const turnsPage = await request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      limit: 1,
    });
    await expect(
      request("thread/items/list", { threadId, cursor: turnsPage.nextCursor })
    ).rejects.toThrow("cursor");
  });
});
