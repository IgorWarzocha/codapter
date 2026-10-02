import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppServerConnectionOptions,
  BackendRouter,
  InMemoryConfigStore,
  StoredAuthState,
} from "@codapter/core";
import { startStdioListener } from "./stdio.js";
import { startTcpListener, startUnixListener } from "./websocket.js";

export interface ListenerHandle {
  readonly address: string;
  close(): Promise<void>;
}

export interface ListenerSet {
  readonly listeners: readonly ListenerHandle[];
  readonly addresses: readonly string[];
  close(): Promise<void>;
}

export interface ListenerOptions {
  readonly backendRouter: BackendRouter;
  readonly configStore?: InMemoryConfigStore;
  readonly desktopPlugins?: AppServerConnectionOptions["desktopPlugins"];
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly collabEnabled?: boolean;
  readonly initialAuthState?: StoredAuthState | null;
}

type ParsedListenTarget =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "unix"; socketPath: string }
  | { kind: "stdio" };

export async function startAppServerListeners(
  listenTargets: readonly string[],
  options: ListenerOptions
): Promise<ListenerSet> {
  const stdioCount = listenTargets.filter((target) => target === "stdio").length;
  if (stdioCount > 1) {
    throw new Error("Only one stdio listener is allowed");
  }

  const listeners: ListenerHandle[] = [];

  try {
    for (const target of listenTargets) {
      listeners.push(await startAppServerListener(target, options));
    }
  } catch (error) {
    await Promise.allSettled(listeners.map(async (listener) => listener.close()));
    throw error;
  }

  return {
    listeners,
    addresses: listeners.map((listener) => listener.address),
    async close() {
      const results = await Promise.allSettled(listeners.map((listener) => listener.close()));
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    },
  };
}

async function startAppServerListener(
  rawTarget: string,
  options: ListenerOptions
): Promise<ListenerHandle> {
  const target = parseListenTarget(rawTarget);

  if (target.kind === "stdio") {
    if (!options.stdin || !options.stdout) {
      throw new Error("stdio listener requires stdin and stdout streams");
    }
    return startStdioListener(options.stdin, options.stdout, options);
  }

  if (target.kind === "unix") {
    return startUnixListener(target.socketPath, options);
  }

  return startTcpListener(target.host, target.port, options);
}

function parseListenTarget(rawTarget: string): ParsedListenTarget {
  if (rawTarget === "stdio") {
    return { kind: "stdio" };
  }

  if (rawTarget.startsWith("unix://")) {
    const socketPath = rawTarget.slice("unix://".length);
    if (!socketPath.startsWith("/")) {
      throw new Error(`Invalid unix listen target: ${rawTarget}`);
    }
    return { kind: "unix", socketPath };
  }

  const url = new URL(rawTarget);
  if (url.protocol !== "ws:") {
    throw new Error(`Unsupported listen target: ${rawTarget}`);
  }

  if (url.pathname !== "/") {
    throw new Error(`Unsupported WebSocket path in listen target: ${rawTarget}`);
  }

  if (url.port.length === 0) {
    throw new Error(`Missing WebSocket port in listen target: ${rawTarget}`);
  }

  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid WebSocket port in listen target: ${rawTarget}`);
  }

  return { kind: "tcp", host, port };
}

export async function createUnixSocketPath(prefix = "codapter"): Promise<string> {
  const socketName = `${prefix}-${randomUUID().slice(0, 8)}.sock`;
  return join(tmpdir(), socketName);
}

export function getTcpListenerPort(address: string): number {
  const parsed = new URL(address);
  return Number(parsed.port);
}

export function getSocketMode(mode: number): number {
  return mode & 0o777;
}
