import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DesktopMcpCallEvent } from "../src/chatgpt-apps-relay.js";
import { type PiProcessEvent, PiTurnStream } from "../src/turn-stream.js";

function fixture(servers: readonly string[] = ["codex_apps", "node_repl"]) {
  const events: PiProcessEvent[] = [];
  const stream = new PiTurnStream(
    "session",
    (event) => events.push(event),
    async () => ({}),
    () => {},
    null,
    () => servers
  );
  stream.begin("turn");
  const native = (
    type: "start" | "update" | "end",
    toolName = "mcp__node_repl__js",
    id = "native-call",
    extra: Record<string, unknown> = {}
  ) =>
    stream.handleEvent({
      type: `tool_execution_${type}`,
      toolCallId: id,
      toolName,
      args: { code: "opaque" },
      partialResult: { content: [{ type: "text", text: "partial" }] },
      result: { content: [{ type: "text", text: "native model-facing output" }] },
      ...extra,
    });
  const raw = (phase: "started" | "completed", extra: Partial<DesktopMcpCallEvent> = {}) =>
    stream.handleDesktopMcpEvent({
      phase,
      threadId: "thread",
      turnId: "turn",
      callId: "raw-call",
      server: "node_repl",
      tool: "js",
      arguments: { code: "opaque" },
      ...extra,
    });
  return { events, stream, native, raw };
}

describe("raw-instrumented direct MCP event filtering", () => {
  it.each([false, true])(
    "retains only raw started/completed, including transport error=%s and opaque metadata",
    (failed) => {
      const { events, native, raw } = fixture();
      native("start");
      native("update");
      expect(events).toEqual([]);
      raw("started");
      const completion = failed
        ? { error: { code: -32000, message: "upstream unavailable" } }
        : { result: { _meta: { retained: true }, content: [{ type: "text", text: "raw" }] } };
      raw("completed", completion);
      native("end", undefined, undefined, { isError: failed });
      expect(events).toMatchObject([
        { type: "desktop_mcp_event", phase: "started" },
        { type: "desktop_mcp_event", phase: "completed", ...completion },
      ]);
    }
  );

  it("keeps failures before transport instrumentation visible instead of hiding their native errors", () => {
    const { events, native } = fixture();
    native("start");
    native("update");
    native("end", undefined, undefined, {
      isError: true,
      result: { content: [{ type: "text", text: "Pi authentication failed" }] },
    });
    expect(events).toMatchObject([
      { type: "tool_start" },
      { type: "tool_update" },
      {
        type: "tool_end",
        isError: true,
        output: { content: [{ text: "Pi authentication failed" }] },
      },
    ]);
  });

  it.each(["mcp__ordinary__js", "mcp__node_repl_other__js", "exec"])(
    "does not delay or suppress %s",
    (name) => {
      const { events, native } = fixture();
      native("start", name);
      expect(events).toMatchObject([{ type: "tool_start", toolName: name }]);
      native("update", name);
      native("end", name);
      expect(events.map((event) => event.type)).toEqual(["tool_start", "tool_update", "tool_end"]);
    }
  );

  it("does not suppress an ordinary MCP server even if an unrelated raw event names it", () => {
    const { events, native, raw } = fixture([]);
    native("start");
    raw("started");
    raw("completed");
    native("end");
    expect(events.map((event) => event.type)).toEqual([
      "tool_start",
      "desktop_mcp_event",
      "desktop_mcp_event",
      "tool_end",
    ]);
  });

  it("matches source-defined sanitized and hashed native names without parsing connector identity", () => {
    const tool = "a-punctuated-original-name";
    const plain = `mcp__codex_apps__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
    const hash = createHash("sha256").update(`codex_apps\0${tool}`).digest("hex").slice(0, 8);
    for (const name of [plain, `${plain.slice(0, 55)}_${hash}`]) {
      const { events, native, raw } = fixture();
      native("start", name);
      raw("started", { server: "codex_apps", tool });
      raw("completed", { server: "codex_apps", tool });
      native("end", name);
      expect(events.every((event) => event.type === "desktop_mcp_event")).toBe(true);
    }
  });

  it("does not consume raw calls from another turn, tool or argument set", () => {
    const { events, native, raw } = fixture();
    native("start");
    raw("started", { turnId: "stale-turn" });
    raw("started", { tool: "other-tool" });
    raw("started", { arguments: { code: "another-call" } });
    native("end");
    expect(
      events.filter((event) => event.type === "tool_start" || event.type === "tool_end")
    ).toHaveLength(2);
  });

  it("uses native exact result metadata when hooks or schema defaults changed the initial arguments", () => {
    const { events, native, raw } = fixture();
    native("start");
    raw("started", { arguments: { code: "hook-modified" } });
    raw("completed", { arguments: { code: "hook-modified" } });
    native("end", undefined, undefined, {
      result: { content: [], details: { server: "node_repl", tool: "js" } },
    });
    expect(events.every((event) => event.type === "desktop_mcp_event")).toBe(true);
  });

  it("consumes one raw call per native call and clears evidence on settling", () => {
    const { events, native, raw, stream } = fixture();
    raw("started");
    raw("completed");
    native("start", undefined, "first");
    native("end", undefined, "first");
    native("start", undefined, "second");
    native("end", undefined, "second");
    expect(events.filter((event) => event.type === "tool_start")).toMatchObject([
      { toolCallId: "second" },
    ]);
    stream.handleEvent({ type: "agent_settled" });
    stream.begin("turn");
    native("start", undefined, "next-turn");
    stream.disconnect(new Error("native process exited"));
    expect(events.filter((event) => event.type === "tool_start")).toMatchObject([
      { toolCallId: "second" },
      { toolCallId: "next-turn" },
    ]);
  });

  it("does not release a duplicate native start when an instrumented call is cancelled before native end", () => {
    const { events, native, raw, stream } = fixture();
    native("start");
    raw("started");
    raw("completed", { error: { code: -32800, message: "process disconnected" } });
    stream.disconnect(new Error("process disconnected"));
    expect(events.map((event) => event.type)).toEqual([
      "desktop_mcp_event",
      "desktop_mcp_event",
      "error",
      "disconnect",
    ]);
  });
});
