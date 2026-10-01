import { CollabClient, FAST_TIMEOUT_MS } from "./collab-client.js";
import {
  CloseAgentParams,
  ResumeAgentParams,
  SendInputParams,
  SPAWN_AGENT_DESCRIPTION,
  SpawnAgentParams,
  WaitAgentParams,
} from "./tool-definitions.js";

export { CollabClient } from "./collab-client.js";

const WAIT_TIMEOUT_MS = 3_660_000;

type ExtensionApi = {
  registerTool?(definition: Record<string, unknown>): void;
};

function availableModelsDescription(): string {
  return (
    process.env.CODAPTER_COLLAB_AVAILABLE_MODELS_DESCRIPTION?.trim() ||
    "Available models are determined by the active backend session. Use the model id exactly as shown by that backend."
  );
}

function toToolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
  };
}

function toToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "collab_error";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: code, message }),
      },
    ],
    details: { error: true, code, message },
  };
}

export default async function collabExtension(pi: ExtensionApi): Promise<void> {
  const socketPath = process.env.CODAPTER_COLLAB_UDS;
  const parentThreadId = process.env.CODAPTER_COLLAB_PARENT_THREAD;
  if (!socketPath || !parentThreadId || !pi.registerTool) {
    return;
  }

  const client = new CollabClient(socketPath);
  const modelsDescription = availableModelsDescription();

  const collabCall = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ) => {
    try {
      const callOptions: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs };
      if (signal) {
        callOptions.signal = signal;
      }

      const result = await client.call(method, { parentThreadId, ...params }, callOptions);
      return toToolResult(result);
    } catch (error) {
      return toToolError(error);
    }
  };

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: SPAWN_AGENT_DESCRIPTION.replace(
      "{available_models_description}",
      modelsDescription
    ),
    promptSnippet: "spawn_agent: Spawn a sub-agent for parallel or delegated work",
    parameters: SpawnAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/spawn", params, FAST_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "send_input",
    label: "Send Input",
    description:
      "Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.",
    parameters: SendInputParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/sendInput", params, FAST_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description:
      "Wait for agents to reach a final status. Read the agent's final output from messages[agent_id] when status[agent_id] is completed. Returns empty status/messages when timed out. Pass multiple ids to wait for whichever finishes first. Prefer longer waits (minutes) to avoid busy polling.",
    parameters: WaitAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/wait", params, WAIT_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description:
      "Close an agent when it is no longer needed and return its previous status before shutdown was requested. Prefer leaving recently used agents open for likely follow-up work. Use this mainly when the user explicitly wants the agent closed or you are confident it will not be reused.",
    parameters: CloseAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/close", params, FAST_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "resume_agent",
    label: "Resume Agent",
    description:
      "Resume a previously closed agent by id so it can receive send_input and wait_agent calls.",
    parameters: ResumeAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/resume", params, FAST_TIMEOUT_MS, signal),
  });
}
