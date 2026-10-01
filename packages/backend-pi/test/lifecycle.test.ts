import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiBackend } from "../src/index.js";
import { createMockPiScript, waitFor } from "./pi-fixture.js";

const backends: PiBackend[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function setup(extraEnv: NodeJS.ProcessEnv = {}, idleTimeoutMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "codapter-pi-lifecycle-"));
  roots.push(root);
  const capture = join(root, "launch.json");
  const script = await createMockPiScript(root);
  const env = { ...extraEnv, CODAPTER_CAPTURE_PROCESS_PATH: capture };
  const backend = new PiBackend({
    sessionDir: root,
    command: process.execPath,
    args: [script, root],
    env,
    idleTimeoutMs,
  });
  backends.push(backend);
  await backend.initialize();
  return { root, capture, env, backend };
}

async function start(backend: PiBackend, root: string) {
  return await backend.threadStart({
    threadId: "native-thread",
    cwd: root,
    model: null,
    reasoningEffort: null,
  });
}

describe("Pi backend resource ownership", () => {
  it("reserves turn ownership before asynchronous model configuration", async () => {
    const { backend, root } = await setup({ CODAPTER_MOCK_SETTLE_DELAY: "100" });
    const started = await start(backend, root);
    const input = {
      threadId: "native-thread",
      threadHandle: started.threadHandle,
      cwd: root,
      input: [{ type: "text" as const, text: "hello", text_elements: [] }],
      model: "pi/mock-default",
      reasoningEffort: "low",
    };
    const first = backend.turnStart({ ...input, turnId: "first" });
    const second = backend.turnStart({ ...input, turnId: "second" });
    await expect(second).rejects.toThrow("active turn");
    await expect(first).resolves.toMatchObject({ accepted: true, turnId: "first" });
    await backend.turnInterrupt({
      threadId: "native-thread",
      threadHandle: started.threadHandle,
      turnId: "first",
    });
  });

  it("disposes a partially-started subprocess before it enters the session registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-pi-partial-start-"));
    roots.push(root);
    const backend = new PiBackend({
      sessionDir: root,
      command: process.execPath,
      args: ["-e", "process.stdin.resume();"],
      requestTimeoutMs: 1000,
    });
    backends.push(backend);
    await backend.initialize();
    const startup = backend.createSession();
    const rejection = expect(startup).rejects.toThrow("disposed");
    await backend.dispose();
    await rejection;
    expect(backend.isAlive()).toBe(false);
  });

  it("uses configured pi on PATH without npx or suppression of native resources", async () => {
    const { backend: unused, root, capture } = await setup();
    await unused.dispose();
    const script = await readFile(join(root, "mock-pi-rpc.mjs"), "utf8");
    const bin = join(root, "bin");
    await mkdir(bin);
    const pi = join(bin, "pi");
    await writeFile(pi, `#!${process.execPath}\n${script}`);
    await chmod(pi, 0o700);
    const backend = new PiBackend({
      sessionDir: root,
      env: { PATH: bin, CODAPTER_CAPTURE_PROCESS_PATH: capture },
      idleTimeoutMs: 0,
    });
    backends.push(backend);
    await backend.initialize();
    await start(backend, root);
    const launch = JSON.parse(await readFile(capture, "utf8"));
    expect(launch.argv).toEqual(["--mode", "rpc", "--session-dir", root]);
  });

  it("cleans up a subprocess when a native new_session hook cancels startup", async () => {
    const { backend, root, capture } = await setup({ CODAPTER_MOCK_CANCEL_NEW: "1" });
    await expect(start(backend, root)).rejects.toThrow("new_session was cancelled");
    const launch = JSON.parse(await readFile(capture, "utf8"));
    expect(alive(launch.pid)).toBe(false);
  });

  it("reattaches notifications after idle disposal while preserving the canonical thread id", async () => {
    const { backend, root, capture } = await setup({}, 50);
    const started = await start(backend, root);
    const firstPid = JSON.parse(await readFile(capture, "utf8")).pid;
    const notifications: Array<{ method: string; params: unknown }> = [];
    backend.onEvent(started.threadHandle, (event) => {
      if (event.kind === "notification") notifications.push(event);
    });
    await waitFor(() => (!alive(firstPid) ? true : undefined));
    await backend.turnStart({
      threadId: "native-thread",
      threadHandle: started.threadHandle,
      turnId: "after-idle",
      cwd: root,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: null,
      reasoningEffort: "low",
    });
    const completion = await waitFor(() =>
      notifications.find((event) => event.method === "turn/completed")
    );
    expect(completion.params).toMatchObject({
      threadId: "native-thread",
      turn: { id: "after-idle", status: "completed" },
    });
    expect(JSON.parse(await readFile(capture, "utf8")).pid).not.toBe(firstPid);
  });

  it("does not idle-kill an active turn during a quiet retry or long-running tool", async () => {
    const { backend, root, capture } = await setup({ CODAPTER_MOCK_SETTLE_DELAY: "150" }, 30);
    const started = await start(backend, root);
    const pid = JSON.parse(await readFile(capture, "utf8")).pid;
    await backend.turnStart({
      threadId: "native-thread",
      threadHandle: started.threadHandle,
      turnId: "quiet",
      cwd: root,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: null,
      reasoningEffort: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(true);
  });

  it("surfaces disconnects and rebinds the session after an unexpected exit", async () => {
    const { backend, root, env } = await setup({ CODAPTER_MOCK_EXIT_ON_PROMPT: "1" });
    const started = await start(backend, root);
    const events: Array<{ kind: string; method?: string; params?: unknown }> = [];
    backend.onEvent(started.threadHandle, (event) => events.push(event));
    const input = {
      threadId: "native-thread",
      threadHandle: started.threadHandle,
      cwd: root,
      input: [{ type: "text" as const, text: "hello", text_elements: [] }],
      model: null,
      reasoningEffort: null,
    };
    await expect(backend.turnStart({ ...input, turnId: "failed" })).rejects.toThrow("with code 7");
    expect(events.some((event) => event.kind === "disconnect")).toBe(true);
    expect(events.find((event) => event.method === "turn/completed")?.params).toMatchObject({
      turn: { status: "failed" },
    });
    delete env.CODAPTER_MOCK_EXIT_ON_PROMPT;
    await backend.turnStart({ ...input, turnId: "recovered" });
    await waitFor(() =>
      events.find(
        (event) =>
          event.method === "turn/completed" &&
          (event.params as { turn?: { id: string } })?.turn?.id === "recovered"
      )
    );
  });

  it("rejects unsupported audio and fileId-only images before publishing a started turn", async () => {
    const { backend, root } = await setup();
    const started = await start(backend, root);
    const notifications: string[] = [];
    backend.onEvent(started.threadHandle, (event) => {
      if (event.kind === "notification") notifications.push(event.method);
    });
    for (const input of [
      [{ type: "audio" as const, url: "data:audio/wav;base64,AA==" }],
      [{ type: "localAudio" as const, path: "/tmp/audio.wav" }],
      [{ type: "image" as const, fileId: "file-unavailable" }],
    ]) {
      await expect(
        backend.turnStart({
          threadId: "native-thread",
          threadHandle: started.threadHandle,
          turnId: "invalid",
          cwd: root,
          input,
          model: null,
          reasoningEffort: null,
        })
      ).rejects.toThrow(/Unsupported Pi|fileId-only/);
    }
    expect(notifications).not.toContain("turn/started");
  });
});
