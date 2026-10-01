import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiBackend, PiBackend } from "../src/index.js";
import { mapHistoryToTurns } from "../src/session-history.js";
import { createMockPiScript, createModelProbeScript, waitFor } from "./pi-fixture.js";

describe("PiBackend", () => {
  it.each(["hello", { type: "text", text: "hello" }, [{ type: "text", text: "hello" }]])(
    "hydrates required desktop text fields from native content %j",
    (content) => {
      const original = structuredClone(content);
      const turns = mapHistoryToTurns([
        { id: "user", role: "user", content, createdAt: "2026-10-01T00:00:00Z" },
      ]);
      expect(turns[0].items[0]).toMatchObject({
        type: "userMessage",
        content: [{ type: "text", text: "hello", text_elements: [] }],
      });
      expect(content).toEqual(original);
    }
  );

  it("requires initialize before use", async () => {
    const backend = new PiBackend();
    await expect(backend.createSession()).rejects.toThrow(
      "Pi backend must be initialized before use"
    );
  });

  it("integrates with a real JSONL subprocess", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-"));
    const sessionDir = join(rootDir, "sessions");
    const logFilePath = join(rootDir, "pi-transport.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const scriptPath = await createMockPiScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
      debugLogFilePath: logFilePath,
    });

    await backend.initialize();

    const models = await backend.listModels();
    expect(models).toHaveLength(4);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.id).toBe("pi/mock-default");
    expect(models.some((model) => model.id === "anthropic/claude-opus-4-6")).toBe(true);

    const capabilities = await backend.getCapabilities();
    expect(capabilities).toEqual({
      requiresAuth: false,
      supportsImages: true,
      supportsThinking: true,
      supportsParallelTools: true,
      supportedToolTypes: [],
    });

    const selectedModel = models.at(1);
    if (!selectedModel) {
      throw new Error("Expected a second mock model");
    }

    const threadId = "thread-pi-1";
    const started = await backend.threadStart({
      threadId,
      cwd: sessionDir,
      model: selectedModel.id,
      reasoningEffort: "medium",
    });
    const threadHandle = started.threadHandle;
    expect(threadHandle.startsWith("pi_session_")).toBe(true);

    const notifications: Array<{ method: string; params: unknown }> = [];
    const serverRequests: Array<{ requestId: string | number; method: string; params: unknown }> =
      [];
    const subscription = backend.onEvent(threadHandle, (event) => {
      if (event.kind === "notification") {
        notifications.push({ method: event.method, params: event.params });
        return;
      }
      if (event.kind === "serverRequest") {
        serverRequests.push({
          requestId: event.requestId,
          method: event.method,
          params: event.params,
        });
      }
    });

    await backend.threadSetName({ threadId, threadHandle, name: "Primary session" });
    await backend.setModel(threadHandle, selectedModel.id);
    await backend.setModel(threadHandle, "gpt-5.3-codex");
    await backend.turnStart({
      threadId,
      threadHandle,
      turnId: "turn_1",
      cwd: sessionDir,
      input: [{ type: "text", text: "hello world", text_elements: [] }],
      model: null,
      reasoningEffort: "medium",
    });

    const elicitation = await waitFor(() =>
      serverRequests.find((event) => event.method === "item/tool/requestUserInput")
    );
    expect(elicitation.params).toMatchObject({
      threadId,
      turnId: "turn_1",
      questions: [
        {
          id: elicitation.requestId,
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
        },
      ],
    });

    await backend.resolveServerRequest({
      threadId,
      threadHandle,
      requestId: elicitation.requestId,
      response: { result: { answers: { [elicitation.requestId]: { answers: ["Yes"] } } } },
    });
    const tokenUsageEvent = await waitFor(
      () =>
        notifications.find((event) => event.method === "thread/tokenUsage/updated") as
          | {
              params?: {
                tokenUsage?: { modelContextWindow: number | null; last?: { totalTokens?: number } };
              };
            }
          | undefined
    );

    expect(notifications.some((event) => event.method === "item/agentMessage/delta")).toBe(true);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/started" &&
          (event.params as { item?: { type?: string } }).item?.type === "userMessage"
      )
    ).toBe(false);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/completed" &&
          (event.params as { item?: { type?: string } }).item?.type === "userMessage"
      )
    ).toBe(false);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/started" &&
          (event.params as { item?: { type?: string } }).item?.type === "commandExecution"
      )
    ).toBe(true);
    expect(
      notifications.some((event) => event.method === "item/commandExecution/outputDelta")
    ).toBe(true);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/completed" &&
          (event.params as { item?: { type?: string } }).item?.type === "commandExecution"
      )
    ).toBe(true);
    expect(
      notifications.some(
        (event) =>
          event.method === "turn/completed" &&
          (event.params as { turn?: { status?: string } }).turn?.status === "completed"
      )
    ).toBe(true);
    expect(
      (
        tokenUsageEvent.params as {
          tokenUsage: { modelContextWindow: number | null; last: { totalTokens: number } };
        }
      ).tokenUsage
    ).toMatchObject({
      modelContextWindow: 272000,
      last: {
        totalTokens: 12,
      },
    });

    const history = await backend.readSessionHistory(threadHandle);
    expect(history.some((message) => message.role === "user")).toBe(true);
    expect(history.some((message) => message.role === "assistant")).toBe(true);
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        content: expect.objectContaining({
          toolCallId: "tool-1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "hi" }],
        }),
      })
    );
    expect(history.some((message) => message.role === "system")).toBe(true);
    const threadRead = await backend.threadRead({
      threadId,
      threadHandle,
      includeTurns: true,
      cwd: sessionDir,
    });
    expect(threadRead.threadHandle).toBe(threadHandle);
    expect(threadRead.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "userMessage",
          content: [{ type: "text", text: "hello world", text_elements: [] }],
        }),
        expect.objectContaining({
          type: "commandExecution",
          command: "echo hi",
          status: "completed",
          aggregatedOutput: "hi",
          exitCode: 0,
        }),
        expect.objectContaining({
          type: "agentMessage",
          text: "response-1",
        }),
      ])
    );
    expect(
      threadRead.turns[0]?.items.filter(
        (item) =>
          item.type === "agentMessage" &&
          typeof item.text === "string" &&
          (item.text.includes('"toolCallId"') || item.text.includes('"type":"toolCall"'))
      )
    ).toEqual([]);

    const forked = await backend.threadFork({
      threadId: "thread-pi-fork",
      sourceThreadId: threadId,
      sourceThreadHandle: threadHandle,
      cwd: sessionDir,
      model: null,
      reasoningEffort: null,
    });
    expect(forked.threadHandle).not.toBe(threadHandle);
    const forkedHistory = await backend.readSessionHistory(forked.threadHandle);
    expect(forkedHistory).toEqual(expect.any(Array));

    subscription.dispose();
    const eventCount = notifications.length + serverRequests.length;
    await backend.turnStart({
      threadId,
      threadHandle,
      turnId: "turn_2",
      cwd: sessionDir,
      input: [{ type: "text", text: "follow-up prompt", text_elements: [] }],
      model: null,
      reasoningEffort: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications.length + serverRequests.length).toBe(eventCount);

    await backend.threadArchive({
      threadId,
      threadHandle,
    });
    await backend.dispose();

    const logRecords = (await readFile(logFilePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; raw: string });
    expect(
      logRecords.some((record) => record.kind === "stdin" && record.raw.includes('"type":"prompt"'))
    ).toBe(true);
    const setModelLines = logRecords.filter(
      (record) => record.kind === "stdin" && record.raw.includes('"type":"set_model"')
    );
    expect(
      setModelLines.some(
        (record) =>
          record.raw.includes(`"provider":"${selectedModel.id.split("/")[0]}"`) &&
          record.raw.includes(`"modelId":"${selectedModel.id.split("/").slice(1).join("/")}"`)
      )
    ).toBe(true);
    expect(
      setModelLines.some(
        (record) =>
          record.raw.includes('"provider":"pi"') && record.raw.includes('"modelId":"mock-fast"')
      )
    ).toBe(true);
    expect(
      setModelLines.some(
        (record) =>
          record.raw.includes('"provider":"openai-codex"') &&
          record.raw.includes('"modelId":"gpt-5.3-codex"')
      )
    ).toBe(true);
    expect(
      logRecords.some(
        (record) => record.kind === "stdout" && record.raw.includes('"type":"message_update"')
      )
    ).toBe(true);
    expect(
      logRecords.some(
        (record) =>
          record.kind === "parsed-event" &&
          record.raw.includes('"assistantMessageEvent":{"type":"text_delta"')
      )
    ).toBe(true);
    expect(logRecords.some((record) => record.kind === "startup")).toBe(true);
    expect(logRecords.some((record) => record.kind === "shutdown")).toBe(true);

    const reopened = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
    });
    await reopened.initialize();
    await expect(
      reopened.threadResume({
        threadId,
        threadHandle,
        cwd: sessionDir,
        model: null,
        reasoningEffort: null,
      })
    ).resolves.toMatchObject({
      threadHandle,
    });
    const resumedHistory = await reopened.readSessionHistory(threadHandle);
    expect(resumedHistory).toEqual(expect.any(Array));
    await reopened.dispose();
  });

  it("loads static available models from a file without starting the Pi process", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-static-"));
    const sessionDir = join(rootDir, "sessions");
    const staticModelsPath = join(rootDir, "models.json");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      staticModelsPath,
      JSON.stringify({
        models: [
          {
            provider: "anthropic",
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1000000,
          },
        ],
      }),
      "utf8"
    );

    const backend = createPiBackend({
      sessionDir,
      command: "definitely-not-a-real-command",
      staticAvailableModelsPath: staticModelsPath,
    });

    try {
      await backend.initialize();
      await expect(backend.listModels()).resolves.toEqual([
        expect.objectContaining({
          id: "anthropic/claude-opus-4-6",
          model: "anthropic/claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          defaultReasoningEffort: "medium",
        }),
      ]);
    } finally {
      await backend.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("dedupes the active child prompt when threadRead resumes before completion", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-live-read-"));
    const sessionDir = join(rootDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const scriptPath = await createMockPiScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
    });

    try {
      await backend.initialize();
      const started = await backend.threadStart({
        threadId: "thread-live-read",
        cwd: sessionDir,
        model: "anthropic/claude-opus-4-6",
        reasoningEffort: "medium",
      });

      await backend.turnStart({
        threadId: "thread-live-read",
        threadHandle: started.threadHandle,
        turnId: "turn-live-read",
        cwd: sessionDir,
        input: [
          {
            type: "text",
            text: "Run the `date` command and report the output.",
            text_elements: [],
          },
        ],
        model: null,
        reasoningEffort: null,
      });

      const threadRead = await backend.threadRead({
        threadId: "thread-live-read",
        threadHandle: started.threadHandle,
        includeTurns: true,
        cwd: sessionDir,
      });

      expect(threadRead.turns).toHaveLength(1);
      expect(
        threadRead.turns[0]?.items.filter(
          (item) =>
            item.type === "userMessage" &&
            JSON.stringify(item.content) ===
              JSON.stringify([
                {
                  type: "text",
                  text: "Run the `date` command and report the output.",
                  text_elements: [],
                },
              ])
        )
      ).toHaveLength(1);
      expect(threadRead.turns[0]?.status).toBe("inProgress");
    } finally {
      await backend.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("dedupes concurrent available-model probes into a single Pi process launch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-model-dedupe-"));
    const sessionDir = join(rootDir, "sessions");
    const capturePath = join(rootDir, "model-probes.log");
    await mkdir(sessionDir, { recursive: true });
    const scriptPath = await createModelProbeScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath],
      env: {
        ...process.env,
        CODAPTER_CAPTURE_PROCESS_PATH: capturePath,
      },
    });

    try {
      await backend.initialize();
      const [first, second] = await Promise.all([backend.listModels(), backend.listModels()]);
      expect(first).toEqual(second);
      expect(first).toEqual([
        expect.objectContaining({
          id: "anthropic/claude-opus-4-6",
          model: "anthropic/claude-opus-4-6",
        }),
      ]);

      const launches = (await readFile(capturePath, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(launches).toHaveLength(1);
    } finally {
      await backend.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("uses the thread cwd when launching start, resume, and fork sessions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-cwd-"));
    const sessionDir = join(rootDir, "sessions");
    const backendDefaultCwd = join(rootDir, "backend-default");
    const threadCwd = join(rootDir, "thread-workspace");
    const resumedCwd = join(rootDir, "resume-workspace");
    const forkedCwd = join(rootDir, "fork-workspace");
    const capturePath = join(rootDir, "launch.json");
    const captureResumePath = join(rootDir, "launch-resume.json");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(backendDefaultCwd, { recursive: true });
    await mkdir(threadCwd, { recursive: true });
    await mkdir(resumedCwd, { recursive: true });
    await mkdir(forkedCwd, { recursive: true });
    const scriptPath = await createMockPiScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
      cwd: backendDefaultCwd,
      env: {
        ...process.env,
        CODAPTER_CAPTURE_PROCESS_PATH: capturePath,
      },
    });

    let threadHandle = "";
    try {
      await backend.initialize();
      const started = await backend.threadStart({
        threadId: "thread-cwd-start",
        cwd: threadCwd,
        model: null,
        reasoningEffort: null,
      });
      threadHandle = started.threadHandle;

      expect(JSON.parse(await readFile(capturePath, "utf8"))).toMatchObject({
        cwd: threadCwd,
      });

      await backend.threadFork({
        threadId: "thread-cwd-fork",
        sourceThreadId: "thread-cwd-start",
        sourceThreadHandle: started.threadHandle,
        cwd: forkedCwd,
        model: null,
        reasoningEffort: null,
      });

      expect(JSON.parse(await readFile(capturePath, "utf8"))).toMatchObject({
        cwd: forkedCwd,
      });
    } finally {
      await backend.dispose();
    }

    const reopened = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
      cwd: backendDefaultCwd,
      env: {
        ...process.env,
        CODAPTER_CAPTURE_PROCESS_PATH: captureResumePath,
      },
    });

    try {
      await reopened.initialize();
      await reopened.threadResume({
        threadId: "thread-cwd-resume",
        threadHandle,
        cwd: resumedCwd,
        model: null,
        reasoningEffort: null,
      });

      expect(JSON.parse(await readFile(captureResumePath, "utf8"))).toMatchObject({
        cwd: resumedCwd,
      });
    } finally {
      await reopened.dispose();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("passes collab launch config and extension path to child processes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-collab-"));
    const sessionDir = join(rootDir, "sessions");
    const capturePath = join(rootDir, "launch.json");
    const extensionPath = join(rootDir, "collab-extension.js");
    await mkdir(sessionDir, { recursive: true });
    const scriptPath = await createMockPiScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
      env: {
        ...process.env,
        CODAPTER_CAPTURE_PROCESS_PATH: capturePath,
      },
      collabExtensionPath: extensionPath,
    });

    await backend.initialize();

    try {
      await backend.createSession({
        threadId: "thread-parent-123",
        collabSocketPath: "/tmp/codapter-collab-test.sock",
        availableModelsDescription:
          "Available models (use the model id exactly as shown):\n- pi::anthropic/claude-opus-4-6: medium\n- gpt-5.4: medium",
      });
    } finally {
      await backend.dispose();
    }

    const launch = JSON.parse(await readFile(capturePath, "utf8")) as {
      argv: string[];
      collabSocketPath: string | null;
      parentThreadId: string | null;
      availableModelsDescription: string | null;
    };
    expect(launch.collabSocketPath).toBe("/tmp/codapter-collab-test.sock");
    expect(launch.parentThreadId).toBe("thread-parent-123");
    expect(launch.availableModelsDescription).toContain("pi::anthropic/claude-opus-4-6");
    expect(launch.availableModelsDescription).toContain("gpt-5.4");
    expect(launch.argv).toContain("--extension");
    expect(launch.argv).toContain(extensionPath);
  });
});
