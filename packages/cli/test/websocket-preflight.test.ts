import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiBackend } from "@codapter/backend-pi";
import { BackendRouter, type JsonRpcResponse } from "@codapter/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startAppServerListeners } from "../src/index.js";

afterEach(() => vi.unstubAllEnvs());

// The native prompt preflight cannot acknowledge until an extension receives
// its UI response. No model or installed provider is involved in this fixture.
const preflightPi = `
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
const root = process.env.CODAPTER_WS_FIXTURE_ROOT;
const model = {provider:'mock',id:'fixture',name:'Fixture',reasoning:true,input:['text'],contextWindow:4096};
const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
const ok = (command, data={}) => out({type:'response',id:command.id,command:command.type,success:true,data});
let prompt;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  switch (command.type) {
    case 'get_state':
      ok(command,{sessionId:'fixture-session',sessionFile:join(root,'session.jsonl'),model,thinkingLevel:'off'}); break;
    case 'get_available_models': ok(command,{models:[model]}); break;
    case 'get_available_thinking_levels': ok(command,{levels:['off','low']}); break;
    case 'get_messages': ok(command,{messages:[]}); break;
    case 'new_session': ok(command,{cancelled:false}); break;
    case 'set_model': ok(command,{model}); break;
    case 'prompt':
      prompt = command;
      out({type:'extension_ui_request',id:'preflight-dialog',method:'input',title:'Extension input'}); break;
    case 'extension_ui_response':
      writeFileSync(join(root,'dialog-response.json'),JSON.stringify(command));
      if (command.id === 'preflight-dialog' && command.value === 'answer') {
        ok(prompt,{disposition:'handled'});
      } else {
        out({type:'response',id:prompt.id,command:'prompt',success:false,error:'Incorrect native UI response'});
      }
      break;
    default: ok(command);
  }
});
`;

function rpcClient(socket: WebSocket) {
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  socket.on("message", (payload) => {
    const message = JSON.parse(payload.toString());
    const waiting = pending.get(message.id);
    if (waiting && !message.method) {
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      waiting.resolve(message);
    }
    for (const listener of listeners) {
      listener(message);
    }
  });
  return {
    send(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, 2000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    onMessage(listener: (message: Record<string, unknown>) => void) {
      listeners.add(listener);
    },
    dispose() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("RPC test client disposed"));
      }
      pending.clear();
      listeners.clear();
    },
  };
}

describe("WebSocket request dispatch", () => {
  it.each(["tcp", "unix"])(
    "answers a native preflight dialog over %s before turn/start acknowledges",
    async (transport) => {
      const root = await mkdtemp(join(tmpdir(), "codapter-ws-preflight-"));
      vi.stubEnv("CODAPTER_STATE_DIR", root);
      vi.stubEnv("CODAPTER_CONFIG_FILE", join(root, "config.toml"));
      const backend = createPiBackend({
        sessionDir: root,
        command: process.execPath,
        args: ["-e", preflightPi, "--"],
        env: { CODAPTER_WS_FIXTURE_ROOT: root },
        requestTimeoutMs: 1000,
        idleTimeoutMs: 0,
      });
      await backend.initialize();
      const socketPath = join(root, "app-server.sock");
      const listeners = await startAppServerListeners(
        [transport === "tcp" ? "ws://127.0.0.1:0" : `unix://${socketPath}`],
        {
          backendRouter: new BackendRouter([backend]),
        }
      );
      const socket = new WebSocket(
        transport === "tcp" ? listeners.addresses[0] : `ws+unix://${socketPath}:/`
      );
      const client = rpcClient(socket);
      let dialogs = 0;
      client.onMessage((message) => {
        if (message.method !== "item/tool/requestUserInput") {
          return;
        }
        dialogs += 1;
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { answers: { "preflight-dialog": { answers: ["answer"] } } },
          })
        );
      });
      try {
        await once(socket, "open");
        expect(
          await client.send("initialize", {
            clientInfo: { name: "preflight-test", version: "0.0.4" },
          })
        ).toHaveProperty("result");
        socket.send(JSON.stringify({ method: "initialized" }));
        const started = await client.send("thread/start", { model: "pi::mock/fixture", cwd: root });
        expect(started).toHaveProperty("result.thread.id");
        const threadId = (started as { result: { thread: { id: string } } }).result.thread.id;
        const turn = await client.send("turn/start", {
          threadId,
          input: [{ type: "text", text: "/extension", text_elements: [] }],
        });
        expect(turn).toHaveProperty("result.turn.id");
        expect(dialogs).toBe(1);
        expect(
          JSON.parse(await readFile(join(root, "dialog-response.json"), "utf8"))
        ).toMatchObject({
          type: "extension_ui_response",
          id: "preflight-dialog",
          value: "answer",
        });
      } finally {
        client.dispose();
        socket.terminate();
        await backend.dispose();
        await listeners.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("processes control requests while a command/exec request is still running", async () => {
    const listeners = await startAppServerListeners(["ws://127.0.0.1:0"], {
      backendRouter: new BackendRouter(),
    });
    const socket = new WebSocket(listeners.addresses[0]);
    const client = rpcClient(socket);
    let command: Promise<JsonRpcResponse> | undefined;
    let started: () => void = () => {};
    const commandStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.onMessage((message) => {
      if (message.method === "command/exec/outputDelta") {
        started();
      }
    });
    try {
      await once(socket, "open");
      expect(
        await client.send("initialize", {
          clientInfo: { name: "control-test", version: "0.0.4" },
        })
      ).toHaveProperty("result");
      command = client.send("command/exec", {
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('started'); setInterval(() => {}, 1000)",
        ],
        processId: "ws-control-command",
        streamStdoutStderr: true,
        disableTimeout: true,
      });
      // A failing control assertion must still observe this background request.
      void command.catch(() => {});
      await Promise.race([commandStarted, command]);
      expect(await client.send("account/read")).toMatchObject({ result: { account: null } });
      expect(
        await client.send("command/exec/terminate", { processId: "ws-control-command" })
      ).toHaveProperty("result");
      expect(await command).toHaveProperty("result.exitCode");
    } finally {
      client.dispose();
      socket.terminate();
      await listeners.close();
      await command?.catch(() => {});
    }
  });
});
