import type {
  ThreadItem,
  ThreadItemEntry,
  ThreadItemsListResponse,
  ThreadTurnsListResponse,
  Turn,
  TurnItemsView,
} from "./protocol.js";

type Cursor = { scope: string; anchor: string; includeAnchor: boolean };
type PageOptions = { limit: number; sortDirection: "asc" | "desc" };

function parseParams(params: unknown): Record<string, unknown> & { threadId: string } {
  if (
    !params ||
    typeof params !== "object" ||
    !("threadId" in params) ||
    typeof params.threadId !== "string" ||
    !params.threadId
  ) {
    throw new Error("threadId is required");
  }
  return params as Record<string, unknown> & { threadId: string };
}

function pageOptions(params: Record<string, unknown>, direction: "asc" | "desc"): PageOptions {
  const limit = params.limit ?? 25;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 0xffffffff) {
    throw new Error("limit must be an unsigned 32-bit integer");
  }
  const sortDirection = params.sortDirection ?? direction;
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new Error("sortDirection must be asc or desc");
  }
  return { limit: Math.max(1, Math.min(limit, 100)), sortDirection };
}

function parseCursor(value: unknown, scope: string): Cursor | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("Invalid history cursor");
  let cursor: unknown;
  try {
    cursor = JSON.parse(value);
  } catch {
    throw new Error("Invalid history cursor");
  }
  if (
    !cursor ||
    typeof cursor !== "object" ||
    !("scope" in cursor) ||
    cursor.scope !== scope ||
    !("anchor" in cursor) ||
    typeof cursor.anchor !== "string" ||
    !("includeAnchor" in cursor) ||
    typeof cursor.includeAnchor !== "boolean"
  ) {
    throw new Error("Invalid history cursor for this scope");
  }
  return { scope, anchor: cursor.anchor, includeAnchor: cursor.includeAnchor };
}

// Anchors use stable IDs, not array offsets: newly appended turns must not shift
// continuation pages. Backwards cursors include their anchor to catch updates.
function paginate<T>(
  entries: T[],
  key: (entry: T) => string,
  scope: string,
  cursor: Cursor | null,
  options: PageOptions
): { data: T[]; nextCursor: string | null; backwardsCursor: string | null } {
  const ordered = options.sortDirection === "desc" ? [...entries].reverse() : entries;
  let start = 0;
  if (cursor) {
    const index = ordered.findIndex((entry) => key(entry) === cursor.anchor);
    if (index < 0) throw new Error("Invalid history cursor: anchor is no longer present");
    start = index + (cursor.includeAnchor ? 0 : 1);
  }
  const data = ordered.slice(start, start + options.limit);
  const encode = (entry: T, includeAnchor: boolean) =>
    JSON.stringify({ scope, anchor: key(entry), includeAnchor } satisfies Cursor);
  return {
    data,
    nextCursor: start + data.length < ordered.length ? encode(data[data.length - 1], false) : null,
    backwardsCursor: data.length > 0 ? encode(data[0], true) : null,
  };
}

function projectItems(items: ThreadItem[], view: TurnItemsView): ThreadItem[] {
  if (view === "notLoaded") return [];
  if (view === "full") return items;
  const user = items.find((item) => item.type === "userMessage");
  let agent: ThreadItem | undefined;
  for (const item of items) {
    if (item.type === "agentMessage") agent = item;
  }
  const summary: ThreadItem[] = [];
  if (user) summary.push(user);
  if (agent && agent.id !== user?.id) summary.push(agent);
  return summary;
}

export class ThreadHistory {
  constructor(private readonly readTurns: (threadId: string) => Promise<Turn[]>) {}

  async listTurns(params: unknown): Promise<ThreadTurnsListResponse> {
    const parsed = parseParams(params);
    const options = pageOptions(parsed, "desc");
    const view = parsed.itemsView ?? "summary";
    if (view !== "notLoaded" && view !== "summary" && view !== "full") {
      throw new Error("itemsView must be notLoaded, summary, or full");
    }
    const scope = JSON.stringify(["turns", parsed.threadId]);
    const cursor = parseCursor(parsed.cursor, scope);
    const page = paginate(
      await this.readTurns(parsed.threadId),
      (turn) => turn.id,
      scope,
      cursor,
      options
    );
    return {
      ...page,
      data: page.data.map((turn) => ({
        ...turn,
        items: projectItems(turn.items, view),
        itemsView: view,
      })),
    };
  }

  async listItems(params: unknown): Promise<ThreadItemsListResponse> {
    const parsed = parseParams(params);
    const options = pageOptions(parsed, "asc");
    const turnId = parsed.turnId ?? null;
    if (turnId !== null && (typeof turnId !== "string" || !turnId)) {
      throw new Error("turnId must be a non-empty string");
    }
    const scope = JSON.stringify(["items", parsed.threadId, turnId]);
    let cursor: Cursor | null;
    if (parsed.cursor !== null && typeof parsed.cursor === "object") {
      if (!turnId) throw new Error("An item anchor requires turnId");
      if (
        !("type" in parsed.cursor) ||
        parsed.cursor.type !== "item" ||
        !("itemId" in parsed.cursor) ||
        typeof parsed.cursor.itemId !== "string" ||
        !parsed.cursor.itemId
      ) {
        throw new Error("Invalid item anchor");
      }
      cursor = {
        scope,
        anchor: JSON.stringify([turnId, parsed.cursor.itemId]),
        includeAnchor: false,
      };
    } else {
      cursor = parseCursor(parsed.cursor, scope);
    }
    const turns = await this.readTurns(parsed.threadId);
    const entries: ThreadItemEntry[] = turns
      .filter((turn) => turnId === null || turn.id === turnId)
      .flatMap((turn) =>
        turn.items.map((item) => ({
          turnId: turn.id,
          item,
          // Turn timestamps are not item timestamps. Backends do not currently
          // expose recorded per-item timings through the shared history contract.
          startedAtMs: null,
          completedAtMs: null,
        }))
      );
    return paginate(
      entries,
      (entry) => JSON.stringify([entry.turnId, entry.item.id]),
      scope,
      cursor,
      options
    );
  }
}
