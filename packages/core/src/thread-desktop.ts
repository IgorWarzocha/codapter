import type { DesktopSessionCapabilities, DesktopTool } from "./desktop-capabilities.js";
import type {
  ConfigReadParams,
  ConfigReadResponse,
  DynamicToolNamespaceTool,
  DynamicToolSpec,
  JsonValue,
  PluginInstalledParams,
  PluginInstalledResponse,
  PluginListParams,
  PluginListResponse,
  PluginReadParams,
  PluginReadResponse,
  SkillsListParams,
  SkillsListResponse,
  UserInput,
} from "./protocol.js";
import type { ThreadExecutionSettings } from "./thread-execution.js";

export interface ThreadDesktopPlugins {
  readConfig?(params: ConfigReadParams): Promise<ConfigReadResponse>;
  list?(params: PluginListParams): Promise<PluginListResponse>;
  installed?(params: PluginInstalledParams): Promise<PluginInstalledResponse>;
  read?(params: PluginReadParams): Promise<PluginReadResponse>;
  skills?(params: SkillsListParams): Promise<SkillsListResponse>;
  capabilities(
    cwd: string,
    config: Record<string, JsonValue | undefined> | null,
    disabledPluginIds?: readonly string[]
  ): Promise<Pick<DesktopSessionCapabilities, "mcpServers" | "instructions" | "browserConfig">>;
  expandInput(
    input: readonly UserInput[],
    cwd: string,
    config?: Record<string, JsonValue | undefined> | null,
    disabledPluginIds?: readonly string[]
  ): Promise<UserInput[]>;
}

export class DynamicToolValidationError extends Error {}

export function normalizeDisabledPluginIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0))
    throw new DynamicToolValidationError("disabledPluginIds must be an array of nonempty strings");
  return [...new Set(value)];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return record(value) && Object.values(value).every(json);
}

function identifier(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value) || value.length > limit) {
    throw new DynamicToolValidationError(
      `Invalid dynamic tool ${label}: expected 1-${limit} ASCII identifier characters`
    );
  }
  if (value === "mcp" || value.startsWith("mcp__")) {
    throw new DynamicToolValidationError(`Reserved dynamic tool ${label}: ${value}`);
  }
  return value;
}

function functionTool(
  value: unknown,
  namespace: string | null,
  legacy: boolean
): DynamicToolNamespaceTool {
  if (!record(value) || (!legacy && value.type !== "function")) {
    throw new DynamicToolValidationError("Invalid dynamic tool function");
  }
  const name = identifier(value.name, "name", 128);
  if (typeof value.description !== "string")
    throw new DynamicToolValidationError(`Invalid dynamic tool description: ${name}`);
  if (
    !json(value.inputSchema) ||
    (!record(value.inputSchema) && typeof value.inputSchema !== "boolean")
  ) {
    throw new DynamicToolValidationError(`Invalid dynamic tool inputSchema: ${name}`);
  }
  if (
    value.deferLoading !== undefined &&
    typeof value.deferLoading !== "boolean" &&
    !(legacy && value.deferLoading === null)
  ) {
    throw new DynamicToolValidationError(`Invalid dynamic tool deferLoading: ${name}`);
  }
  if (
    legacy &&
    value.exposeToContext !== undefined &&
    value.exposeToContext !== null &&
    typeof value.exposeToContext !== "boolean"
  ) {
    throw new DynamicToolValidationError(`Invalid dynamic tool exposeToContext: ${name}`);
  }
  const deferLoading =
    typeof value.deferLoading === "boolean"
      ? value.deferLoading
      : legacy && typeof value.exposeToContext === "boolean"
        ? !value.exposeToContext
        : false;
  if (deferLoading && namespace === null)
    throw new DynamicToolValidationError(`Deferred dynamic tool requires a namespace: ${name}`);
  // Persist only definitions, never unrelated fields such as client authentication.
  return {
    type: "function",
    name,
    description: value.description,
    inputSchema: structuredClone(value.inputSchema),
    deferLoading,
  };
}

const RESERVED_NAMESPACES = new Set([
  "api_tool",
  "browser",
  "computer",
  "container",
  "file_search",
  "functions",
  "image_gen",
  "multi_tool_use",
  "python",
  "python_user_visible",
  "submodel_delegator",
  "terminal",
  "tool_search",
  "web",
]);

function namespaceName(value: unknown): string {
  const name = identifier(value, "namespace", 64);
  if (RESERVED_NAMESPACES.has(name))
    throw new DynamicToolValidationError(`Reserved dynamic tool namespace: ${name}`);
  return name;
}

export function normalizeDynamicTools(value: unknown): DynamicToolSpec[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new DynamicToolValidationError("dynamicTools must be an array");
  const legacy = value.some(
    (tool) =>
      record(tool) &&
      (tool.type === undefined ||
        "namespace" in tool ||
        "exposeToContext" in tool ||
        (Array.isArray(tool.tools) &&
          tool.tools.some(
            (child) =>
              record(child) &&
              (child.type === undefined || "namespace" in child || "exposeToContext" in child)
          )))
  );
  if (legacy && value.some((tool) => record(tool) && tool.type !== undefined)) {
    throw new DynamicToolValidationError(
      "dynamicTools must use canonical or legacy format consistently"
    );
  }
  const result: DynamicToolSpec[] = [];
  const namespaces = new Map<string, Extract<DynamicToolSpec, { type: "namespace" }>>();
  for (const tool of value) {
    if (!record(tool)) throw new DynamicToolValidationError("Invalid dynamic tool definition");
    if (legacy) {
      const namespace =
        tool.namespace === undefined || tool.namespace === null
          ? null
          : namespaceName(tool.namespace);
      const fn = functionTool(tool, namespace, true);
      if (namespace === null) result.push(fn);
      else {
        let group = namespaces.get(namespace);
        if (!group) {
          group = { type: "namespace", name: namespace, description: "", tools: [] };
          namespaces.set(namespace, group);
          result.push(group);
        }
        group.tools.push(fn);
      }
    } else if (tool.type === "namespace") {
      const name = namespaceName(tool.name);
      if (namespaces.has(name))
        throw new DynamicToolValidationError(`Duplicate dynamic tool namespace: ${name}`);
      if (
        typeof tool.description !== "string" ||
        [...tool.description].length > 1024 ||
        !Array.isArray(tool.tools) ||
        tool.tools.length === 0
      ) {
        throw new DynamicToolValidationError(`Invalid dynamic tool namespace definition: ${name}`);
      }
      const group: Extract<DynamicToolSpec, { type: "namespace" }> = {
        type: "namespace",
        name,
        description: tool.description,
        tools: tool.tools.map((child) => functionTool(child, name, false)),
      };
      namespaces.set(name, group);
      result.push(group);
    } else result.push(functionTool(tool, null, false));
  }
  const seen = new Set<string>();
  for (const tool of flattenDynamicTools(result)) {
    const key = JSON.stringify([tool.namespace, tool.name]);
    if (seen.has(key)) throw new DynamicToolValidationError(`Duplicate dynamic tool: ${key}`);
    seen.add(key);
  }
  return result;
}

function flattenDynamicTools(specs: readonly DynamicToolSpec[]): DesktopTool[] {
  return specs.flatMap((spec) => {
    const namespace = spec.type === "namespace" ? spec.name : null;
    const tools = spec.type === "namespace" ? spec.tools : [spec];
    return tools.map((tool) => ({
      namespace,
      name: tool.name,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      deferLoading: tool.deferLoading ?? false,
    }));
  });
}

export class ThreadDesktop {
  constructor(
    private readonly execution: ThreadExecutionSettings,
    private readonly plugins?: ThreadDesktopPlugins
  ) {}

  async capabilities(
    cwd: string,
    config: Record<string, JsonValue | undefined> | null,
    tools: readonly DynamicToolSpec[],
    disabledPluginIds: readonly string[] = [],
    browserOverridesKnown = true
  ): Promise<DesktopSessionCapabilities> {
    const effective = this.execution.readDesktopConfig(cwd, config);
    const catalog = disabledPluginIds.length
      ? await this.plugins?.capabilities(cwd, effective, disabledPluginIds)
      : await this.plugins?.capabilities(cwd, effective);
    return {
      tools: flattenDynamicTools(tools),
      mcpServers: catalog?.mcpServers ?? {},
      instructions: catalog?.instructions ?? [],
      ...(!browserOverridesKnown
        ? { browserConfig: { error: "Original thread Browser overrides are unavailable" } }
        : catalog?.browserConfig
          ? { browserConfig: catalog.browserConfig }
          : {}),
    };
  }

  async expandInput(
    input: readonly UserInput[],
    cwd: string,
    config: Record<string, JsonValue | undefined> | null = null,
    disabledPluginIds: readonly string[] = []
  ): Promise<UserInput[]> {
    if (!this.plugins) return [...input];
    if (disabledPluginIds.length)
      return this.plugins.expandInput(input, cwd, config, disabledPluginIds);
    return config === null
      ? this.plugins.expandInput(input, cwd)
      : this.plugins.expandInput(input, cwd, config);
  }
}
