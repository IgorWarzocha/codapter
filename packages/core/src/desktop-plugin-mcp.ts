import { resolve } from "node:path";
import { type ConfigObject, configObject } from "./config-toml.js";
import type { JsonValue } from "./protocol.js";

function strings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`Invalid MCP ${field}`);
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!configObject(value) || !Object.values(value).every((item) => typeof item === "string"))
    throw new Error(`Invalid MCP ${field}`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

// Native TOML/JSON environment and header values are literals. Pi also accepts
// executable !commands and $templates, so escape them at this boundary.
function literal(value: string): string {
  const escaped = value.replaceAll("$", () => "$$");
  return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
}

function envName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error("Invalid MCP environment variable name");
  return value;
}

function duration(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(`Invalid MCP ${field}`);
  return value;
}

function approval(value: unknown): void {
  if (value !== undefined && value !== "approve") {
    throw new Error(
      "MCP approval policy requires a native approval gate unavailable in Pi registration"
    );
  }
}

export function translateDesktopMcpServer(name: string, raw: unknown, cwd: string): ConfigObject {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || !configObject(raw))
    throw new Error("Invalid MCP server definition");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new Error("Invalid MCP enabled flag");
  if (raw.enabled === false) return { enabled: false };
  approval(raw.default_tools_approval_mode);
  if (
    raw.ema_auth !== undefined ||
    raw.http_headers_helper !== undefined ||
    (raw.environment_id && raw.environment_id !== "local")
  ) {
    throw new Error("MCP remote environment or delegated authentication is unsupported");
  }
  const omitted = strings(raw.omit_tools_from, "omit_tools_from") ?? [];
  if (omitted.some((surface) => !["code_mode", "deferred", "direct"].includes(surface)))
    throw new Error("Invalid MCP omission surface");
  const exposure = ["code_mode", "deferred", "direct"].find(
    (surface) => !omitted.includes(surface)
  );
  const result: ConfigObject = {
    exposure: exposure === "code_mode" ? "codemode" : (exposure ?? "hidden"),
  };
  const enabled = strings(raw.enabled_tools, "enabled_tools");
  const disabled = strings(raw.disabled_tools, "disabled_tools") ?? [];
  if ([...(enabled ?? []), ...disabled].some((tool) => tool.includes("*")))
    throw new Error(
      "Exact MCP tool filters containing wildcards cannot be represented in Pi exposure rules"
    );
  const toolExposure: ConfigObject = {};
  if (enabled) {
    result.exposure = "hidden";
    for (const tool of enabled)
      toolExposure[tool] = exposure === "code_mode" ? "codemode" : (exposure ?? "hidden");
  }
  for (const tool of disabled) toolExposure[tool] = "hidden";
  if (raw.tools !== undefined) {
    if (!configObject(raw.tools)) throw new Error("Invalid MCP tools policy");
    for (const [tool, policy] of Object.entries(raw.tools)) {
      if (!configObject(policy)) throw new Error("Invalid MCP tool policy");
      approval(policy.approval_mode);
      if (policy.output_token_limit !== undefined)
        throw new Error("MCP per-tool output budget is unsupported");
      if (policy.enabled === false) toolExposure[tool] = "hidden";
      else if (policy.enabled !== undefined && policy.enabled !== true)
        throw new Error("Invalid MCP tool enabled flag");
    }
  }
  if (Object.keys(toolExposure).length) result.toolExposure = toolExposure;
  const startup =
    duration(raw.startup_timeout_sec, "startup_timeout_sec") ??
    (duration(raw.startup_timeout_ms, "startup_timeout_ms") ?? 0) / 1000;
  const timeout = duration(raw.tool_timeout_sec, "tool_timeout_sec");
  if (startup && timeout && startup !== timeout)
    throw new Error("Pi MCP registration cannot enforce distinct startup and tool timeouts");
  if (timeout || startup) result.timeout = timeout ?? startup;

  if (typeof raw.command === "string" && raw.url === undefined) {
    if (!raw.command.trim()) throw new Error("Empty MCP command");
    result.command = raw.command.startsWith(".") ? resolve(cwd, raw.command) : raw.command;
    const args = strings(raw.args, "args");
    if (args) result.args = args;
    const env = Object.fromEntries(
      Object.entries(stringMap(raw.env, "env")).map(([key, value]) => [
        envName(key),
        literal(value),
      ])
    );
    if (raw.env_vars !== undefined) {
      if (!Array.isArray(raw.env_vars)) throw new Error("Invalid MCP env_vars allowlist");
      for (const variable of raw.env_vars) {
        const source = configObject(variable) ? variable.source : undefined;
        if (source !== undefined && source !== "local")
          throw new Error("Remote MCP environment variables are unsupported");
        envName(configObject(variable) ? variable.name : variable);
      }
      throw new Error(
        "Native MCP environment allowlist cannot be enforced by Pi server registration"
      );
    }
    result.env = env;
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") throw new Error("Invalid MCP cwd");
    result.cwd = resolve(cwd, typeof raw.cwd === "string" ? raw.cwd : ".");
    if (raw.auth !== undefined) throw new Error("Stdio MCP authentication policy is unsupported");
  } else if (typeof raw.url === "string" && raw.command === undefined) {
    const url = new URL(raw.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid MCP URL scheme");
    result.url = raw.url;
    const headers = Object.fromEntries(
      Object.entries(stringMap(raw.http_headers ?? raw.headers, "headers")).map(([key, value]) => [
        key,
        literal(value),
      ])
    );
    for (const [key, variable] of Object.entries(
      stringMap(raw.env_http_headers, "env_http_headers")
    ))
      headers[key] = `\${${envName(variable)}}`;
    if (raw.bearer_token !== undefined)
      throw new Error(
        "Literal native bearer_token is unsupported; use bearer_token_env_var or Pi provider auth"
      );
    if (raw.bearer_token_env_var !== undefined)
      headers.Authorization = `Bearer \${${envName(raw.bearer_token_env_var)}}`;
    if (Object.keys(headers).length) result.headers = headers;
    if (raw.auth !== undefined) {
      if (
        raw.bearer_token_env_var !== undefined ||
        Object.keys(headers).some((header) => header.toLowerCase() === "authorization")
      )
        throw new Error("Conflicting MCP authentication sources");
      if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Pi provider MCP authentication requires HTTPS or loopback");
      if (configObject(raw.auth) && typeof raw.auth.provider === "string") {
        result.auth = { provider: raw.auth.provider };
      } else if (raw.auth === "chatgpt") result.auth = { provider: "openai-codex" };
      else throw new Error("Native MCP authentication policy is unsupported");
    }
    if (raw.oauth !== undefined) {
      if (!configObject(raw.oauth)) throw new Error("Invalid MCP OAuth settings");
      const oauth: ConfigObject = {};
      for (const [native, pi] of [
        ["client_id", "clientId"],
        ["client_secret", "clientSecret"],
        ["client_name", "clientName"],
        ["callback_url", "callbackUrl"],
      ]) {
        if (typeof raw.oauth[native] === "string")
          oauth[pi] = native === "client_secret" ? literal(raw.oauth[native]) : raw.oauth[native];
      }
      const scopes = strings(raw.scopes, "scopes");
      if (scopes) oauth.scope = scopes.join(" ");
      result.oauth = oauth;
    } else if (raw.scopes !== undefined)
      result.oauth = { scope: strings(raw.scopes, "scopes")?.join(" ") ?? "" };
  } else throw new Error("MCP server must declare exactly one command or URL");
  return result;
}

function restrictiveAppsPolicy(value: JsonValue | undefined): boolean {
  if (!configObject(value)) return value !== undefined;
  for (const [key, policy] of Object.entries(value)) {
    if (key === "enabled" && typeof policy !== "boolean") return true;
    if (
      ["enabled", "destructive_enabled", "open_world_enabled", "default_tools_enabled"].includes(
        key
      ) &&
      policy === false
    )
      return true;
    if (["default_tools_approval_mode", "approval_mode"].includes(key) && policy !== "approve")
      return true;
    if (key === "omit_tools_from" && Array.isArray(policy) && policy.length > 0) return true;
    if (
      (key === "tools" || key === "links") &&
      configObject(policy) &&
      Object.values(policy).some(restrictiveAppsPolicy)
    )
      return true;
  }
  return false;
}

export function implicitChatGptMcp(config: ConfigObject): {
  server: ConfigObject | null;
  diagnostic: string | null;
} {
  if (!configObject(config.features) || config.features.apps !== true)
    return { server: null, diagnostic: null };
  const disabledConnectors: string[] = [];
  const disabledTools = new Map<string, Set<string>>();
  let unsupportedPolicy = false;
  if (configObject(config.apps))
    for (const [id, policy] of Object.entries(config.apps)) {
      if (id !== "_default" && configObject(policy) && policy.enabled === false) {
        if (!id.trim()) unsupportedPolicy = true;
        else disabledConnectors.push(id.trim());
        continue;
      }
      if (id === "_default" || !configObject(policy)) {
        if (restrictiveAppsPolicy(policy)) unsupportedPolicy = true;
        continue;
      }
      const { tools, ...appPolicy } = policy;
      if (restrictiveAppsPolicy(appPolicy)) unsupportedPolicy = true;
      if (tools === undefined) continue;
      if (!id.trim() || !configObject(tools)) {
        unsupportedPolicy = true;
        continue;
      }
      for (const [tool, toolPolicy] of Object.entries(tools)) {
        // Native name lookup takes precedence over title lookup. A deny-only
        // marker cannot reproduce enabled or empty overrides masking a title
        // denial, so support exact enabled:false entries only.
        if (
          !configObject(toolPolicy) ||
          toolPolicy.enabled !== false ||
          Object.keys(toolPolicy).some((key) => key !== "enabled")
        ) {
          unsupportedPolicy = true;
          continue;
        }
        const denied = disabledTools.get(id.trim()) ?? new Set<string>();
        denied.add(tool);
        disabledTools.set(id.trim(), denied);
      }
    }
  if (unsupportedPolicy) {
    return {
      server: null,
      diagnostic:
        "ChatGPT apps MCP disabled: default, per-tool, annotation, link, or approval restrictions exceed the supported connector denylist policy and exact tool denials",
    };
  }
  return {
    server: {
      url: "https://chatgpt.com/backend-api/ps/mcp",
      auth: { provider: "openai-codex" },
      headers: {
        "X-OpenAI-Product-Sku":
          typeof config.apps_mcp_product_sku === "string"
            ? literal(config.apps_mcp_product_sku)
            : "codex",
      },
      exposure: "codemode",
      _codapter: {
        disabledConnectors: [...new Set(disabledConnectors)].sort(),
        disabledTools: Object.fromEntries(
          [...disabledTools]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, tools]) => [id, [...tools].sort()])
        ),
      },
    },
    diagnostic: null,
  };
}
