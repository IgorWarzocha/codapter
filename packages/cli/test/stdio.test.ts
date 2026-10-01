import { PassThrough, Readable } from "node:stream";
import { AppServerConnection } from "@codapter/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

function createNdjsonCollector(stream: PassThrough) {
  const messages = new Map<string | number, unknown>();
  const waiters = new Map<string | number, (message: unknown) => void>();
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const message = JSON.parse(line) as { id?: string | number };
        if (message.id !== undefined) {
          messages.set(message.id, message);
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message);
          }
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return {
    waitFor(id: string | number): Promise<unknown> {
      const existing = messages.get(id);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        waiters.set(id, resolve);
      });
    },
  };
}

describe("runCli", () => {
  it("runs the stdio app-server path by default", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdin = Readable.from([
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      }),
      "\n",
    ]);

    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const result = await runCli(["app-server"], {
      stdin,
      stdout,
      stderr,
      env: {
        CODAPTER_CODEX_DISABLE: "1",
      },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(stderrChunks.join("")).toBe("");
    expect(JSON.parse(stdoutChunks.join(""))).toMatchObject({
      id: 1,
      result: {
        userAgent: expect.any(String),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      },
    });
  });

  it("fails fast on invalid CODAPTER_CODEX_TRANSPORT", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const result = await runCli(["app-server"], {
      stdin: Readable.from([]),
      stdout,
      stderr,
      env: {
        CODAPTER_PI_DISABLE: "1",
        CODAPTER_CODEX_TRANSPORT: "banana",
      },
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderrChunks.join("")).toContain("Invalid CODAPTER_CODEX_TRANSPORT: banana");
  });

  it("does not block later stdio requests behind a slow request", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const collector = createNdjsonCollector(stdout);
    let releaseResume: (() => void) | null = null;

    const originalHandleMessage = AppServerConnection.prototype.handleMessage;
    const handleMessageSpy = vi
      .spyOn(AppServerConnection.prototype, "handleMessage")
      .mockImplementation(function (message: unknown) {
        if (
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          (message as { method?: unknown }).method === "thread/resume"
        ) {
          return new Promise((resolve) => {
            releaseResume = () => {
              resolve({
                id: (message as { id?: string | number }).id ?? null,
                result: { thread: { id: "stalled-thread" } },
              });
            };
          });
        }
        return originalHandleMessage.call(this, message);
      });

    try {
      const resultPromise = runCli(["app-server"], {
        stdin,
        stdout,
        stderr,
        env: {
          CODAPTER_CODEX_DISABLE: "1",
        },
      });

      stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          },
        })}\n`
      );
      expect(await collector.waitFor(1)).toMatchObject({
        id: 1,
        result: { userAgent: expect.any(String) },
      });

      stdin.write(`${JSON.stringify({ id: 2, method: "thread/resume", params: {} })}\n`);
      stdin.write(
        `${JSON.stringify({
          id: 3,
          method: "account/read",
          params: { refreshToken: false },
        })}\n`
      );

      await expect(collector.waitFor(3)).resolves.toMatchObject({
        id: 3,
        result: {
          account: null,
          requiresOpenaiAuth: false,
        },
      });

      releaseResume?.();
      expect(await collector.waitFor(2)).toMatchObject({
        id: 2,
        result: { thread: { id: "stalled-thread" } },
      });

      stdin.end();
      expect(await resultPromise).toEqual({ exitCode: 0 });
    } finally {
      handleMessageSpy.mockRestore();
    }
  });

  it("runs stdio via --listen stdio with shutdown signal", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const abortController = new AbortController();

    const resultPromise = runCli(["app-server", "--listen", "stdio"], {
      stdin,
      stdout,
      stderr,
      // Only transport behavior is under test. Never launch a real Codex backend.
      env: { CODAPTER_CODEX_DISABLE: "1" },
      shutdownSignal: abortController.signal,
    });

    // Wait for the "Listening on" message on stderr
    await new Promise<void>((resolve) => {
      const check = () => {
        if (stderrChunks.join("").includes("Listening on")) {
          resolve();
        }
      };
      stderr.on("data", check);
      check();
    });

    expect(stderrChunks.join("")).toContain("stdio");

    // Send an initialize request over stdio
    const responsePromise = new Promise<unknown>((resolve) => {
      stdout.once("data", (chunk: string) => {
        resolve(JSON.parse(chunk));
      });
    });

    stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      })}\n`
    );

    expect(await responsePromise).toMatchObject({
      id: 1,
      result: { userAgent: expect.any(String) },
    });

    // Shut down cleanly
    abortController.abort();
    const result = await resultPromise;
    expect(result).toEqual({ exitCode: 0 });
  });
});
