import { randomUUID } from "node:crypto";
import net from "node:net";

export const FAST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createCollabError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class CollabClient {
  constructor(private readonly socketPath: string) {}

  async call<T>(
    method: string,
    params: unknown,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    if (options.signal?.aborted) {
      throw createCollabError("aborted", "Collab request was aborted");
    }
    const timeoutMs = options.timeoutMs ?? FAST_TIMEOUT_MS;
    const requestId = randomUUID();
    const request = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`;

    return await new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      let buffer = "";

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", handleAbort);
        // Destroy even on protocol failure. Keep the error handler attached until
        // the socket closes so a late connect failure cannot become unhandled.
        socket.destroy();
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        cleanup();
        reject(error);
      };

      const finish = (value: T) => {
        if (settled) {
          return;
        }
        cleanup();
        resolve(value);
      };

      const handleAbort = () => {
        fail(createCollabError("aborted", "Collab request was aborted"));
      };

      const timeout = setTimeout(() => {
        fail(createCollabError("timeout", `Collab request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      options.signal?.addEventListener("abort", handleAbort, { once: true });

      socket.setEncoding("utf8");
      socket.on("error", (error) => {
        fail(createCollabError("collab_unavailable", error.message));
      });
      socket.on("close", () => {
        if (!settled) {
          fail(createCollabError("collab_unavailable", "Collab socket closed before a response"));
        }
      });
      socket.on("connect", () => {
        socket.write(request);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            fail(createCollabError("invalid_response", "Collab socket returned invalid JSON"));
            return;
          }

          if (
            !isRecord(parsed) ||
            parsed.id !== requestId ||
            "result" in parsed === "error" in parsed ||
            ("error" in parsed && !isRecord(parsed.error))
          ) {
            fail(
              createCollabError("invalid_response", "Collab socket returned an invalid response")
            );
            return;
          }

          if (isRecord(parsed.error)) {
            fail(
              createCollabError(
                typeof parsed.error.code === "string" ? parsed.error.code : "jsonrpc_error",
                typeof parsed.error.message === "string"
                  ? parsed.error.message
                  : "Collab request failed"
              )
            );
            return;
          }

          finish(parsed.result as T);
          return;
        }
      });
    });
  }
}
