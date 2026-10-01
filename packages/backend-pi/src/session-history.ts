import type { BackendMessage } from "@codapter/core";

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeHistoryContentEntry(entry: unknown): Record<string, unknown> {
  if (isRecord(entry)) {
    const content = structuredClone(entry);
    // Pi text blocks omit Codex's required UI-span array.
    if (content.type === "text" && !Array.isArray(content.text_elements)) {
      content.text_elements = [];
    }
    return content;
  }
  return {
    type: "text",
    text: textFromUnknown(entry),
    text_elements: [],
  };
}

function userMessageContentFromHistory(value: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(value) ? value : [value]).map(normalizeHistoryContentEntry);
}

function textFromHistoryContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => textFromHistoryContent(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "text" && typeof value.text === "string") {
    return value.text;
  }
  if (Array.isArray(value.content)) {
    return textFromHistoryContent(value.content);
  }
  return "";
}

function inferToolCommand(input: unknown): string {
  if (isRecord(input)) {
    const command = input.command;
    if (typeof command === "string") {
      return command;
    }
    if (Array.isArray(command)) {
      return command.filter((entry): entry is string => typeof entry === "string").join(" ");
    }
  }
  return textFromUnknown(input);
}

function toolCallCommandFromHistory(block: Record<string, unknown>): string {
  const fallbackName = typeof block.name === "string" ? block.name : "tool";
  const command = inferToolCommand(block.arguments);
  if (command.length === 0) {
    return fallbackName;
  }
  if (isRecord(block.arguments) && "command" in block.arguments) {
    return command;
  }
  return `${fallbackName} ${command}`;
}

export function mapHistoryToTurns(history: readonly BackendMessage[]) {
  const turns: Array<{
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  }> = [];
  let current: {
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  } | null = null;
  const pendingToolItems = new Map<string, Record<string, unknown>>();

  const ensureTurn = (fallbackId: string) => {
    if (current) {
      return current;
    }
    current = {
      id: fallbackId,
      items: [],
      status: "completed",
      error: null,
    };
    turns.push(current);
    pendingToolItems.clear();
    return current;
  };

  const finalizeTurn = () => {
    for (const pending of pendingToolItems.values()) {
      if (pending.type === "commandExecution" && pending.status === "inProgress") {
        pending.status = "completed";
        pending.exitCode = pending.exitCode ?? 0;
        pending.durationMs = pending.durationMs ?? 0;
      }
    }
    pendingToolItems.clear();
    current = null;
  };

  for (const message of history) {
    if (message.role === "user") {
      finalizeTurn();
      const turn = ensureTurn(message.id);
      turn.items.push({
        type: "userMessage",
        id: `${message.id}_user`,
        content: userMessageContentFromHistory(message.content),
      });
      continue;
    }

    const turn = ensureTurn(message.id);
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      for (const [index, block] of blocks.entries()) {
        if (!isRecord(block)) {
          const text = textFromHistoryContent(block);
          if (text.length > 0) {
            turn.items.push({
              type: "agentMessage",
              id: `${message.id}_agent_${index}`,
              text,
              phase: null,
            });
          }
          continue;
        }

        if (block.type === "thinking" && typeof block.thinking === "string") {
          turn.items.push({
            type: "reasoning",
            id: `${message.id}_reasoning_${index}`,
            summary: [block.thinking],
            content: [],
          });
          continue;
        }

        if (block.type === "toolCall") {
          const toolCallId =
            typeof block.id === "string" && block.id.length > 0
              ? block.id
              : `${message.id}_tool_${index}`;
          const commandItem: Record<string, unknown> = {
            type: "commandExecution",
            id: `${message.id}_tool_${index}`,
            command: toolCallCommandFromHistory(block),
            cwd: "",
            processId: null,
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          turn.items.push(commandItem);
          pendingToolItems.set(toolCallId, commandItem);
          continue;
        }

        const text = textFromHistoryContent(block);
        if (text.length > 0) {
          turn.items.push({
            type: "agentMessage",
            id: `${message.id}_agent_${index}`,
            text,
            phase: null,
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const payload = isRecord(message.content) ? message.content : {};
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
      const pending = toolCallId ? pendingToolItems.get(toolCallId) : null;
      const outputText = textFromHistoryContent(payload.content);
      if (pending) {
        pending.aggregatedOutput = outputText || null;
        pending.status = payload.isError ? "failed" : "completed";
        pending.exitCode = payload.isError ? 1 : 0;
        pending.durationMs = 0;
        if (toolCallId) {
          pendingToolItems.delete(toolCallId);
        }
      }
      continue;
    }

    const text = textFromHistoryContent(message.content);
    if (text.length > 0) {
      turn.items.push({
        type: "agentMessage",
        id: `${message.id}_agent`,
        text,
        phase: null,
      });
    }
  }

  finalizeTurn();
  return turns;
}

function userMessageContentFromTurn(turn: {
  readonly items?: readonly Record<string, unknown>[];
}): unknown[] | null {
  const item = turn.items?.find((entry) => entry.type === "userMessage");
  if (!item || !Array.isArray(item.content)) {
    return null;
  }
  return item.content;
}

function historyTailDuplicatesLiveTurn(
  turns: readonly {
    readonly items: readonly Record<string, unknown>[];
    readonly status: string;
  }[],
  liveTurn: {
    readonly items?: readonly Record<string, unknown>[];
    readonly status?: string;
  }
): boolean {
  if (liveTurn.status !== "inProgress") {
    return false;
  }

  const trailingTurn = turns.at(-1);
  if (trailingTurn?.status !== "completed") {
    return false;
  }

  if (trailingTurn.items.some((item) => item.type !== "userMessage")) {
    return false;
  }

  const trailingUserContent = userMessageContentFromTurn(trailingTurn);
  const liveUserContent = userMessageContentFromTurn(liveTurn);
  if (!trailingUserContent || !liveUserContent) {
    return false;
  }

  return JSON.stringify(trailingUserContent) === JSON.stringify(liveUserContent);
}

export function mergeHistoryTurnsWithLiveTurn(
  turns: Array<{
    id: string;
    items: Array<Record<string, unknown>>;
    status: "completed";
    error: null;
  }>,
  liveTurn: {
    readonly items?: readonly Record<string, unknown>[];
    readonly status?: string;
  }
): typeof turns {
  if (historyTailDuplicatesLiveTurn(turns, liveTurn)) {
    return turns.slice(0, -1);
  }
  return turns;
}
