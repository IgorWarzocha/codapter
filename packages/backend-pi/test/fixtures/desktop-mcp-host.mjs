import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const reply = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Set();
const elicitations = new Map();
let clientCapabilities = {};
if (process.argv.includes("--stubborn")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    clientCapabilities = message.params.capabilities;
    reply({
      id: message.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" },
      },
    });
  } else if (message.method === "tools/call") {
    const { name, arguments: args, _meta } = message.params;
    if (name === "turn_ended") {
      appendFileSync(process.env.CAPTURE, `${JSON.stringify(args)}\n`);
      reply({ id: message.id, result: { content: [] } });
    } else if (name === "hang") {
      pending.add(message.id);
      reply({
        method: "notifications/progress",
        params: { progressToken: "working", progress: 1 },
      });
    } else if (name === "crash") {
      process.exit(17);
    } else if (name === "permission") {
      const id = `permission-${message.id}`;
      elicitations.set(id, message.id);
      reply({
        id,
        method: "elicitation/create",
        params: {
          message: "Allow this fixture action?",
          mode: "form",
          requestedSchema: { type: "object", properties: { note: { type: "string" } } },
          _meta: { app: { threadId: "opaque-application-id" } },
        },
      });
    } else {
      reply({
        id: message.id,
        result: {
          content: [{ type: "text", text: "fixture result" }],
          structuredContent: {
            args,
            requestMeta: _meta,
            env: process.env,
            pid: process.pid,
            clientCapabilities,
          },
          _meta: { "openai/outputTemplate": "ui://test/widget", threadId: "opaque-app-thread" },
        },
      });
    }
  } else if (
    message.method === "notifications/cancelled" &&
    pending.delete(message.params.requestId)
  ) {
    reply({ id: message.params.requestId, error: { code: -32800, message: "Cancelled" } });
  } else if (elicitations.has(message.id)) {
    const id = elicitations.get(message.id);
    elicitations.delete(message.id);
    reply({
      id,
      result: { content: [], structuredContent: message, isError: Boolean(message.error) },
    });
  } else if (message.id !== undefined) {
    reply({ id: message.id, result: message.params ?? {} });
  }
});
