import { fileURLToPath } from "node:url";
import type { CodexBackendOptions } from "@codapter/backend-codex";
import type { PiBackendOptions } from "@codapter/backend-pi";
import { ADAPTER_VERSION } from "@codapter/core";

const ANALYTICS_FLAG = "--analytics-default-enabled";

export function envFlagEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseCodexTransport(value: string | undefined): "stdio" | "websocket" | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "stdio") {
    return "stdio";
  }
  if (normalized === "websocket") {
    return "websocket";
  }
  throw new Error(`Invalid CODAPTER_CODEX_TRANSPORT: ${value}`);
}

export interface AppServerArgs {
  readonly listenTargets: readonly string[];
  readonly collabEnabled: boolean;
  readonly analyticsDefaultEnabledSeen: boolean;
}

export function parseListenTargets(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): AppServerArgs {
  const listenTargets: string[] = [];
  let collabEnabled = envFlagEnabled(env.CODAPTER_COLLAB);
  let analyticsDefaultEnabledSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === ANALYTICS_FLAG) {
      analyticsDefaultEnabledSeen = true;
      continue;
    }

    if (arg === "--collab") {
      collabEnabled = true;
      continue;
    }

    if (arg.startsWith("--listen=")) {
      const value = arg.slice("--listen=".length).trim();
      if (!value) {
        throw new Error("Missing value for --listen");
      }
      listenTargets.push(value);
      continue;
    }

    if (arg === "--listen") {
      const value = args[index + 1];
      if (!value?.trim() || value.startsWith("--")) {
        throw new Error("Missing value for --listen");
      }
      listenTargets.push(value.trim());
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (listenTargets.length === 0) {
    const fallback = env.CODAPTER_LISTEN ?? "";
    for (const entry of fallback.split(",")) {
      const value = entry.trim();
      if (value) {
        listenTargets.push(value);
      }
    }
  }

  return {
    listenTargets,
    collabEnabled,
    analyticsDefaultEnabledSeen,
  };
}

export function writeHelp(stdout: NodeJS.WritableStream): void {
  stdout.write(`codapter ${ADAPTER_VERSION}\n`);
  stdout.write("Usage: codapter [--version|--help] | codapter app-server [--listen <url>]...\n");
  stdout.write("Options:\n");
  stdout.write("  --listen <url>                 Add a stdio, TCP WebSocket, or UDS listener\n");
  stdout.write("  --collab                       Enable collab sub-agent support\n");
  stdout.write("  --analytics-default-enabled    Accepted and ignored\n");
  stdout.write("  -c, --config <key=value>        Forward native config to Codex, not Pi\n");
}

export function resolveCollabExtensionPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODAPTER_COLLAB_EXTENSION_PATH?.trim();
  if (override) {
    return override;
  }
  const relativePath = import.meta.url.endsWith("/codapter.mjs")
    ? "./collab-extension.mjs"
    : "../../collab-extension/dist/index.js";
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function parseStringArray(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function parseIdleTimeout(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timeout = Number(value);
  // Node timers overflow above this bound and silently become 1 ms timers.
  if (!value.trim() || !Number.isInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new Error("CODAPTER_PI_IDLE_TIMEOUT_MS must be an integer from 0 to 2147483647");
  }
  return timeout;
}

interface CodexConfigOverride {
  readonly key: string;
  readonly argument: string;
}

export function extractCodexConfig(args: readonly string[]): {
  args: string[];
  overrides: CodexConfigOverride[];
} {
  const remaining: string[] = [];
  const overrides: CodexConfigOverride[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    let argument: string | undefined;
    if (flag === "-c" || flag === "--config") {
      argument = args[index + 1];
      index += 1;
    } else if (flag.startsWith("--config=")) {
      argument = flag.slice("--config=".length);
    } else {
      remaining.push(flag);
      continue;
    }
    if (!argument || argument.startsWith("--")) {
      throw new Error(`Missing value for ${flag === "-c" ? "-c" : "--config"}`);
    }
    const separator = argument.indexOf("=");
    const key = separator < 0 ? "" : argument.slice(0, separator).trim();
    const value = argument.slice(separator + 1);
    // Native plugin ids include '@'. Values are opaque native TOML/string syntax,
    // including arrays, inline tables, auth headers and URLs containing '='.
    if (
      !/^[A-Za-z0-9_@-]+(?:\.[A-Za-z0-9_@-]+)*$/.test(key) ||
      !value.trim() ||
      argument.includes("\0")
    ) {
      // Never echo the input: an invalid override may contain credentials.
      throw new Error(
        "Invalid Codex config override. Expected <key>=<value> with a dotted key path."
      );
    }
    overrides.push({ key, argument });
  }
  return { args: remaining, overrides };
}

export function parseBackendOptions(
  env: NodeJS.ProcessEnv,
  collabEnabled: boolean,
  stderr: NodeJS.WritableStream,
  codexOverrides: readonly CodexConfigOverride[] = []
): { pi: PiBackendOptions | null; codex: CodexBackendOptions | null } {
  let pi: PiBackendOptions | null = null;
  let codex: CodexBackendOptions | null = null;
  if (!envFlagEnabled(env.CODAPTER_PI_DISABLE)) {
    const args = parseStringArray(env, "CODAPTER_PI_ARGS");
    const idleTimeoutMs = parseIdleTimeout(env.CODAPTER_PI_IDLE_TIMEOUT_MS);
    const staticAvailableModelsPath = env.CODAPTER_PI_STATIC_MODELS_FILE?.trim();
    pi = {
      ...(env.CODAPTER_PI_COMMAND ? { command: env.CODAPTER_PI_COMMAND } : {}),
      ...(args ? { args } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(collabEnabled ? { collabExtensionPath: resolveCollabExtensionPath(env) } : {}),
      ...(staticAvailableModelsPath ? { staticAvailableModelsPath } : {}),
    };
  }
  if (!envFlagEnabled(env.CODAPTER_CODEX_DISABLE)) {
    const configuredArgs = parseStringArray(env, "CODAPTER_CODEX_ARGS");
    const args =
      codexOverrides.length > 0
        ? [
            ...codexOverrides.flatMap(({ argument }) => ["-c", argument]),
            ...(configuredArgs ?? ["app-server"]),
          ]
        : configuredArgs;
    const transport = parseCodexTransport(env.CODAPTER_CODEX_TRANSPORT);
    codex = {
      ...(env.CODAPTER_CODEX_COMMAND ? { command: env.CODAPTER_CODEX_COMMAND } : {}),
      ...(args ? { args } : {}),
      ...(transport ? { transport } : {}),
      ...(env.CODAPTER_CODEX_WS_URL ? { websocketUrl: env.CODAPTER_CODEX_WS_URL } : {}),
      stderr,
    };
  }
  return { pi, codex };
}
