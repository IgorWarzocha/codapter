import { rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { PassThrough } from "node:stream";
import { createPiBackend } from "@codapter/backend-pi";
import { BackendRouter } from "@codapter/core";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createUnixSocketPath,
  getSocketMode,
  getTcpListenerPort,
  startAppServerListeners,
} from "../src/index.js";

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function connectWebSocket(
  address: string,
  init?: { headers?: Record<string, string> }
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(address, {
      headers: init?.headers,
    });

    websocket.once("open", () => resolve(websocket));
    websocket.once("error", reject);
  });
}

function waitForWebSocketMessage(websocket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    websocket.once("message", (payload) => {
      try {
        resolve(JSON.parse(payload.toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    websocket.once("error", reject);
  });
}

async function startListeners(listenTargets: readonly string[]) {
  const backend = createPiBackend();
  await backend.initialize();
  const listeners = await startAppServerListeners(listenTargets, {
    backendRouter: new BackendRouter([backend]),
  });
  return {
    listeners,
    async close() {
      await listeners.close();
      await backend.dispose();
    },
  };
}

describe("startAppServerListeners", () => {
  it("rejects non-root websocket listen paths", async () => {
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners(["ws://127.0.0.1:0/rpc"], {
          backendRouter: new BackendRouter([backend]),
        })
      ).rejects.toThrow("Unsupported WebSocket path in listen target: ws://127.0.0.1:0/rpc");
    } finally {
      await backend.dispose();
    }
  });
  it("serves initialize over TCP WebSocket and health probes over HTTP", async () => {
    const runtime = await startListeners(["ws://127.0.0.1:0"]);

    try {
      const address = runtime.listeners.addresses[0];
      const websocket = await connectWebSocket(address);
      websocket.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          },
        })
      );

      expect(await waitForWebSocketMessage(websocket)).toMatchObject({
        id: 1,
        result: {
          userAgent: expect.any(String),
        },
      });

      websocket.close();

      const port = getTcpListenerPort(address);
      await expect(httpGet(`http://127.0.0.1:${port}/healthz`)).resolves.toEqual({
        statusCode: 200,
        body: "ok",
      });
      await expect(httpGet(`http://127.0.0.1:${port}/readyz`)).resolves.toEqual({
        statusCode: 200,
        body: "ok",
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects websocket upgrades with an Origin header", async () => {
    const runtime = await startListeners(["ws://127.0.0.1:0"]);

    try {
      const address = runtime.listeners.addresses[0];
      await expect(
        connectWebSocket(address, { headers: { Origin: "https://example.com" } })
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await runtime.close();
    }
  });

  it("creates UDS listeners with secure permissions and removes them on shutdown", async () => {
    const socketPath = await createUnixSocketPath();
    const runtime = await startListeners([`unix://${socketPath}`]);

    const stats = await stat(socketPath);
    expect(stats.isSocket()).toBe(true);
    expect(getSocketMode(stats.mode)).toBe(0o600);

    await runtime.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves initialize over stdio alongside TCP WebSocket", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.setEncoding("utf8");

    const backend = createPiBackend();
    await backend.initialize();

    try {
      const listeners = await startAppServerListeners(["stdio", "ws://127.0.0.1:0"], {
        backendRouter: new BackendRouter([backend]),
        stdin,
        stdout,
      });

      try {
        // Test stdio listener
        const stdioResponse = new Promise<unknown>((resolve) => {
          stdout.once("data", (chunk: string) => {
            resolve(JSON.parse(chunk));
          });
        });

        stdin.write(
          `${JSON.stringify({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
              capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
            },
          })}\n`
        );

        expect(await stdioResponse).toMatchObject({
          id: 1,
          result: { userAgent: expect.any(String) },
        });

        // Test TCP WebSocket listener concurrently
        const wsAddress = listeners.addresses.find((a) => a.startsWith("ws://"));
        expect(wsAddress).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        const websocket = await connectWebSocket(wsAddress!);
        websocket.send(
          JSON.stringify({
            id: 2,
            method: "initialize",
            params: {
              clientInfo: { name: "codapter-test-ws", title: null, version: "0.0.1" },
              capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
            },
          })
        );

        expect(await waitForWebSocketMessage(websocket)).toMatchObject({
          id: 2,
          result: { userAgent: expect.any(String) },
        });

        websocket.close();
      } finally {
        stdin.end();
        await listeners.close();
      }
    } finally {
      await backend.dispose();
    }
  });

  it("rejects duplicate stdio listeners", async () => {
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners(["stdio", "stdio"], {
          backendRouter: new BackendRouter([backend]),
          stdin: new PassThrough(),
          stdout: new PassThrough(),
        })
      ).rejects.toThrow("Only one stdio listener is allowed");
    } finally {
      await backend.dispose();
    }
  });

  it("rejects stdio listener without stdin/stdout streams", async () => {
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners(["stdio"], { backendRouter: new BackendRouter([backend]) })
      ).rejects.toThrow("stdio listener requires stdin and stdout streams");
    } finally {
      await backend.dispose();
    }
  });

  it("rejects replacing a non-socket UDS path", async () => {
    const socketPath = await createUnixSocketPath();
    await writeFile(socketPath, "not-a-socket", "utf8");
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners([`unix://${socketPath}`], {
          backendRouter: new BackendRouter([backend]),
        })
      ).rejects.toThrow(`Refusing to replace non-socket path: ${socketPath}`);
    } finally {
      await backend.dispose();
      await rm(socketPath, { force: true });
    }
  });
});
