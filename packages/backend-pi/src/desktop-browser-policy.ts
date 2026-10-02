import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import type { DesktopSessionCapabilities, JsonValue } from "@codapter/core";
import type { DesktopAuthStatus } from "./desktop-auth.js";

export const BROWSER_POLICY_UNAVAILABLE =
  "Desktop Browser policy cannot be verified. Managed policy sources or unknown account plans are unsupported.";

export interface DesktopBrowserPolicyOptions {
  readonly platform?: NodeJS.Platform;
  readonly programData?: string;
  readonly inspectPath?: (path: string) => Promise<unknown>;
}

export interface DesktopBrowserPolicyReadResponse {
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly requirements: null;
}

const PERSONAL_PLANS = new Set(["free", "go", "plus", "pro", "prolite", "promax", "team"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return record(value) && Object.values(value).every(json);
}

function managedPaths(options: DesktopBrowserPolicyOptions): string[] {
  switch (options.platform ?? process.platform) {
    case "linux":
      return ["/etc/codex/requirements.toml", "/etc/codex/managed_config.toml"];
    case "win32": {
      const root = options.programData ?? process.env.ProgramData;
      if (!root || !win32.isAbsolute(root)) throw new Error(BROWSER_POLICY_UNAVAILABLE);
      return [
        win32.join(root, "OpenAI", "Codex", "requirements.toml"),
        win32.join(root, "OpenAI", "Codex", "managed_config.toml"),
      ];
    }
    default:
      // macOS forced MDM preferences cannot be proven absent by filesystem checks.
      throw new Error(BROWSER_POLICY_UNAVAILABLE);
  }
}

/** Null requirements is a verified result, never a substitute for unsupported policy sources. */
export async function readDesktopBrowserPolicy(
  capabilities: Pick<DesktopSessionCapabilities, "browserConfig">,
  readAuth: () => Promise<DesktopAuthStatus>,
  options: DesktopBrowserPolicyOptions = {}
): Promise<DesktopBrowserPolicyReadResponse> {
  const snapshot = capabilities.browserConfig;
  if (
    !snapshot ||
    "error" in snapshot ||
    !record(snapshot.config) ||
    Object.keys(snapshot.config).some((key) => key !== "browser_use" && key !== "application") ||
    !Object.values(snapshot.config).every(json)
  )
    throw new Error(BROWSER_POLICY_UNAVAILABLE);
  let auth: DesktopAuthStatus;
  try {
    auth = await readAuth();
  } catch {
    throw new Error(BROWSER_POLICY_UNAVAILABLE);
  }
  if (auth.authMethod !== "chatgpt" || !PERSONAL_PLANS.has(auth.planType))
    throw new Error(BROWSER_POLICY_UNAVAILABLE);
  const inspect = options.inspectPath ?? lstat;
  for (const path of managedPaths(options)) {
    try {
      // lstat treats even dangling symlinks as present. Do not parse or ignore managed policy.
      await inspect(path);
    } catch (error) {
      if (record(error) && error.code === "ENOENT") continue;
      throw new Error(BROWSER_POLICY_UNAVAILABLE);
    }
    throw new Error(BROWSER_POLICY_UNAVAILABLE);
  }
  return { config: structuredClone(snapshot.config), requirements: null };
}
