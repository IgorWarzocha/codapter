import type { JsonValue, McpToolCallItem, ThreadItem, Turn } from "./protocol.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return record(value) && Object.values(value).every((entry) => entry === undefined || json(entry));
}

interface PendingCall {
  readonly turnId: string;
  readonly item: McpToolCallItem;
}

// The backend emits raw MCP lifecycle events. This owner pairs them within the
// runtime lifetime and retains native items for the existing in-memory read path.
export class ThreadMcpEvents {
  private readonly pending = new Map<string, PendingCall>();
  private readonly items = new Map<string, Map<string, McpToolCallItem>>();

  clear(): void {
    this.pending.clear();
    this.items.clear();
  }

  finishTurn(turnId: string): void {
    for (const [id, call] of this.pending) {
      if (call.turnId === turnId) this.pending.delete(id);
    }
  }

  accept(
    params: unknown,
    scope: { threadId: string; threadHandle: string; turnId: string | null }
  ): { method: "item/started" | "item/completed"; turnId: string; item: McpToolCallItem } {
    if (
      !record(params) ||
      !["started", "completed"].includes(String(params.phase)) ||
      typeof params.callId !== "string" ||
      !params.callId ||
      (params.threadId !== scope.threadId && params.threadId !== scope.threadHandle) ||
      typeof params.turnId !== "string" ||
      params.turnId !== scope.turnId ||
      typeof params.server !== "string" ||
      !params.server ||
      typeof params.tool !== "string" ||
      !params.tool ||
      !json(params.arguments)
    )
      throw new Error("Invalid or inactive Desktop MCP event");

    let item: McpToolCallItem;
    if (params.phase === "started") {
      if (this.pending.has(params.callId) || this.items.get(params.turnId)?.has(params.callId))
        throw new Error("Duplicate Desktop MCP call id");
      item = {
        type: "mcpToolCall",
        id: params.callId,
        server: params.server,
        tool: params.tool,
        status: "inProgress",
        arguments: params.arguments,
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: null,
        result: null,
        error: null,
        durationMs: null,
      };
      this.pending.set(params.callId, { turnId: params.turnId, item });
    } else {
      const pending = this.pending.get(params.callId);
      if (
        !pending ||
        pending.turnId !== params.turnId ||
        pending.item.server !== params.server ||
        pending.item.tool !== params.tool
      )
        throw new Error("Unknown Desktop MCP completion");
      let result: McpToolCallItem["result"] = null;
      if (params.result !== undefined && params.result !== null) {
        if (!record(params.result) || !json(params.result) || !Array.isArray(params.result.content))
          throw new Error("Invalid Desktop MCP result");
        result = {
          ...params.result,
          content: params.result.content,
          structuredContent: params.result.structuredContent ?? null,
          _meta: params.result._meta ?? null,
        };
      }
      const failed = params.error !== undefined && params.error !== null;
      if (!failed && result === null) throw new Error("Desktop MCP completion has no result");
      const error = failed
        ? {
            message:
              typeof params.error === "string"
                ? params.error
                : record(params.error) && typeof params.error.message === "string"
                  ? params.error.message
                  : "Desktop MCP tool call failed",
          }
        : null;
      item = {
        ...pending.item,
        status: failed || result?.isError === true ? "failed" : "completed",
        result,
        error,
        durationMs:
          typeof params.durationMs === "number" &&
          Number.isFinite(params.durationMs) &&
          params.durationMs >= 0
            ? params.durationMs
            : null,
      };
      this.pending.delete(params.callId);
    }
    const items = this.items.get(params.turnId) ?? new Map<string, McpToolCallItem>();
    items.set(item.id, item);
    this.items.set(params.turnId, items);
    return {
      method: params.phase === "started" ? "item/started" : "item/completed",
      turnId: params.turnId,
      item,
    };
  }

  mergeItems(turnId: string, items: readonly ThreadItem[]): ThreadItem[] {
    const canonical = this.items.get(turnId);
    if (!canonical) return [...items];
    const merged = items.map((item) => canonical.get(item.id) ?? item);
    const existing = new Set(items.map((item) => item.id));
    for (const item of canonical.values()) if (!existing.has(item.id)) merged.push(item);
    return merged;
  }

  mergeTurns(turns: readonly Turn[]): Turn[] {
    return turns.map((turn) => ({ ...turn, items: this.mergeItems(turn.id, turn.items) }));
  }

  mergeNotification(params: unknown): unknown {
    if (
      !record(params) ||
      !record(params.turn) ||
      typeof params.turn.id !== "string" ||
      !Array.isArray(params.turn.items)
    )
      return params;
    const canonical = this.items.get(params.turn.id);
    if (!canonical) return params;
    const items = params.turn.items.map((item: unknown) =>
      record(item) && typeof item.id === "string" ? (canonical.get(item.id) ?? item) : item
    );
    const ids = new Set(items.flatMap((item: unknown) => (record(item) ? [item.id] : [])));
    for (const item of canonical.values()) if (!ids.has(item.id)) items.push(item);
    return { ...params, turn: { ...params.turn, items } };
  }
}
