import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ADAPTER_VERSION } from "@codapter/core";
import { parseDesktopAuthStatus } from "./desktop-auth.js";
import { BROWSER_POLICY_UNAVAILABLE } from "./desktop-browser-policy.js";
import { desktopRequest } from "./desktop-extension/client.js";
import { serializeJsonLine } from "./jsonl.js";

export interface DesktopHostServicesOptions {
  readonly path: string;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow NodeRepl host auth and policy protocol. No inference, login, or command execution. */
export async function runDesktopHostServices(options: DesktopHostServicesOptions): Promise<void> {
  if (!options.path) throw new Error("Desktop host services require a private bridge endpoint");
  const timeout = options.requestTimeoutMs ?? 60_000;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    throw new Error("Invalid Desktop host authentication timeout");
  const stdout = options.stdout ?? process.stdout;
  const input = createInterface({ input: options.stdin ?? process.stdin, crlfDelay: Infinity });
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
    input.close();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  let initialized = false;
  const pending = new Set<Promise<void>>();

  const handle = async (line: string): Promise<void> => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      stdout.write(
        serializeJsonLine({ id: null, error: { code: -32700, message: "Parse error" } })
      );
      return;
    }
    const id =
      record(request) &&
      (typeof request.id === "string" ||
        (typeof request.id === "number" && Number.isSafeInteger(request.id)))
        ? request.id
        : null;
    const version = record(request) && request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {};
    const reply = (result: unknown) => stdout.write(serializeJsonLine({ ...version, id, result }));
    const fail = (code: number, message: string) =>
      stdout.write(
        serializeJsonLine({
          ...version,
          id,
          error: { code, message },
        })
      );
    if (
      !record(request) ||
      typeof request.method !== "string" ||
      (request.jsonrpc !== undefined && request.jsonrpc !== "2.0")
    ) {
      fail(-32600, "Invalid request");
      return;
    }
    if (request.method === "initialized" && request.id === undefined) return;
    if (id === null) {
      fail(-32600, "Invalid request id");
      return;
    }
    if (request.method === "initialize") {
      if (initialized) fail(-32600, "Already initialized");
      else {
        initialized = true;
        reply({
          userAgent: `codapter/${ADAPTER_VERSION}`,
          platformFamily: process.platform === "win32" ? "windows" : "unix",
          platformOs: process.platform === "darwin" ? "macos" : process.platform,
        });
      }
      return;
    }
    if (
      !["getAuthStatus", "account/read", "config/read", "configRequirements/read"].includes(
        request.method
      )
    ) {
      fail(-32601, "Unsupported Desktop host service method");
      return;
    }
    if (!initialized) {
      fail(-32600, "Not initialized");
      return;
    }
    const params = request.params ?? {};
    if (request.method === "config/read" || request.method === "configRequirements/read") {
      const configRead = request.method === "config/read";
      if (
        !record(params) ||
        Object.keys(params).some(
          (key) => !configRead || (key !== "cwd" && key !== "includeLayers")
        ) ||
        (params.cwd !== undefined && params.cwd !== null && typeof params.cwd !== "string") ||
        (params.includeLayers !== undefined && typeof params.includeLayers !== "boolean")
      ) {
        fail(-32602, "Invalid Browser policy parameters");
        return;
      }
      try {
        // The private route is bound to the associated thread snapshot. Never forward caller cwd.
        const value = await desktopRequest(
          options.path,
          "desktop/browser-policy/read",
          {},
          AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)])
        );
        abort.signal.throwIfAborted();
        if (!record(value) || !record(value.config) || value.requirements !== null)
          throw new Error(BROWSER_POLICY_UNAVAILABLE);
        if (configRead) reply({ config: value.config, origins: {}, layers: null });
        else reply({ requirements: value.requirements });
      } catch {
        if (!abort.signal.aborted) fail(-32000, BROWSER_POLICY_UNAVAILABLE);
      }
      return;
    }
    if (
      !record(params) ||
      (params.refreshToken !== undefined &&
        params.refreshToken !== null &&
        typeof params.refreshToken !== "boolean") ||
      (request.method === "getAuthStatus" &&
        params.includeToken !== undefined &&
        params.includeToken !== null &&
        typeof params.includeToken !== "boolean")
    ) {
      fail(-32602, "Invalid authentication parameters");
      return;
    }
    try {
      // Pi resolves current credentials for every call. refreshToken never triggers a second login.
      const includeToken = request.method === "getAuthStatus" && params.includeToken === true;
      const value = await desktopRequest(
        options.path,
        "desktop/auth/read",
        { includeToken },
        AbortSignal.any([abort.signal, AbortSignal.timeout(timeout)])
      );
      abort.signal.throwIfAborted();
      const auth = parseDesktopAuthStatus(value, includeToken);
      if (request.method === "getAuthStatus")
        reply({
          authMethod: auth.authMethod,
          authToken: auth.authToken,
          requiresOpenaiAuth: true,
        });
      else reply({ account: auth.account, requiresOpenaiAuth: true });
    } catch {
      // Underlying auth errors can contain credentials. This stream is the only token delivery route.
      if (!abort.signal.aborted) fail(-32000, "Native Pi authentication is unavailable");
    }
  };

  try {
    for await (const line of input) {
      if (abort.signal.aborted) break;
      if (!line.trim()) continue;
      const work = handle(line);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work)
      );
    }
    await Promise.all(pending);
  } finally {
    abort.abort();
    input.close();
    options.signal?.removeEventListener("abort", stop);
  }
}
