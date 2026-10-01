import { readFileSync } from "node:fs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readNativeSubAgentNickname(
  parentPath: string | null,
  toolCallId: string,
  backendThreadId: string
): string | null {
  if (!parentPath) {
    return null;
  }

  try {
    const lines = readFileSync(parentPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = JSON.parse(lines[index] ?? "");
      if (
        !isRecord(parsed) ||
        parsed.type !== "response_item" ||
        !isRecord(parsed.payload) ||
        parsed.payload.type !== "function_call_output" ||
        parsed.payload.call_id !== toolCallId ||
        typeof parsed.payload.output !== "string"
      ) {
        continue;
      }
      const output = JSON.parse(parsed.payload.output);
      if (!isRecord(output) || output.agent_id !== backendThreadId) {
        continue;
      }
      return typeof output.nickname === "string" && output.nickname.length > 0
        ? output.nickname
        : null;
    }
  } catch {
    return null;
  }

  return null;
}

export function readNativeSubAgentSessionMetadata(sessionPath: string | null): {
  agentNickname: string | null;
  agentRole: string | null;
} | null {
  if (!sessionPath) {
    return null;
  }

  try {
    const lines = readFileSync(sessionPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
        continue;
      }

      const payload = parsed.payload;
      const subagent =
        isRecord(payload.source) && isRecord(payload.source.subagent)
          ? payload.source.subagent
          : null;
      const threadSpawn =
        subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
      return {
        agentNickname:
          typeof payload.agent_nickname === "string"
            ? payload.agent_nickname
            : typeof threadSpawn?.agent_nickname === "string"
              ? threadSpawn.agent_nickname
              : null,
        agentRole:
          typeof payload.agent_role === "string"
            ? payload.agent_role
            : typeof threadSpawn?.agent_role === "string"
              ? threadSpawn.agent_role
              : null,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function readNativeSessionTurnIds(sessionPath: string | null): string[] | null {
  if (!sessionPath) {
    return null;
  }

  try {
    const turnIds: string[] = [];
    const seen = new Set<string>();
    const lines = readFileSync(sessionPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) {
        continue;
      }

      let turnId: string | null = null;
      if (parsed.type === "turn_context" && isRecord(parsed.payload)) {
        turnId = typeof parsed.payload.turn_id === "string" ? parsed.payload.turn_id : null;
      } else if (
        parsed.type === "event_msg" &&
        isRecord(parsed.payload) &&
        parsed.payload.type === "task_started"
      ) {
        turnId = typeof parsed.payload.turn_id === "string" ? parsed.payload.turn_id : null;
      }

      if (!turnId || seen.has(turnId)) {
        continue;
      }
      seen.add(turnId);
      turnIds.push(turnId);
    }

    return turnIds;
  } catch {
    return null;
  }
}
