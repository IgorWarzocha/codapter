import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runCli } from "../src/index.js";

function stdioClient(stdin: PassThrough, stdout: PassThrough) {
  let id = 0;
  return async (method: string, params: unknown = {}) => {
    const response = once(stdout, "data");
    stdin.write(`${JSON.stringify({ id: ++id, method, params })}\n`);
    const [chunk] = await response;
    return JSON.parse(chunk.toString());
  };
}

async function wsRequest(socket: WebSocket, method: string, params: unknown = {}) {
  const response = once(socket, "message");
  socket.send(JSON.stringify({ id: 1, method, params }));
  const [payload] = await response;
  return JSON.parse(payload.toString());
}

describe("Desktop CLI composition", () => {
  it.each(["default stdio", "stdio and websocket"])(
    "shares native overrides and adapter writes through %s",
    async (transport) => {
      const root = await mkdtemp(join(tmpdir(), "codapter-cli-desktop-"));
      const home = join(root, "codex");
      const marketplace = join(root, "bundled");
      const manifestDirectory = join(marketplace, ".agents", "plugins");
      const pluginDirectory = join(marketplace, "plugins", "browser", ".codex-plugin");
      await mkdir(home, { recursive: true });
      await mkdir(manifestDirectory, { recursive: true });
      await mkdir(pluginDirectory, { recursive: true });
      await writeFile(
        join(manifestDirectory, "marketplace.json"),
        JSON.stringify({
          name: "bundled",
          plugins: [{ name: "browser", source: { source: "local", path: "./plugins/browser" } }],
        })
      );
      await writeFile(
        join(pluginDirectory, "plugin.json"),
        JSON.stringify({
          name: "browser",
          version: "1.0.0",
          description: "CLI fixture browser",
        })
      );
      await writeFile(
        join(home, "config.toml"),
        [
          'model = "native-model-not-pi"',
          "[marketplaces.bundled]",
          'source_type = "local"',
          `source = ${JSON.stringify(marketplace)}`,
          '[plugins."browser@bundled"]',
          "enabled = false",
        ].join("\n")
      );
      const adapterPath = join(root, "adapter.toml");
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const controller = new AbortController();
      const stdio = stdioClient(stdin, stdout);
      const listening = once(stderr, "data");
      const args = [
        "-c",
        'plugins."browser@bundled".enabled=true',
        "-c",
        'mcp_servers.local.http_headers={Authorization="Bearer private=token"}',
        "app-server",
        ...(transport === "default stdio"
          ? []
          : ["--listen", "stdio", "--listen", "ws://127.0.0.1:0"]),
      ];
      const running = runCli(args, {
        stdin,
        stdout,
        stderr,
        shutdownSignal: controller.signal,
        env: {
          CODEX_HOME: home,
          CODAPTER_CONFIG_FILE: adapterPath,
          CODAPTER_PI_DISABLE: "1",
          CODAPTER_CODEX_DISABLE: "1",
        },
      });
      let socket: WebSocket | undefined;
      try {
        await expect(
          stdio("initialize", { clientInfo: { name: "cli-desktop", version: "1" } })
        ).resolves.toMatchObject({ result: { userAgent: expect.any(String) } });
        const read = await stdio("config/read", { includeLayers: true });
        expect(read).toMatchObject({
          result: {
            config: {
              model: null,
              plugins: { "browser@bundled": { enabled: true } },
              mcp_servers: { local: { http_headers: { Authorization: "Bearer private=token" } } },
            },
          },
        });
        await expect(stdio("plugin/read", { pluginName: "browser" })).resolves.toMatchObject({
          result: { plugin: { summary: { id: "browser@bundled", enabled: true } } },
        });
        let write = stdio;
        if (transport !== "default stdio") {
          const [line] = await listening;
          const address = line.toString().match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (!address) throw new Error("Missing websocket address");
          socket = new WebSocket(address);
          await once(socket, "open");
          const peer = socket;
          await wsRequest(peer, "initialize", { clientInfo: { name: "cli-ws", version: "1" } });
          expect(await wsRequest(peer, "config/read", { includeLayers: true })).toEqual({
            ...read,
            id: 1,
          });
          write = (method, params) => wsRequest(peer, method, params);
        }
        expect(
          await write("config/value/write", {
            keyPath: 'plugins."browser@bundled".enabled',
            value: false,
            mergeStrategy: "replace",
          })
        ).toMatchObject({ result: { status: "ok" } });
        await expect(stdio("config/read", {})).resolves.toMatchObject({
          result: { config: { plugins: { "browser@bundled": { enabled: false } } } },
        });
        await expect(stdio("plugin/read", { pluginName: "browser" })).resolves.toMatchObject({
          result: { plugin: { summary: { enabled: false } } },
        });
        expect(await readFile(adapterPath, "utf8")).toContain("enabled = false");
        expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain("Authorization");
      } finally {
        socket?.terminate();
        controller.abort();
        stdin.end();
        expect(await running).toEqual({ exitCode: 0 });
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
