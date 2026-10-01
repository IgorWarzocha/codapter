import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type PiProcessEvent, PiProcessSession } from "../src/pi-process.js";
import { waitFor } from "./pi-fixture.js";

const sessions: PiProcessSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

function createPreflightSession(mode: string) {
  // Controlled JSONL child reproduces native event/ack ordering without inference.
  const script = `
    const mode = process.argv[1];
    const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const ok = (command, data) => out({ id: command.id, type: 'response', command: command.type, success: true, data });
    let prompt;
    let active = false;
    let started = false;
    function start() { started = true; active = true; out({ type: 'agent_start' }); }
    function answer() {
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'extension answer' } });
      out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'extension answer' }] } });
      active = false;
      out({ type: 'agent_settled' });
    }
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const command = JSON.parse(line);
      if (command.type === 'get_state') {
        if (prompt && mode === 'start-during-state' && !started) {
          start();
          // An activity event wins even if this reply carries an idle snapshot.
          ok(command, { sessionId: 'fixture', isStreaming: false, pendingMessageCount: 0 });
          setTimeout(answer, 80);
          return;
        }
        ok(command, { sessionId: 'fixture', isStreaming: active, pendingMessageCount: 0 });
      } else if (command.type === 'prompt') {
        prompt = command;
        if (mode === 'human' || mode === 'dispose') {
          out({ type: 'extension_ui_request', id: 'preflight-dialog', method: 'input', title: 'Human preflight' });
        } else if (mode === 'long-command') {
          setTimeout(() => ok(command, { disposition: 'handled' }), 450);
        } else if (mode === 'start-before-ack') {
          start(); ok(command, { disposition: 'handled' }); setTimeout(answer, 80);
        } else if (mode === 'active-before-event') {
          active = true; ok(command, { disposition: 'handled' });
          setTimeout(start, 40); setTimeout(answer, 80);
        } else {
          ok(command, { disposition: 'handled' });
        }
      } else if (command.type === 'extension_ui_response') {
        ok(prompt, { disposition: 'handled' });
      } else {
        ok(command, {});
      }
    });`;
  const session = new PiProcessSession({
    opaqueSessionId: "preflight-session",
    sessionDir: tmpdir(),
    command: process.execPath,
    args: ["-e", script, "--", mode],
    requestTimeoutMs: 200,
  });
  sessions.push(session);
  const events: PiProcessEvent[] = [];
  session.addListener((event) => events.push(event));
  return { session, events };
}

describe("native extension prompt preflight", () => {
  it.each(["start-before-ack", "start-during-state", "active-before-event"])(
    "keeps a handled prompt associated with extension work: %s",
    async (mode) => {
      const { session, events } = createPreflightSession(mode);
      await session.prompt("review-turn", "/review");
      expect(session.isBusy).toBe(true);
      expect(events.some((event) => event.type === "message_end")).toBe(false);
      const completion = await waitFor(() => events.find((event) => event.type === "message_end"));
      expect(completion).toMatchObject({ turnId: "review-turn", text: "extension answer" });
      expect(events.find((event) => event.type === "text_delta")).toMatchObject({
        turnId: "review-turn",
        delta: "extension answer",
      });
      expect(session.isBusy).toBe(false);
    }
  );

  it("lets human preflight exceed the machine RPC deadline and answer normally", async () => {
    const { session, events } = createPreflightSession("human");
    const prompt = session.prompt("human-turn", "/ask-first");
    await waitFor(() => events.find((event) => event.type === "elicitation_request"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(session.isRunning()).toBe(true);
    expect(session.isBusy).toBe(true);
    expect(events.some((event) => event.type === "error" || event.type === "disconnect")).toBe(
      false
    );
    await session.respondToElicitation("preflight-dialog", { value: "Proceed" });
    await prompt;
    expect(events.find((event) => event.type === "message_end")).toMatchObject({
      turnId: "human-turn",
    });
    expect(session.isBusy).toBe(false);
  });

  it("lets extension-command work exceed the machine deadline without a dialog", async () => {
    const { session, events } = createPreflightSession("long-command");
    await session.prompt("long-review", "/review");
    expect(session.isRunning()).toBe(true);
    expect(events.find((event) => event.type === "message_end")).toMatchObject({
      turnId: "long-review",
    });
    expect(events.some((event) => event.type === "disconnect")).toBe(false);
  });

  it("still rejects an unbounded prompt when its session is disposed", async () => {
    const { session, events } = createPreflightSession("dispose");
    const prompt = session.prompt("disposed-preflight", "/ask-first");
    const rejection = expect(prompt).rejects.toThrow("disposed");
    await waitFor(() => events.find((event) => event.type === "elicitation_request"));
    await session.dispose();
    await rejection;
    expect(session.isRunning()).toBe(false);
    expect(session.isBusy).toBe(false);
  });
});
