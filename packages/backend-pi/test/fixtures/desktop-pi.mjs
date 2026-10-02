import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const flags = process.argv.slice(2);
const sessionDir = flags[flags.indexOf("--session-dir") + 1];
const extensionPath = flags.at(-1);
const extension = process.env.CODAPTER_DESKTOP_UDS
  ? (await import(pathToFileURL(extensionPath).href)).default
  : () => {};
const tools = new Map([["exec", { name: "exec", exposure: "direct" }]]);
const mcp = new Map([["native", { command: "native-server" }]]);
const handlers = new Map();
let sessionFile = join(sessionDir, `${randomUUID()}.jsonl`);
let busy = false;
let controller;
const capture = {
  pid: process.pid,
  argv: flags,
  endpoint: process.env.CODAPTER_DESKTOP_UDS,
  prompts: [],
  results: [],
  errors: [],
  sessionMcp: [],
  mcpRegistrations: [],
};
const persist = () => writeFile(process.env.CODAPTER_DESKTOP_CAPTURE, JSON.stringify(capture));
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id, command, data) =>
  write({ type: "response", id, command, success: true, data });
const emit = async (name, event = {}) => {
  if (name === "session_start") capture.sessionMcp.push([...mcp.keys()]);
  const results = [];
  for (const handler of handlers.get(name) ?? []) {
    try {
      results.push(await handler(event));
    } catch (error) {
      capture.errors.push(error.message);
      write({ type: "extension_error", error: error.message });
    }
  }
  return results;
};
extension({
  on(name, handler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
  getAllTools() {
    return [...tools.values()];
  },
  registerTool(tool) {
    if (tool.name === "exec") throw new Error("Replaced native tool");
    tools.set(tool.name, tool);
  },
  registerMcpServer(name, config) {
    if (name === process.env.CODAPTER_DESKTOP_MCP_REJECT)
      throw new Error("MCP registration rejected by native runtime");
    mcp.set(name, config);
    capture.mcpRegistrations.push(name);
  },
  unregisterMcpServer(name) {
    mcp.delete(name);
  },
});
await emit("session_start");
await persist();

async function prompt(message) {
  busy = true;
  controller = new AbortController();
  const spec = JSON.parse(message);
  await emit("input");
  const event = { systemPromptOptions: { appendSystemPrompt: "Native instructions" } };
  if (spec.forcePrompt) event.systemPromptOptions.forceSystemPrompt = spec.forcePrompt;
  await emit("before_agent_start", event);
  capture.prompts.push({
    tools: [...tools.values()].map(({ name, exposure, parameters }) => ({
      name,
      exposure,
      parameters,
    })),
    mcp: Object.fromEntries(mcp),
    instructions:
      event.systemPromptOptions.forceSystemPrompt ?? event.systemPromptOptions.appendSystemPrompt,
  });
  await persist();
  if (spec.tool) {
    const tool = tools.get(spec.executeAs ?? spec.tool);
    const callId = spec.callId ?? "gui-call";
    write({
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: spec.tool,
      args: spec.args ?? {},
    });
    let result;
    let isError = false;
    try {
      if (tool.exposure === "hidden") throw new Error("Tool hidden");
      result = await tool.execute(callId, spec.args ?? {}, controller.signal);
      isError = result.isError === true;
    } catch (error) {
      isError = true;
      result = {
        content: [{ type: "text", text: error.message }],
        details: {},
      };
    }
    capture.results.push({ result, isError });
    await persist();
    write({ type: "tool_execution_end", toolCallId: callId, toolName: spec.tool, result, isError });
  }
  busy = false;
  write({ type: "agent_settled" });
}

async function command({ id, type, ...params }) {
  if (type === "get_state")
    return response(id, type, { sessionId: "fixture", sessionFile, isStreaming: busy });
  if (type === "new_session") {
    await emit("session_before_switch");
    sessionFile = join(sessionDir, `${randomUUID()}.jsonl`);
    await emit("session_start");
    await persist();
    return response(id, type, { cancelled: false });
  }
  if (type === "switch_session") {
    await emit("session_before_switch");
    sessionFile = params.sessionPath;
    await emit("session_start");
    await persist();
    return response(id, type, { cancelled: false });
  }
  if (type === "clone") {
    await emit("session_before_fork");
    sessionFile += ".fork";
    await emit("session_start");
    await persist();
    return response(id, type, { cancelled: false });
  }
  if (type === "get_messages") return response(id, type, { messages: [] });
  if (type === "get_available_models") return response(id, type, { models: [] });
  if (type === "get_available_thinking_levels")
    return response(id, type, { levels: ["off", "low"] });
  if (type === "get_session_stats") return response(id, type, { tokens: {} });
  if (type === "abort") {
    controller?.abort(new Error("Native abort"));
    return response(id, type);
  }
  if (type === "prompt") {
    response(id, type);
    await prompt(params.message);
    return;
  }
  throw new Error(`Unsupported command ${type}`);
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  void command(JSON.parse(line)).catch(async (error) => {
    capture.errors.push(error.message);
    await persist();
    write({ type: "extension_error", error: error.message });
  });
});
input.on("close", () => {
  controller?.abort();
  void emit("session_shutdown");
});
