import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { attachJsonlLineReader, serializeJsonLine } from "../jsonl.js";

/** No deadline: GUI calls may wait for human interaction. Abort closes the route. */
export function desktopRequest(
  path: string,
  method: string,
  params?: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(path);
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      stop();
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const abort = () => finish(signal?.reason ?? new Error("Desktop call aborted"));
    const stop = attachJsonlLineReader(socket, (line) => {
      try {
        const reply: unknown = JSON.parse(line);
        if (
          typeof reply !== "object" ||
          reply === null ||
          !("jsonrpc" in reply) ||
          reply.jsonrpc !== "2.0" ||
          !("id" in reply) ||
          reply.id !== id ||
          "result" in reply === "error" in reply
        )
          throw new Error("Invalid Desktop JSON-RPC response");
        if ("error" in reply) {
          const rpcError = reply.error;
          const error = new Error(
            typeof rpcError === "object" &&
              rpcError !== null &&
              "message" in rpcError &&
              typeof rpcError.message === "string"
              ? rpcError.message
              : "Desktop call failed"
          );
          // Keep the original JSON-RPC code/data available to extension callers.
          finish(Object.assign(error, { rpcError }));
        } else if ("result" in reply) finish(undefined, reply.result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("connect", () =>
      socket.write(serializeJsonLine({ jsonrpc: "2.0", id, method, params }))
    );
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("Desktop bridge disconnected")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
