import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  type JsonRpcNotification,
} from "../../packages/core/src/jsonrpc.js";
import type {
  ModelListResponse,
  ThreadForkResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "../../packages/core/src/protocol.js";

const MODEL = "pi::openai-codex/gpt-6-luna";
const BUNDLE = fileURLToPath(new URL("../../dist/codapter.mjs", import.meta.url));

// Real process boundary, not a provider double. HOME stays intact so Pi loads the
// installed wrapper, authentication, extensions, and prompts unchanged.
function startClient(directory: string) {
  const child = spawn(
    process.execPath,
    [BUNDLE, "-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
    {
      cwd: directory,
      env: {
        ...process.env,
        CODAPTER_STATE_DIR: join(directory, "state"),
        CODAPTER_CONFIG_FILE: join(directory, "config.toml"),
        CODAPTER_CODEX_DISABLE: "1",
        CODAPTER_PI_DISABLE: "0",
        CODAPTER_COLLAB: "0",
        CODAPTER_LISTEN: "",
        CODAPTER_PI_COMMAND: "pi",
        CODAPTER_PI_ARGS: JSON.stringify([
          "--mode",
          "rpc",
          "--provider",
          "openai-codex",
          "--model",
          "gpt-6-luna",
          "--thinking",
          "low",
        ]),
        CODAPTER_PI_STATIC_MODELS_FILE: "",
        CODAPTER_PI_IDLE_TIMEOUT_MS: "0",
        CODAPTER_DEBUG_LOG_FILE: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const closed = once(child, "close");
  const notifications: JsonRpcNotification[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  const lines = createInterface({ input: child.stdout });
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("close", (code) => fail(new Error(`Codapter exited ${code}: ${stderr}`)));
  lines.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (isJsonRpcNotification(message)) {
        notifications.push(message);
      } else if (isJsonRpcResponse(message) && typeof message.id === "number") {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if ("error" in message) request?.reject(new Error(message.error.message));
        else request?.resolve(message.result);
      } else {
        fail(new Error(`Unexpected live RPC message: ${line}`));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    notifications,
    async request<T>(method: string, params: unknown): Promise<T> {
      const id = ++nextId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          pending.set(id, { resolve: (value) => resolve(value as T), reject });
          timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}\n${stderr}`)), 90_000);
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },
    async close() {
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const [code, signal] = await closed;
        expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(kill);
        lines.close();
      }
    },
  };
}

async function initialize(client: ReturnType<typeof startClient>) {
  const result = await client.request("initialize", {
    clientInfo: { name: "codapter-live-smoke", title: null, version: "1" },
    capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
  });
  expect(result).toMatchObject({ codexHome: expect.any(String) });
}

describe.skipIf(process.env.PI_LIVE_TEST !== "1")("installed Pi with Luna 6 low", () => {
  it("runs extension tools and preserves a thread across fork and process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-live-"));
    const marker = `codapter-${randomUUID()}`;
    await writeFile(join(directory, "codapter-smoke-token.txt"), marker);
    let client = startClient(directory);
    try {
      await initialize(client);
      const models = await client.request<ModelListResponse>("model/list", {});
      expect(models.data.some((model) => model.id === MODEL)).toBe(true);
      const started = await client.request<ThreadStartResponse>("thread/start", {
        model: MODEL,
        cwd: directory,
        config: { model_reasoning_effort: "low" },
      });
      expect(started).toMatchObject({ model: MODEL, reasoningEffort: "low" });
      const threadId = started.thread.id;
      const turn = await client.request<TurnStartResponse>("turn/start", {
        threadId,
        model: MODEL,
        effort: "low",
        input: [
          {
            type: "text",
            text: "This is a read-only integration smoke test. Use your installed execution tool to read ./codapter-smoke-token.txt, then reply with its exact contents. Do not write files, use the web, or delegate.",
            text_elements: [],
          },
        ],
      });
      await expect
        .poll(
          () =>
            client.notifications.find(
              (event) =>
                event.method === "turn/completed" &&
                (event.params as { turn?: { id?: string } })?.turn?.id === turn.turn.id
            ),
          { timeout: 150_000, interval: 100 }
        )
        .toMatchObject({
          params: { turn: { status: "completed", error: null } },
        });
      const items = client.notifications.filter((event) => event.method === "item/completed");
      expect(
        items.some(
          (event) =>
            (event.params as { item?: { type?: string } })?.item?.type === "commandExecution"
        )
      ).toBe(true);
      const history = await client.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true,
      });
      expect(
        history.thread.turns
          .flatMap((entry) => entry.items)
          .filter((item) => item.type === "agentMessage")
          .map((item) => item.text)
          .join("\n")
      ).toContain(marker);

      // Verify the native session recorded the model and thinking setting, not
      // merely that Codapter echoed the requested settings back to the client.
      expect(history.thread.path).toEqual(expect.any(String));
      const session = await readFile(history.thread.path as string, "utf8");
      expect(session).toContain('"modelId":"gpt-6-luna"');
      expect(session).toContain('"thinkingLevel":"low"');

      const forked = await client.request<ThreadForkResponse>("thread/fork", { threadId });
      expect(forked.thread.id).not.toBe(threadId);
      expect(JSON.stringify(forked.thread.turns)).toContain(marker);
      await client.close();
      client = startClient(directory);
      await initialize(client);
      const resumed = await client.request<ThreadResumeResponse>("thread/resume", {
        threadId,
        model: MODEL,
      });
      expect(resumed.thread.id).toBe(threadId);
      expect(resumed.reasoningEffort).toBe("low");
      expect(JSON.stringify(resumed.thread.turns)).toContain(marker);
      await client.request("thread/archive", { threadId });
      await client.request("thread/archive", { threadId: forked.thread.id });
    } finally {
      try {
        await client.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 240_000);
});
