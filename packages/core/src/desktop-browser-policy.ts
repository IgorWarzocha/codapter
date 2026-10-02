import { dirname, join, resolve } from "node:path";
import {
  type ConfigObject,
  configObject,
  configOverridesForRoots,
  mergeConfigObjects,
  parseConfigToml,
} from "./config-toml.js";
import type { DesktopBrowserConfig } from "./desktop-capabilities.js";
import { optionalText } from "./desktop-plugin-files.js";
import type { JsonValue } from "./protocol.js";

export interface BrowserPolicySources {
  readonly codexHome: string;
  readonly cwd: string;
  readonly systemConfigFile?: string;
  readonly profile: JsonValue | undefined;
  readonly profiles: ConfigObject | null;
}

const POLICY_ROOTS = ["browser_use", "application"];

function policyTable(value: JsonValue, keys: readonly string[]): ConfigObject {
  if (!configObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported thread Browser policy configuration");
  return value;
}

function permission(value: JsonValue | undefined): void {
  if (value !== undefined && value !== null && value !== "allow" && value !== "deny")
    throw new Error("Unsupported thread Browser policy permission");
}

function booleanPolicy(value: JsonValue | undefined): void {
  if (value !== undefined && value !== null && typeof value !== "boolean")
    throw new Error("Unsupported thread Browser policy flag");
}

/** Persist only understood policy fields, never arbitrary thread configuration. */
export function threadBrowserOverrides(value: unknown): ConfigObject {
  if (!configObject(value)) throw new Error("Invalid stored thread Browser overrides");
  const result = resumeBrowserConfig(value, {}) ?? {};
  if (result.browser_use !== undefined && result.browser_use !== null) {
    const browser = policyTable(result.browser_use, [
      "allow_history_access",
      "default_origin_policy",
      "origins",
    ]);
    booleanPolicy(browser.allow_history_access);
    const origin = (policy: JsonValue) => {
      const table = policyTable(policy, ["access", "downloads", "uploads", "full_cdp_access"]);
      for (const child of Object.values(table)) permission(child);
    };
    if (browser.default_origin_policy !== undefined && browser.default_origin_policy !== null)
      origin(browser.default_origin_policy);
    if (browser.origins !== undefined && browser.origins !== null) {
      if (!configObject(browser.origins)) throw new Error("Invalid thread Browser origins");
      for (const policy of Object.values(browser.origins)) {
        if (policy === undefined || policy === null)
          throw new Error("Invalid thread Browser origin policy");
        origin(policy);
      }
    }
  }
  if (result.application !== undefined && result.application !== null) {
    const application = policyTable(result.application, ["network"]);
    if (application.network !== undefined && application.network !== null) {
      const network = policyTable(application.network, ["enabled", "domains"]);
      booleanPolicy(network.enabled);
      if (network.domains !== undefined && network.domains !== null) {
        if (!configObject(network.domains))
          throw new Error("Invalid thread Browser application domains");
        for (const domain of Object.values(network.domains)) {
          if (domain !== "allow" && domain !== "deny")
            throw new Error("Invalid thread Browser application permission");
        }
      }
    }
  }
  if (
    result.profile !== undefined &&
    result.profile !== null &&
    (typeof result.profile !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.profile))
  )
    throw new Error("Invalid stored thread Browser profile selector");
  if (configObject(result.profiles)) {
    // Profiles are verified, not applied. Retain existence and policy presence
    // only; even an unsupported profile policy cannot smuggle credentials in.
    result.profiles = Object.fromEntries(
      Object.entries(result.profiles).map(([name, definition]) => [
        name,
        configObject(definition)
          ? Object.fromEntries(
              POLICY_ROOTS.flatMap((root) => (definition[root] === undefined ? [] : [[root, {}]]))
            )
          : null,
      ])
    );
  }
  return result;
}

/** Explicit complete resupply can recover a legacy thread without stored policy. */
export function hasCompleteBrowserOverrides(value: ConfigObject | null | undefined): boolean {
  const selected = configOverridesForRoots(value ?? {}, [...POLICY_ROOTS, "profile"]);
  return [...POLICY_ROOTS, "profile"].every((key) => selected[key] !== undefined);
}

// GUI resume sends a partial feature map. Retain only Browser policy from the
// running thread and profile metadata needed to verify it, not unrelated MCP
// environment/credentials. The registry saves its sanitized Browser subset;
// base native/CLI/adapter layers are always evaluated afresh.
export function resumeBrowserConfig(
  previous: ConfigObject | null | undefined,
  requested: ConfigObject | null | undefined
): ConfigObject | null {
  if (requested == null) return previous && Object.keys(previous).length ? previous : null;
  const metadata = configOverridesForRoots(previous ?? {}, ["profile", "profiles"]);
  if (metadata.profiles !== undefined) {
    metadata.profiles = configObject(metadata.profiles)
      ? Object.fromEntries(
          Object.entries(metadata.profiles).map(([name, value]) => [
            name,
            configObject(value) ? configOverridesForRoots(value, POLICY_ROOTS) : null,
          ])
        )
      : null;
  }
  const other = Object.fromEntries(
    Object.entries(requested).filter(
      ([key]) => !POLICY_ROOTS.some((root) => key === root || key.startsWith(`${root}.`))
    )
  );
  return mergeConfigObjects(
    mergeConfigObjects(metadata, other),
    mergeConfigObjects(
      configOverridesForRoots(previous ?? {}, POLICY_ROOTS),
      configOverridesForRoots(requested, POLICY_ROOTS)
    )
  );
}

function policyPresent(config: ConfigObject): boolean {
  return config.browser_use !== undefined || config.application !== undefined;
}

function systemConfigFile(): string {
  if (process.platform !== "win32") return "/etc/codex/config.toml";
  if (!process.env.ProgramData) throw new Error("Native system Browser policy path is unavailable");
  return resolve(process.env.ProgramData, "OpenAI", "Codex", "config.toml");
}

async function nativeLayer(file: string, label: string): Promise<ConfigObject | null> {
  try {
    const text = await optionalText(file);
    return text === null ? null : parseConfigToml(text);
  } catch {
    throw new Error(`${label} configuration could not be verified for Browser policy`);
  }
}

// This is a verifier for policy layers that the catalogue does not implement,
// not a second Codex config manager. Never omit a possible policy and allow.
export async function browserConfigSnapshot(
  effective: ConfigObject,
  sources: BrowserPolicySources
): Promise<DesktopBrowserConfig> {
  try {
    const system = await nativeLayer(
      sources.systemConfigFile ?? systemConfigFile(),
      "Native system"
    );
    if (system && policyPresent(system))
      throw new Error("Browser policy in native system configuration is unsupported");
    const profile = sources.profile ?? system?.profile;
    if (profile !== undefined && profile !== null) {
      if (typeof profile !== "string" || !/^[A-Za-z0-9_-]+$/.test(profile))
        throw new Error("Selected native profile could not be verified for Browser policy");
      let found = false;
      if (
        sources.profiles === null ||
        (system?.profiles !== undefined && !configObject(system.profiles))
      )
        throw new Error("Selected native profile could not be verified for Browser policy");
      for (const definitions of [
        sources.profiles,
        configObject(system?.profiles) ? system.profiles : {},
      ]) {
        const selected = definitions[profile];
        if (selected !== undefined) found = true;
        if (selected !== undefined && !configObject(selected))
          throw new Error("Selected native profile could not be verified for Browser policy");
        if (configObject(selected) && policyPresent(selected))
          throw new Error("Browser policy in a selected native profile is unsupported");
      }
      const layer = await nativeLayer(
        join(sources.codexHome, `${profile}.config.toml`),
        "Selected native profile"
      );
      if (layer) found = true;
      if (layer && policyPresent(layer))
        throw new Error("Browser policy in a selected native profile is unsupported");
      if (!found) throw new Error("Selected native profile is unavailable for Browser policy");
    }
    // Native project discovery excludes CODEX_HOME and can include ancestor
    // .codex layers. Without its trust/root evaluator, any relevant candidate
    // is unsupported, even if native trust might disable it.
    for (let cwd = resolve(sources.cwd); ; cwd = dirname(cwd)) {
      const folder = join(cwd, ".codex");
      if (folder !== resolve(sources.codexHome)) {
        const project = await nativeLayer(join(folder, "config.toml"), "Native project");
        if (project && policyPresent(project))
          throw new Error("Browser policy in native project configuration is unsupported");
      }
      if (dirname(cwd) === cwd) break;
    }
    const config: Record<string, JsonValue> = {};
    for (const key of ["browser_use", "application"]) {
      const value = effective[key];
      if (value !== undefined) config[key] = structuredClone(value);
    }
    return { config };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Browser policy configuration is unavailable",
    };
  }
}
