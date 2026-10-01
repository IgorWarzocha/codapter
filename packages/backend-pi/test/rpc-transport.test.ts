import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiProcessSession } from "../src/pi-process.js";
import { PiRpcTransport } from "../src/rpc-transport.js";
import { createMockPiScript, waitFor } from "./pi-fixture.js";

const sessions: Array<{ dispose(): Promise<void> }> = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSession(env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "codapter-pi-process-"));
  roots.push(root);
  const script = await createMockPiScript(root);
  const session = new PiProcessSession({
    opaqueSessionId: "owned-session",
    sessionDir: root,
    command: process.execPath,
    args: [script, root],
    env,
  });
  sessions.push(session);
  return session;
}

describe("Pi RPC subprocess lifecycle", () => {
  it("cancels image loading before an interrupted prompt can start native model work", async () => {
    let entered: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = createServer(() => entered?.());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP listener");
      const session = await createSession();
      const prompt = session.prompt("image-aborted", "look", [
        {
          type: "image",
          url: `http://127.0.0.1:${address.port}/stalled.png`,
        },
      ]);
      const rejection = expect(prompt).rejects.toThrow("aborted");
      await requested;
      expect(session.isBusy).toBe(true);
      await session.abort();
      await rejection;
      expect(session.isBusy).toBe(false);
      expect(await session.getMessages()).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects missing executables rather than emitting an unhandled spawn error", async () => {
    const session = new PiProcessSession({
      opaqueSessionId: "missing",
      sessionDir: tmpdir(),
      command: "codapter-missing-pi-command",
    });
    sessions.push(session);
    await expect(session.getState()).rejects.toThrow(/ENOENT/);
    expect(session.isRunning()).toBe(false);
  });

  it("correlates concurrent startup and requests without launching a second subprocess", async () => {
    const session = await createSession();
    const [state, models] = await Promise.all([session.startFresh(), session.getAvailableModels()]);
    expect(state.sessionFile).toBeDefined();
    expect(models).toHaveLength(4);
  });

  it("keeps turn ownership until settled, not assistant message_end or agent_end", async () => {
    const session = await createSession({ CODAPTER_MOCK_SETTLE_DELAY: "150" });
    const events: Array<{ type: string; turnId?: string }> = [];
    session.addListener((event) => events.push(event));
    await session.prompt("turn-owned", "hello");
    await waitFor(() => events.find((event) => event.type === "text_delta"));
    expect(session.isBusy).toBe(true);
    expect(events.some((event) => event.type === "message_end")).toBe(false);
    await expect(session.prompt("overlap", "bad")).rejects.toThrow("active turn");
    const completion = await waitFor(() => events.find((event) => event.type === "message_end"));
    expect(completion.turnId).toBe("turn-owned");
    expect(session.isBusy).toBe(false);
  });

  it("finishes a handled extension command without waiting for a nonexistent run", async () => {
    const session = await createSession({ CODAPTER_MOCK_HANDLED_PROMPT: "1" });
    const completions: string[] = [];
    session.addListener((event) => {
      if (event.type === "message_end") completions.push(event.turnId);
    });
    await session.prompt("handled", "/native-command");
    expect(completions).toEqual(["handled"]);
    expect(session.isBusy).toBe(false);
  });

  it("does not finalize an intermediate provider failure when Pi automatically retries", async () => {
    const session = await createSession({ CODAPTER_MOCK_RETRY: "1" });
    const events: Array<{ type: string; text?: string }> = [];
    session.addListener((event) => events.push(event));
    await session.prompt("retry", "hello");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.isBusy).toBe(true);
    expect(events.some((event) => event.type === "error" || event.type === "message_end")).toBe(
      false
    );
    expect(await waitFor(() => events.find((event) => event.type === "message_end"))).toMatchObject(
      { text: "response-1" }
    );
  });

  it("reports unexpected process exit and rejects the active request", async () => {
    const session = await createSession({ CODAPTER_MOCK_EXIT_ON_PROMPT: "1" });
    const events: string[] = [];
    session.addListener((event) => events.push(event.type));
    await expect(session.prompt("exited", "hello")).rejects.toThrow("with code 7");
    expect(events).toContain("error");
    expect(events).toContain("disconnect");
    expect(session.isRunning()).toBe(false);
    expect(session.isBusy).toBe(false);
  });

  it("rejects stalled commands on deadline and does not silently restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-pi-deadline-"));
    roots.push(root);
    const script = join(root, "stalled.mjs");
    await writeFile(script, "process.stdin.resume();", "utf8");
    const session = new PiProcessSession({
      opaqueSessionId: "stalled",
      sessionDir: root,
      command: process.execPath,
      args: [script],
      requestTimeoutMs: 100,
    });
    sessions.push(session);
    await expect(session.getState()).rejects.toThrow("get_state timed out");
    await expect(session.getState()).rejects.toThrow("get_state timed out");
  });

  it("rejects pending commands on idempotent disposal and shuts down through stdin EOF", async () => {
    const written: string[] = [];
    const transport = new PiRpcTransport({
      command: process.execPath,
      args: [
        "-e",
        `let buffer = ''; process.stdin.on('data', chunk => {
        buffer += chunk; const lines = buffer.split('\\n'); buffer = lines.pop();
        for (const line of lines) { const c = JSON.parse(line);
          if (c.type === 'get_state') process.stdout.write(JSON.stringify({ id:c.id, type:'response', command:c.type, success:true, data:{} })+'\\n');
        }
      }); process.stdin.on('end', () => process.exit(0));`,
      ],
      cwd: process.cwd(),
      env: process.env,
      requestTimeoutMs: 1000,
      onEvent: () => {},
      onDisconnect: () => {},
      log: (kind, raw) => {
        if (kind === "stdin") written.push(raw);
      },
    });
    sessions.push(transport);
    await transport.start();
    const request = transport.request({ type: "get_messages" });
    const rejection = expect(request).rejects.toThrow("disposed");
    await waitFor(() => written.find((line) => line.includes("get_messages")));
    await Promise.all([transport.dispose(), transport.dispose(), rejection]);
    expect(transport.exitCode).toBe(0);
    await expect(transport.start()).rejects.toThrow("disposed");
  });
});
