import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));

// A controlled native-process boundary, not a Pi compatibility fixture.
// It refuses prompts and records the launch assets without any inference.
const fixture = `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const root = process.env.CODAPTER_DISTRIBUTION_FIXTURE;
appendFileSync(join(root, "launch.jsonl"), JSON.stringify({
  args: process.argv.slice(2),
  proxy: process.env.CODAPTER_DESKTOP_MCP_PROXY,
  bridge: process.env.CODAPTER_DESKTOP_UDS,
})+"\\n");
const model = {provider:"fixture",id:"deterministic",name:"Fixture",reasoning:true,input:["text"],contextWindow:4096};
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "prompt") throw new Error("Inference forbidden in CLI distribution test");
  let data = {};
  if (command.type === "get_state") data = {sessionId:"fixture",sessionFile:join(root,"native.jsonl"),model,thinkingLevel:"low",isStreaming:false,isCompacting:false};
  if (command.type === "get_available_models") data = {models:[model]};
  if (command.type === "get_available_thinking_levels") data = {levels:["off","low"]};
  if (command.type === "new_session") data = {cancelled:false};
  if (command.type === "set_model") data = {model};
  if (command.type === "get_messages") data = {messages:[]};
  process.stdout.write(JSON.stringify({type:"response",id:command.id,command:command.type,success:true,data})+"\\n");
});
`;

it("ships and resolves Desktop assets beside the relocated CLI bundle, not the caller cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "codapter-dist-wiring-"));
  const scripts = join(root, "scripts");
  const caller = join(root, "caller");
  try {
    await mkdir(scripts);
    await mkdir(caller);
    await mkdir(join(root, "codex"));
    await symlink(join(repository, "packages"), join(root, "packages"), "dir");
    await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    await copyFile(join(repository, "scripts", "build-dist.mjs"), join(scripts, "build-dist.mjs"));
    await exec(process.execPath, [join(scripts, "build-dist.mjs")], { cwd: caller });
    const dist = join(root, "dist");
    for (const asset of [
      "codapter",
      "collab-extension",
      "desktop-extension",
      "desktop-mcp-proxy",
    ]) {
      expect((await stat(join(dist, `${asset}.mjs`))).size).toBeGreaterThan(0);
      await exec(process.execPath, ["--check", join(dist, `${asset}.mjs`)]);
    }
    const fixturePath = join(root, "native-fixture.cjs");
    await writeFile(fixturePath, fixture);
    const child = spawn(process.execPath, [join(dist, "codapter.mjs"), "app-server"], {
      cwd: caller,
      env: {
        ...process.env,
        CODEX_HOME: join(root, "codex"),
        CODAPTER_STATE_DIR: join(root, "state"),
        CODAPTER_CONFIG_FILE: join(root, "adapter.toml"),
        CODAPTER_CODEX_DISABLE: "1",
        CODAPTER_PI_DISABLE: "0",
        CODAPTER_COLLAB: "0",
        CODAPTER_LISTEN: "",
        CODAPTER_PI_COMMAND: process.execPath,
        CODAPTER_PI_ARGS: JSON.stringify([fixturePath]),
        CODAPTER_DISTRIBUTION_FIXTURE: root,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    let nextId = 0;
    const request = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => {
          lines.off("line", onLine);
          reject(new Error(`Timed out waiting for ${method}: ${errors}`));
        }, 2000);
        const onLine = (line: string) => {
          const message = JSON.parse(line);
          if (message.id !== id) return;
          clearTimeout(timeout);
          lines.off("line", onLine);
          resolve(message);
        };
        lines.on("line", onLine);
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    try {
      expect(
        await request("initialize", { clientInfo: { name: "distribution", version: "1" } })
      ).toMatchObject({ result: { userAgent: expect.any(String) } });
      expect(
        await request("thread/start", {
          cwd: caller,
          model: "pi::fixture/deterministic",
          reasoningEffort: "low",
        })
      ).toMatchObject({ result: { thread: { id: expect.any(String) } } });
      const launches = (await readFile(join(root, "launch.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const launch = launches.find((entry) => entry.bridge);
      if (!launch) throw new Error("Desktop session process was not launched");
      expect(launch.args).toContain(join(dist, "desktop-extension.mjs"));
      expect(launch.args).not.toContain(join(dist, "collab-extension.mjs"));
      expect(launch.proxy).toBe(join(dist, "desktop-mcp-proxy.mjs"));
      expect((await stat(launch.bridge)).isSocket()).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await closed;
      lines.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
