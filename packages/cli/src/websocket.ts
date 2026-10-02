import { once } from "node:events";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { AppServerConnection, failure } from "@codapter/core";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { ListenerHandle, ListenerOptions } from "./listeners.js";

export async function startTcpListener(
  host: string,
  port: number,
  options: ListenerOptions
): Promise<ListenerHandle> {
  const rpc = createRpcServer(options);
  try {
    rpc.server.listen(port, host);
    await once(rpc.server, "listening");
    const address = rpc.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener address");
    }
    return { address: `ws://${host}:${address.port}`, close: rpc.close };
  } catch (error) {
    await rpc.close();
    throw error;
  }
}

export async function startUnixListener(
  socketPath: string,
  options: ListenerOptions
): Promise<ListenerHandle> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeExistingSocket(socketPath);

  const rpc = createRpcServer(options);
  let bound = false;
  const close = async () => {
    try {
      await rpc.close();
    } finally {
      if (bound) {
        await rm(socketPath, { force: true });
      }
    }
  };
  try {
    rpc.server.listen(socketPath);
    await once(rpc.server, "listening");
    bound = true;
    await chmod(socketPath, 0o600);
    return { address: `unix://${socketPath}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function createRpcServer(options: ListenerOptions): {
  server: ReturnType<typeof createServer>;
  close(): Promise<void>;
} {
  const websocketServer = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, () => Promise<void>>();
  const disposals = new Set<Promise<void>>();
  const disposalErrors: unknown[] = [];
  let closing: Promise<void> | undefined;

  websocketServer.on("connection", (socket: WebSocket) => {
    let disposed = false;
    const send = (message: unknown) => {
      if (!disposed && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };
    const connection = new AppServerConnection({
      backendRouter: options.backendRouter,
      configStore: options.configStore,
      desktopPlugins: options.desktopPlugins,
      collabEnabled: options.collabEnabled,
      initialAuthState: options.initialAuthState ?? null,
      onMessage: send,
    });
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      if (!disposal) {
        disposed = true;
        const work = connection.dispose();
        disposal = work;
        disposals.add(work);
        void work.then(
          () => {
            clients.delete(socket);
            disposals.delete(work);
          },
          (error: unknown) => {
            disposalErrors.push(error);
            clients.delete(socket);
            disposals.delete(work);
          }
        );
      }
      return disposal;
    };
    clients.set(socket, dispose);

    socket.on("message", (payload: RawData) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");

      // Requests can await responses or control requests from this same peer.
      // Dispatch each envelope independently, as the stdio transport does.
      void (async () => {
        if (disposed) {
          return;
        }
        try {
          const response = await connection.handleMessage(JSON.parse(text) as unknown);
          if (response) {
            send(response);
          }
        } catch {
          send(failure(null, -32700, "Parse error"));
        }
      })();
    });

    socket.on("close", () => {
      void dispose();
    });
    socket.on("error", () => socket.terminate());
  });

  const server = createServer((request, response) => {
    handleHttpRequest(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    if (closing) {
      socket.destroy();
      return;
    }
    if (request.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (request.url !== "/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  return {
    server,
    close() {
      closing ??= (async () => {
        const websocketClosed = new Promise<void>((resolve, reject) => {
          websocketServer.close((error?: Error) => (error ? reject(error) : resolve()));
        });
        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error?: NodeJS.ErrnoException) => {
            if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
              reject(error);
            } else {
              resolve();
            }
          });
        });
        // close() alone waits forever for peers that never close their sockets.
        for (const [socket, dispose] of clients) {
          void dispose();
          socket.terminate();
        }
        server.closeAllConnections();
        const results = await Promise.allSettled([websocketClosed, serverClosed, ...disposals]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          throw failed.reason;
        }
        if (disposalErrors.length > 0) {
          throw disposalErrors[0];
        }
      })();
      return closing;
    },
  };
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === "/healthz" || request.url === "/readyz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

async function removeExistingSocket(socketPath: string): Promise<void> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    }
    await rm(socketPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}
