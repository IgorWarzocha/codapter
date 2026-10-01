import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServerConnection, readStoredAuthState } from "../src/app-server.js";
import type { BackendAppServerEvent, BackendModelSummary, IBackend } from "../src/backend.js";
import { BackendRouter } from "../src/backend-router.js";
import { InMemoryConfigStore } from "../src/config-store.js";
import type { JsonRpcEnvelope } from "../src/jsonrpc.js";
import { ThreadRegistry } from "../src/thread-registry.js";
import { ADAPTER_VERSION } from "../src/version.js";

const model: BackendModelSummary = {
  id: "catalog-model",
  model: "catalog-model",
  displayName: "Catalog model",
  description: "Fixture",
  hidden: false,
  isDefault: true,
  inputModalities: ["text", "image"],
  supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
  defaultReasoningEffort: "low",
  supportsPersonality: false,
  multiAgentVersion: "v2",
  additionalSpeedTiers: ["fast"],
  serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }],
  defaultServiceTier: "fast",
  availableAccessPrograms: { cyber: ["standard"] },
};

describe("current desktop protocol boundary", () => {
  let directory: string;
  let connection: AppServerConnection;
  let backend: IBackend;
  let registry: ThreadRegistry;
  let listener: ((event: BackendAppServerEvent) => void) | null;
  let messages: JsonRpcEnvelope[];
  const warn = vi.fn();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "codapter-protocol-test-"));
    vi.stubEnv("CODEX_HOME", directory);
    vi.stubEnv("CODAPTER_EMULATE_CODEX_IDENTITY", `codapter/${ADAPTER_VERSION}`);
    vi.stubEnv("CODAPTER_STATE_DIR", directory);
    vi.stubEnv("CODAPTER_CONFIG_FILE", join(directory, "config.toml"));
    listener = null;
    messages = [];
    warn.mockClear();
    backend = {
      backendType: "codex",
      initialize: async () => {},
      dispose: async () => {},
      isAlive: () => true,
      parseModelSelection: (value) => (value ? { backendType: "codex", rawModelId: value } : null),
      listModels: async () => [
        structuredClone(model),
        {
          ...structuredClone(model),
          id: "hidden",
          model: "hidden",
          hidden: true,
          isDefault: false,
        },
      ],
      threadStart: async () => ({
        threadHandle: "native",
        path: null,
        model: model.model,
        reasoningEffort: "low",
      }),
      threadResume: async () => ({
        threadHandle: "native",
        path: null,
        model: model.model,
        reasoningEffort: "low",
      }),
      threadFork: async () => ({
        threadHandle: "fork",
        path: null,
        model: model.model,
        reasoningEffort: "low",
      }),
      threadRead: async ({ threadHandle }) => ({
        threadHandle,
        title: null,
        model: model.model,
        turns: [{ id: "turn", items: [], status: "completed", error: null }],
      }),
      threadArchive: async () => {},
      threadSetName: async () => {},
      turnInterrupt: async () => {},
      turnStart: vi.fn(async () => ({ accepted: true, turnId: "turn" })),
      resolveServerRequest: async () => {},
      onEvent: (_handle, callback) => {
        listener = callback;
        return {
          dispose() {
            listener = null;
          },
        };
      },
    };
    registry = new ThreadRegistry();
    connection = new AppServerConnection({
      backend,
      threadRegistry: registry,
      logger: { warn },
      onMessage: (message) => {
        messages.push(message);
      },
    });
  });

  afterEach(async () => {
    await connection.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function initialize(version = ADAPTER_VERSION) {
    return connection.handleMessage({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "desktop-fixture", version },
        capabilities: { experimentalApi: true },
      },
    });
  }

  it.each([
    ["thread/archive", "fixture/block"],
    ["thread/archive", "turn/started"],
    ["thread/resume", "fixture/block"],
    ["thread/resume", "turn/started"],
  ])("%s invalidates event continuations blocked at %s", async (method, blockedMethod) => {
    let release = () => {};
    let entered = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await connection.dispose();
    connection = new AppServerConnection({
      backend,
      threadRegistry: registry,
      logger: { warn },
      onMessage: async (message) => {
        messages.push(message);
        if ("method" in message && message.method === blockedMethod) {
          entered();
          await barrier;
        }
      },
    });
    await initialize();
    const started = await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: { model: model.model },
    });
    if (!started || !("result" in started)) throw new Error("thread/start failed");
    const { thread } = started.result as { thread: { id: string } };
    if (blockedMethod === "fixture/block") {
      listener?.({
        kind: "notification",
        threadHandle: "native",
        method: blockedMethod,
        params: { threadId: "native" },
      });
    }
    listener?.({
      kind: "notification",
      threadHandle: "native",
      method: "turn/started",
      params: {
        threadId: "native",
        turn: { id: "stale-turn", status: "inProgress", items: [], error: null },
      },
    });
    try {
      await waiting;
      expect(
        await connection.handleMessage({ id: 3, method, params: { threadId: thread.id } })
      ).toHaveProperty("result");
      const countAfterTransition = messages.length;
      release();
      // These event translations only await promises, so one event-loop turn
      // lets both queued work and the blocked publication continuation finish.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(messages.slice(countAfterTransition)).toEqual([]);
      expect(await connection.handleMessage({ id: 4, method: "thread/loaded/list" })).toMatchObject(
        { result: { data: method === "thread/archive" ? [] : [thread.id] } }
      );
      if (method === "thread/resume") {
        expect(
          await connection.handleMessage({
            id: 5,
            method: "thread/read",
            params: { threadId: thread.id, includeTurns: false },
          })
        ).toHaveProperty("result.thread.status.type", "idle");
      }
    } finally {
      release();
    }
  });

  it.each(["thread/resume", "thread/fork"])(
    "releases subscriptions when %s fails after backend attachment",
    async (method) => {
      const attached = new Set<string>();
      backend.onEvent = (handle) => {
        attached.add(handle);
        return {
          dispose() {
            attached.delete(handle);
          },
        };
      };
      await initialize();
      const started = await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: { model: model.model },
      });
      if (!started || !("result" in started)) throw new Error("thread/start failed");
      const { thread } = started.result as { thread: { id: string } };
      vi.spyOn(backend, "threadRead").mockRejectedValueOnce(new Error("history unavailable"));
      expect(
        await connection.handleMessage({ id: 3, method, params: { threadId: thread.id } })
      ).toMatchObject({
        error: { message: "history unavailable" },
      });
      expect([...attached]).toEqual(method === "thread/fork" ? ["native"] : []);
      expect(await connection.handleMessage({ id: 4, method: "thread/loaded/list" })).toMatchObject(
        {
          result: { data: method === "thread/fork" ? [thread.id] : [] },
        }
      );
      if (method === "thread/fork") {
        expect(
          await connection.handleMessage({
            id: 5,
            method: "turn/start",
            params: {
              threadId: thread.id,
              input: [{ type: "text", text: "still ready", text_elements: [] }],
            },
          })
        ).toHaveProperty("result.turn.status", "inProgress");
      }
    }
  );

  it("does not compare the independent client product version with the adapter version", async () => {
    expect(await initialize("26.928.31416")).toHaveProperty("result.codexHome", directory);
    expect(connection.clientInfo?.version).toBe("26.928.31416");
    expect(warn).not.toHaveBeenCalled();
  });

  it("routes arbitrary server requests and both response forms after thread unsubscribe", async () => {
    const resolveRequest = vi.spyOn(backend, "resolveServerRequest");
    await initialize();
    const started = await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: { model: model.model },
    });
    if (!started || !("result" in started)) throw new Error("thread/start failed");
    const { thread } = started.result as { thread: { id: string } };
    for (const method of ["fixture/extensionCall", "fixture/otherCall"]) {
      listener?.({
        kind: "serverRequest",
        threadHandle: "native",
        requestId: 77,
        method,
        params: { nested: [{ threadId: "native", thread: { id: "native" } }] },
      });
    }
    await vi.waitFor(() => expect(messages.filter((message) => "id" in message)).toHaveLength(2));
    const requests = messages.filter((message) => "id" in message);
    const ids = requests.map((message) => ("id" in message ? message.id : null));
    expect(new Set(ids).size).toBe(2);
    expect(requests).toEqual(
      ["fixture/extensionCall", "fixture/otherCall"].map((method) => ({
        id: expect.any(String),
        method,
        params: { nested: [{ threadId: thread.id, thread: { id: thread.id } }] },
      }))
    );
    await connection.handleMessage({
      id: 3,
      method: "thread/unsubscribe",
      params: { threadId: thread.id },
    });
    await connection.handleMessage({ id: ids[0], result: { opaque: "result" } });
    await connection.handleMessage({
      id: ids[1],
      error: { code: -1, message: "extension failure" },
    });
    expect(resolveRequest.mock.calls.map(([input]) => input)).toEqual([
      {
        threadId: thread.id,
        threadHandle: "native",
        requestId: 77,
        response: { result: { opaque: "result" } },
      },
      {
        threadId: thread.id,
        threadHandle: "native",
        requestId: 77,
        response: { error: { code: -1, message: "extension failure" } },
      },
    ]);
    expect(
      messages.some((message) => "method" in message && message.method === "serverRequest/resolved")
    ).toBe(false);
    await connection.handleMessage({ id: ids[0], result: "duplicate" });
    expect(resolveRequest).toHaveBeenCalledTimes(2);
  });

  it("supplies the required bootstrap fields and uses isolated state paths", async () => {
    expect(registry.path).toBe(join(directory, "threads.json"));
    expect(await initialize()).toEqual({
      id: 1,
      result: {
        userAgent: `codapter/${ADAPTER_VERSION}`,
        codexHome: resolve(directory),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      },
    });
    expect(await connection.handleMessage({ id: 2, method: "plugin/list" })).toEqual({
      id: 2,
      result: {
        marketplaces: [],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
        remoteSyncError: null,
      },
    });
    const config = new InMemoryConfigStore().read({ includeLayers: true });
    expect(config.layers?.[0].name).toEqual({ type: "user", file: join(directory, "config.toml") });
    expect(config.config).toMatchObject({
      model_auto_compact_token_limit_scope: null,
      browser_use: null,
      computer_use: null,
      desktop: null,
    });
  });

  it("rejects malformed initialize without consuming initialization", async () => {
    expect(await connection.handleMessage({ id: 1, method: "initialize", params: {} })).toEqual({
      id: 1,
      error: { code: -32602, message: "Invalid initialize params" },
    });
    expect(await initialize()).toHaveProperty("result.codexHome", directory);
  });

  it("retains native catalog capabilities through cached routing and paginates hidden models", async () => {
    await initialize();
    const router = new BackendRouter([backend]);
    const first = await router.listModels();
    const tier = first[0].serviceTiers?.[0];
    if (!tier) throw new Error("Missing service tier");
    tier.name = "modified";
    expect((await router.listModels())[0].serviceTiers?.[0].name).toBe("Fast");
    expect(
      await connection.handleMessage({
        id: 2,
        method: "model/list",
        params: { includeHidden: true, limit: 1 },
      })
    ).toMatchObject({
      result: {
        data: [
          {
            serviceTiers: model.serviceTiers,
            multiAgentVersion: "v2",
            availableAccessPrograms: model.availableAccessPrograms,
          },
        ],
        nextCursor: "1",
      },
    });
    expect(
      await connection.handleMessage({
        id: 3,
        method: "model/list",
        params: { includeHidden: true, cursor: "1", limit: 1 },
      })
    ).toMatchObject({
      result: { data: [{ id: "hidden" }], nextCursor: null },
    });
    expect(await connection.handleMessage({ id: 4, method: "model/list" })).toMatchObject({
      result: { data: [{ id: model.id }], nextCursor: null },
    });
  });

  it("hydrates legacy history with modern fields and preserves fork ancestry", async () => {
    await initialize();
    const started = await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: { model: model.model, serviceTier: "fast" },
    });
    if (!started || !("result" in started)) throw new Error("thread/start failed");
    const { thread } = started.result as { thread: { id: string } };
    expect(started).toMatchObject({
      result: {
        serviceTier: "fast",
        disabledPluginIds: [],
        instructionSources: [],
        thread: {
          sessionId: thread.id,
          forkedFromId: null,
          parentThreadId: null,
          historyMode: "legacy",
          model: model.model,
          reasoningEffort: "low",
          section: null,
          projectId: null,
        },
      },
    });
    expect(
      await connection.handleMessage({
        id: 3,
        method: "thread/resume",
        params: { threadId: thread.id },
      })
    ).toMatchObject({
      result: {
        collaborationMode: null,
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
        thread: {
          turns: [{ itemsView: "full", startedAt: null, completedAt: null, durationMs: null }],
        },
      },
    });
    expect(
      await connection.handleMessage({
        id: 4,
        method: "thread/fork",
        params: { threadId: thread.id },
      })
    ).toMatchObject({
      result: { thread: { sessionId: thread.id, forkedFromId: thread.id } },
    });
    const persisted = await new ThreadRegistry(registry.path).list();
    expect(persisted.find((entry) => entry.backendSessionId === "fork")).toMatchObject({
      sessionId: thread.id,
      forkedFromId: thread.id,
    });
  });

  it("leaves modern input support with the backend and emits valid active flags", async () => {
    await initialize();
    const started = await connection.handleMessage({
      id: 2,
      method: "thread/start",
      params: { model: model.model },
    });
    if (!started || !("result" in started)) throw new Error("thread/start failed");
    const { thread } = started.result as { thread: { id: string } };
    const input = [
      { type: "skill", name: "fixture", path: "/fixture" },
      { type: "mention", name: "app", path: "/app" },
      { type: "image", fileId: "file-fixture", detail: "original" },
      { type: "audio", url: "fixture://audio" },
      { type: "localAudio", path: "/audio" },
    ];
    expect(
      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: { threadId: thread.id, input },
      })
    ).toMatchObject({
      result: { turn: { id: "turn", itemsView: "full", startedAt: null } },
    });
    expect(backend.turnStart).toHaveBeenCalledWith(expect.objectContaining({ input }));
    expect(messages).toContainEqual({
      method: "thread/status/changed",
      params: { threadId: thread.id, status: { type: "active", activeFlags: [] } },
    });
    listener?.({
      kind: "notification",
      threadHandle: "native",
      method: "turn/completed",
      params: {
        threadId: "native",
        turn: {
          id: "turn",
          items: [],
          status: "completed",
          error: null,
          startedAt: 10,
          completedAt: 12,
          durationMs: 2000,
        },
      },
    });
    await connection.dispose();
    expect(messages).toContainEqual({
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: {
          id: "turn",
          items: [],
          status: "completed",
          error: null,
          itemsView: "full",
          startedAt: 10,
          completedAt: 12,
          durationMs: 2000,
        },
      },
    });
  });

  it("reads auth from the same CODEX_HOME advertised at initialization", async () => {
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fixture-key" })
    );
    expect(readStoredAuthState()).toEqual({ mode: "apikey", apiKey: "fixture-key" });
  });

  it("lists cwd sets in either direction with a reversible page anchor", async () => {
    await initialize();
    for (const [index, cwd] of ["/one", "/other", "/two"].entries()) {
      const entry = await registry.create({
        backendType: "codex",
        backendSessionId: `native-${index}`,
        cwd,
      });
      await registry.update(entry.threadId, { updatedAt: `2026-01-0${index + 1}T00:00:00.000Z` });
    }
    const page = await connection.handleMessage({
      id: 2,
      method: "thread/list",
      params: {
        cwd: ["/one", "/two"],
        sortKey: "updated_at",
        sortDirection: "asc",
        limit: 1,
      },
    });
    expect(page).toMatchObject({
      result: { data: [{ cwd: "/one" }], nextCursor: "1", backwardsCursor: "1" },
    });
    expect(
      await connection.handleMessage({
        id: 3,
        method: "thread/list",
        params: {
          cwd: ["/one", "/two"],
          sortKey: "updated_at",
          sortDirection: "desc",
          cursor: "1",
          limit: 1,
        },
      })
    ).toMatchObject({
      result: { data: [{ cwd: "/one" }], nextCursor: null, backwardsCursor: "0" },
    });
  });
});
