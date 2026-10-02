import { createHash } from "node:crypto";
import type { DesktopSessionCapabilities, DesktopTool, JsonValue } from "@codapter/core";
import { convertImages } from "../image-input.js";
import { DesktopAuthProviderClient, type NativeProviderAuthResolver } from "./auth-client.js";
import { desktopRequest } from "./client.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  details: { response: unknown };
  isError: boolean;
}
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  namespace?: { name: string };
  exposure: "direct" | "deferred" | "hidden";
  execute(callId: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
}

// Structural subset of Pi 0.99.2/1.0 ExtensionAPI. No runtime SDK or global config dependency.
interface DesktopExtensionContext {
  modelRegistry: { getProviderAuth: NativeProviderAuthResolver };
}
interface DesktopExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  registerMcpServer(name: string, config: Record<string, unknown>): void;
  unregisterMcpServer(name: string): void;
  getAllTools(): readonly { name: string }[];
  on(
    event: "session_start" | "input",
    handler: (event: unknown, ctx: DesktopExtensionContext) => Promise<void>
  ): unknown;
  on(
    event: "session_before_switch" | "session_before_fork" | "session_shutdown",
    handler: () => void
  ): unknown;
  on(
    event: "before_agent_start",
    handler: (event: {
      systemPromptOptions: { appendSystemPrompt: string; forceSystemPrompt?: string };
    }) => void
  ): unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}

function parseCapabilities(value: unknown): DesktopSessionCapabilities {
  if (
    !record(value) ||
    !Array.isArray(value.tools) ||
    !record(value.mcpServers) ||
    !Array.isArray(value.instructions) ||
    !value.instructions.every((item) => typeof item === "string")
  )
    throw new Error("Invalid Desktop capabilities");
  const tools: DesktopTool[] = [];
  for (const tool of value.tools) {
    if (
      !record(tool) ||
      typeof tool.name !== "string" ||
      !tool.name ||
      !(tool.namespace === null || typeof tool.namespace === "string") ||
      typeof tool.description !== "string" ||
      typeof tool.deferLoading !== "boolean" ||
      !(record(tool.inputSchema) || typeof tool.inputSchema === "boolean") ||
      !jsonValue(tool.inputSchema)
    )
      throw new Error("Invalid Desktop tool definition");
    tools.push({
      name: tool.name,
      namespace: tool.namespace,
      description: tool.description,
      inputSchema: tool.inputSchema,
      deferLoading: tool.deferLoading,
    });
  }
  const mcpServers: Record<string, JsonValue> = {};
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (!record(server) || !jsonValue(server)) throw new Error("Invalid Desktop MCP server");
    mcpServers[name] = server;
  }
  return { tools, mcpServers, instructions: value.instructions };
}

export function desktopToolName(tool: Pick<DesktopTool, "name" | "namespace">): string {
  // Tuple encoding distinguishes null, literal "global", and delimiter-containing names.
  // Full SHA-256 keeps the native name under provider limits without truncating identities.
  const digest = createHash("sha256")
    .update(JSON.stringify([tool.namespace, tool.name]))
    .digest("base64url");
  return `desktop__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 11)}_${digest}`;
}

async function toolResult(response: unknown, signal?: AbortSignal): Promise<ToolResult> {
  if (
    !record(response) ||
    typeof response.success !== "boolean" ||
    !Array.isArray(response.contentItems)
  )
    throw new Error("Invalid Desktop tool response");
  const content: Content[] = [];
  for (const item of response.contentItems) {
    if (!record(item)) throw new Error("Invalid Desktop tool output");
    if (item.type === "inputText" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    } else if (item.type === "inputImage" && typeof item.imageUrl === "string") {
      const images = await convertImages([{ type: "image", url: item.imageUrl }], signal);
      if (images) content.push(...images);
    } else throw new Error("Unsupported Desktop tool output");
  }
  return { content, details: { response }, isError: !response.success };
}

export default function desktopExtension(pi: DesktopExtensionAPI): void {
  const path = process.env.CODAPTER_DESKTOP_UDS;
  if (!path) return;
  let instructions: readonly string[] = [];
  const tools = new Map<string, DesktopTool>();
  const ownedNames = new Set<string>();
  const servers = new Map<string, string>();
  let latestCtx: DesktopExtensionContext | undefined;
  const auth = new DesktopAuthProviderClient(
    path,
    (provider) => latestCtx?.modelRegistry.getProviderAuth(provider) ?? Promise.resolve(undefined)
  );

  const definition = (tool: DesktopTool, hidden = false): ToolDefinition => {
    const parameters =
      tool.inputSchema === true
        ? { type: "object", properties: {}, additionalProperties: true }
        : tool.inputSchema === false
          ? { type: "object", properties: {}, not: {} }
          : tool.inputSchema;
    if (!record(parameters)) throw new Error("Desktop tool requires an object or boolean schema");
    return {
      name: desktopToolName(tool),
      label: tool.name,
      description: tool.description,
      parameters,
      ...(tool.namespace ? { namespace: { name: tool.namespace } } : {}),
      exposure: hidden ? "hidden" : tool.deferLoading ? "deferred" : "direct",
      async execute(callId, args, signal) {
        const current = tools.get(desktopToolName(tool));
        if (hidden || current !== tool) throw new Error("Desktop tool is no longer available");
        try {
          return await toolResult(
            await desktopRequest(
              path,
              "desktop/tool/call",
              {
                callId,
                namespace: tool.namespace,
                tool: tool.name,
                arguments: args,
              },
              signal
            ),
            signal
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof Error && "rpcError" in error) {
            return {
              content: [{ type: "text", text: error.message }],
              details: { response: { error: error.rpcError } },
              isError: true,
            };
          }
          throw error;
        }
      },
    };
  };

  const revokeServers = () => {
    for (const name of servers.keys()) pi.unregisterMcpServer(name);
    servers.clear();
  };
  const refresh = async (registerServers: boolean) => {
    const capabilities = parseCapabilities(await desktopRequest(path, "desktop/capabilities"));
    const next = new Map(capabilities.tools.map((tool) => [desktopToolName(tool), tool]));
    if (next.size !== capabilities.tools.length) throw new Error("Duplicate Desktop tool names");
    const nativeNames = new Set(pi.getAllTools().map((tool) => tool.name));
    for (const name of next.keys()) {
      if (nativeNames.has(name) && !ownedNames.has(name))
        throw new Error(`Desktop tool conflicts with native tool: ${name}`);
    }
    // Pi has no unregisterTool API. Hidden definitions are unreachable even through codemode.
    for (const [name, tool] of tools) {
      if (!next.has(name)) {
        pi.registerTool(definition(tool, true));
        tools.delete(name);
      }
    }
    for (const [name, tool] of next) {
      if (JSON.stringify(tools.get(name)) !== JSON.stringify(tool)) {
        pi.registerTool(definition(tool));
        tools.set(name, tool);
      }
      ownedNames.add(name);
    }
    instructions = capabilities.instructions;
    // Native startup is followed by new/switch/clone before the first GUI input.
    // Registering here during session_start would make Pi connect the same server twice.
    if (!registerServers) return;
    for (const [name, serialized] of servers) {
      if (JSON.stringify(capabilities.mcpServers[name]) !== serialized) {
        pi.unregisterMcpServer(name);
        servers.delete(name);
      }
    }
    for (const [name, config] of Object.entries(capabilities.mcpServers)) {
      const serialized = JSON.stringify(config);
      if (servers.get(name) !== serialized) {
        if (!record(config)) throw new Error("Invalid Desktop MCP config");
        const proxyPath = process.env.CODAPTER_DESKTOP_MCP_PROXY;
        const registeredConfig =
          name === "node_repl" && typeof config.command === "string" && proxyPath
            ? {
                ...config,
                command: process.execPath,
                args: [proxyPath],
                env: {
                  ...(record(config.env) ? config.env : {}),
                  CODAPTER_DESKTOP_UDS: path.replaceAll("$", () => "$$"),
                  // Pi resolves env templates. Encode the envelope so command/args/cwd stay opaque.
                  CODAPTER_DESKTOP_MCP_CONFIG: Buffer.from(JSON.stringify(config)).toString(
                    "base64"
                  ),
                },
              }
            : config;
        pi.registerMcpServer(name, registeredConfig);
        servers.set(name, serialized);
      }
    }
  };
  const refreshSafely = async (registerServers: boolean) => {
    try {
      await refresh(registerServers);
    } catch (error) {
      // Pi reports hook errors and continues. Revoke owned capabilities before that continuation.
      for (const tool of tools.values()) pi.registerTool(definition(tool, true));
      tools.clear();
      revokeServers();
      instructions = [];
      throw error;
    }
  };
  pi.on("session_before_switch", revokeServers);
  pi.on("session_before_fork", revokeServers);
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    await auth.start();
    await refreshSafely(false);
  });
  pi.on("input", async (_event, ctx) => {
    latestCtx = ctx;
    await auth.start();
    await refreshSafely(true);
  });
  pi.on("session_shutdown", () => auth.dispose());
  pi.on("before_agent_start", (event) => {
    if (instructions.length) {
      const addition = `\n\n${instructions.join("\n\n")}`;
      if (event.systemPromptOptions.forceSystemPrompt !== undefined)
        event.systemPromptOptions.forceSystemPrompt += addition;
      else event.systemPromptOptions.appendSystemPrompt += addition;
    }
  });
}
