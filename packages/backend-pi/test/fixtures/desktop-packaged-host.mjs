#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Model the packaged host boundary that clears the helper's entire environment.
const helperEnv = {};
async function helper(args, requests = []) {
  const child = spawn(process.env.CODEX_CLI_PATH, args, {
    env: helperEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || "Helper failed"))
    );
  });
  child.stdin.end(
    requests.map((request) => JSON.stringify(request)).join("\n") + (requests.length ? "\n" : "")
  );
  await exited;
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const reply = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  try {
    if (message.method === "initialize") {
      reply({
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "packaged-fixture", version: "1" },
        },
      });
    } else if (message.method === "tools/call" && message.params.name === "turn_ended") {
      appendFileSync(process.env.CAPTURE, `${JSON.stringify(message.params.arguments)}\n`);
      reply({ id: message.id, result: { content: [] } });
    } else if (message.method === "tools/call") {
      const authReplies = await helper(
        ["app-server", "--listen", "stdio://"],
        [
          {
            id: "init",
            method: "initialize",
            params: { clientInfo: { name: "packaged-node-repl", version: "1" } },
          },
          { method: "initialized" },
          { id: "auth", method: "getAuthStatus", params: { includeToken: true } },
        ]
      );
      const auth = authReplies.find((response) => response.id === "auth");
      if (!auth?.result) throw new Error("Auth helper did not return native provider credentials");
      const [sandbox] = await helper([
        "sandbox",
        "--policy",
        "fixture-policy",
        "--",
        "opaque argument",
      ]);
      reply({
        id: message.id,
        result: {
          content: [],
          structuredContent: {
            helper: process.env.CODEX_CLI_PATH,
            helperEnvKeys: Object.keys(helperEnv),
            auth: auth.result,
            sandbox,
          },
        },
      });
    } else if (message.id !== undefined) {
      reply({ id: message.id, result: {} });
    }
  } catch (error) {
    reply({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
