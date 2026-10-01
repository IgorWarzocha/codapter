import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { AppServerConnection, BackendRouter } from "@codapter/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createUnixSocketPath, startAppServerListeners } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

async function connect(address: string): Promise<WebSocket> {
  const socket = new WebSocket(address);
  await once(socket, "open");
  return socket;
}

async function request(socket: WebSocket, method: string, params: unknown = {}): Promise<unknown> {
  const received = once(socket, "message");
  socket.send(JSON.stringify({ id: 1, method, params }));
  const [payload] = await received;
  return JSON.parse(payload.toString());
}

describe("WebSocket connection lifecycle", () => {
  it.each(["connected", "disconnected"])(
    "awaits %s client disposal and allows repeated close",
    async (state) => {
      let enterDisposal: () => void = () => {};
      let releaseDisposal: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enterDisposal = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseDisposal = resolve;
      });
      const originalDispose = AppServerConnection.prototype.dispose;
      const dispose = vi
        .spyOn(AppServerConnection.prototype, "dispose")
        .mockImplementation(async function () {
          enterDisposal();
          await released;
          await originalDispose.call(this);
        });
      const listeners = await startAppServerListeners(["ws://127.0.0.1:0"], {
        backendRouter: new BackendRouter(),
      });
      const socket = await connect(listeners.addresses[0]);
      let closed = false;
      let closing: Promise<void> | undefined;
      try {
        if (state === "disconnected") {
          socket.close();
          await entered;
        }
        closing = listeners.close().then(() => {
          closed = true;
        });
        await entered;
        expect(closed).toBe(false);
        expect(dispose).toHaveBeenCalledOnce();
        const closedAgain = listeners.close();
        releaseDisposal();
        await Promise.all([closing, closedAgain]);
        expect(closed).toBe(true);
        expect(dispose).toHaveBeenCalledOnce();
        await listeners.close();
        await expect(connect(listeners.addresses[0])).rejects.toMatchObject({
          code: "ECONNREFUSED",
        });
      } finally {
        releaseDisposal();
        socket.terminate();
        await closing;
        await listeners.close();
      }
    }
  );

  it("preserves initial authentication on every WebSocket connection", async () => {
    const listeners = await startAppServerListeners(["ws://127.0.0.1:0"], {
      backendRouter: new BackendRouter(),
      initialAuthState: { mode: "apikey", apiKey: "test-key" },
    });
    try {
      for (let index = 0; index < 2; index += 1) {
        const socket = await connect(listeners.addresses[0]);
        expect(
          await request(socket, "initialize", {
            clientInfo: { name: "auth-lifecycle", version: "0.0.4" },
          })
        ).toMatchObject({ result: { userAgent: expect.any(String) } });
        expect(await request(socket, "getAuthStatus", { includeToken: true })).toMatchObject({
          result: { authMethod: "apikey", authToken: "test-key", requiresOpenaiAuth: true },
        });
        socket.close();
      }
    } finally {
      await listeners.close();
    }
  });

  it("closes all clients and reports connection disposal failures", async () => {
    vi.spyOn(AppServerConnection.prototype, "dispose").mockRejectedValueOnce(
      new Error("disposal failed")
    );
    const listeners = await startAppServerListeners(["ws://127.0.0.1:0"], {
      backendRouter: new BackendRouter(),
    });
    const socket = await connect(listeners.addresses[0]);
    try {
      await expect(listeners.close()).rejects.toThrow("disposal failed");
      await expect(connect(listeners.addresses[0])).rejects.toMatchObject({ code: "ECONNREFUSED" });
    } finally {
      socket.terminate();
    }
  });
});

describe("listener startup rollback", () => {
  it("closes an earlier stdio connection and unlinks UDS if a later target is invalid", async () => {
    const socketPath = await createUnixSocketPath();
    const dispose = vi.spyOn(AppServerConnection.prototype, "dispose");
    await expect(
      startAppServerListeners(["stdio", `unix://${socketPath}`, "ws://127.0.0.1:0/rpc"], {
        backendRouter: new BackendRouter(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      })
    ).rejects.toThrow("Unsupported WebSocket path");
    expect(dispose).toHaveBeenCalledOnce();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back earlier listeners when binding a later TCP port fails", async () => {
    const occupied = createServer();
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address");
    }
    const socketPath = await createUnixSocketPath();
    try {
      await expect(
        startAppServerListeners([`unix://${socketPath}`, `ws://127.0.0.1:${address.port}`], {
          backendRouter: new BackendRouter(),
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
