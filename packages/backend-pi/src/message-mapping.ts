import type { BackendMessage, BackendTokenUsage } from "@codapter/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mapTokenUsage(stats: unknown): BackendTokenUsage {
  const record = isRecord(stats) ? stats : {};
  const tokens = isRecord(record.tokens)
    ? record.tokens
    : isRecord(record.tokenUsage)
      ? record.tokenUsage
      : isRecord((record as { token_usage?: unknown }).token_usage)
        ? ((record as { token_usage?: unknown }).token_usage as Record<string, unknown>)
        : isRecord((record as { statistics?: unknown }).statistics)
          ? ((record as { statistics?: unknown }).statistics as Record<string, unknown>)
          : {};

  const parseCount = (value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  const toTokenCount = (primary: unknown, ...fallbacks: unknown[]) => {
    const fallbackKeys = [primary, ...fallbacks];
    for (const value of fallbackKeys) {
      const parsed = parseCount(value);
      if (parsed !== 0 || value === 0) {
        return parsed;
      }
    }
    return 0;
  };

  const inputTokens = toTokenCount(
    tokens.input,
    (tokens as { inputTokens?: unknown }).inputTokens,
    (tokens as { input_tokens?: unknown }).input_tokens
  );
  const outputTokens = toTokenCount(
    tokens.output,
    (tokens as { outputTokens?: unknown }).outputTokens,
    (tokens as { output_tokens?: unknown }).output_tokens
  );
  const cacheRead = toTokenCount(
    tokens.cacheRead,
    (tokens as { cachedInputTokens?: unknown }).cachedInputTokens,
    (tokens as { cache_read?: unknown }).cache_read
  );
  const cacheWrite = toTokenCount(
    tokens.cacheWrite,
    (tokens as { cachedOutputTokens?: unknown }).cachedOutputTokens,
    (tokens as { cache_write?: unknown }).cache_write
  );
  const totalTokens = toTokenCount(
    tokens.total,
    (tokens as { totalTokens?: unknown }).totalTokens,
    (tokens as { total_tokens?: unknown }).total_tokens
  );

  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead,
    cacheWrite,
    total: totalTokens,
    modelContextWindow: null,
  };
}

function mapMessage(message: unknown, index: number): BackendMessage {
  const record = isRecord(message) ? message : {};
  const timestamp =
    typeof record.timestamp === "number"
      ? new Date(record.timestamp).toISOString()
      : typeof record.timestamp === "string"
        ? new Date(record.timestamp).toISOString()
        : new Date().toISOString();

  return {
    id:
      typeof record.id === "string"
        ? record.id
        : typeof record.entryId === "string"
          ? record.entryId
          : `message-${index}`,
    role: typeof record.role === "string" ? record.role : "unknown",
    content:
      record.role === "toolResult"
        ? structuredClone(record)
        : typeof record.content === "string" ||
            Array.isArray(record.content) ||
            isRecord(record.content)
          ? structuredClone(record.content)
          : structuredClone(record),
    createdAt: timestamp,
  };
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

export function assistantMessageText(message: unknown): string | null {
  if (!isRecord(message)) {
    return null;
  }

  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((entry) => {
      if (!isRecord(entry)) {
        return textFromUnknown(entry);
      }
      if (entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return "";
    })
    .join("");

  return text.length > 0 ? text : null;
}

export function mapBackendMessages(messages: unknown): BackendMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.map((message, index) => mapMessage(message, index));
}
