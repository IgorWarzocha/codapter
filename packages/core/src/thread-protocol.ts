import type { Thread, ThreadStatus, Turn } from "./protocol.js";
import type { ThreadRegistryEntry } from "./thread-registry.js";
import { ADAPTER_VERSION } from "./version.js";

// Backends may still return the pre-pagination turn shape. Keep the legacy
// history contract explicit on the desktop boundary, without losing native data.
export function serializeTurn(turn: Turn): Turn {
  return {
    ...turn,
    itemsView: turn.itemsView ?? "full",
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
    error: turn.error ? { ...turn.error, misalignment: turn.error.misalignment ?? null } : null,
  };
}

export function serializeTurnNotification(params: unknown): unknown {
  if (typeof params !== "object" || params === null || !("turn" in params)) return params;
  const turn = params.turn;
  if (typeof turn !== "object" || turn === null) return params;
  const fields = turn as Record<string, unknown>;
  const error = fields.error;
  return {
    ...params,
    turn: {
      ...fields,
      itemsView: fields.itemsView ?? "full",
      startedAt: fields.startedAt ?? null,
      completedAt: fields.completedAt ?? null,
      durationMs: fields.durationMs ?? null,
      error:
        typeof error === "object" && error !== null
          ? { ...error, misalignment: "misalignment" in error ? error.misalignment : null }
          : error,
    },
  };
}

export function serializeThread(
  entry: ThreadRegistryEntry,
  status: ThreadStatus,
  turns: readonly Turn[]
): Thread {
  const parentThreadId =
    "subAgent" in entry.source ? entry.source.subAgent.thread_spawn.parent_thread_id : null;
  return {
    id: entry.threadId,
    sessionId: entry.sessionId ?? entry.threadId,
    forkedFromId: entry.forkedFromId ?? null,
    parentThreadId,
    preview: entry.preview ?? "",
    ephemeral: entry.ephemeral,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: entry.modelProvider ?? entry.backendType,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    createdAt: Math.floor(new Date(entry.createdAt).getTime() / 1000),
    updatedAt: Math.floor(new Date(entry.updatedAt).getTime() / 1000),
    recencyAt: Math.floor(new Date(entry.updatedAt).getTime() / 1000),
    status,
    path: entry.path,
    cwd: entry.cwd ?? process.cwd(),
    cliVersion: ADAPTER_VERSION,
    originator: null,
    source: "type" in entry.source ? "appServer" : entry.source,
    threadSource: null,
    agentNickname: entry.agentNickname,
    agentRole: entry.agentRole,
    gitInfo: entry.gitInfo,
    name: entry.name,
    turns: turns.map(serializeTurn),
  };
}
