import type { BackendThreadReadResult } from "./backend.js";
import type { BackendRouter } from "./backend-router.js";
import {
  readNativeSessionTurnIds,
  readNativeSubAgentNickname,
  readNativeSubAgentSessionMetadata,
} from "./native-session.js";
import type { Turn } from "./protocol.js";
import { serializeTurnNotification } from "./thread-protocol.js";
import type { ThreadRegistry, ThreadRegistryEntry } from "./thread-registry.js";

function isSubAgentThreadSource(
  source: ThreadRegistryEntry["source"]
): source is Extract<ThreadRegistryEntry["source"], { subAgent: unknown }> {
  return "subAgent" in source;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
interface NativeSubAgentInfo {
  readonly localThreadId: string;
  readonly backendThreadId: string;
  readonly nickname: string | null;
}

export class BackendThreadMirror {
  private readonly streamedCommandItemsByThread = new Map<string, Set<string>>();
  constructor(
    private readonly backendRouter: BackendRouter,
    private readonly threadRegistry: ThreadRegistry,
    private readonly onNativeThreadDiscovered: (entry: ThreadRegistryEntry) => Promise<void>
  ) {}
  clear(): void {
    this.streamedCommandItemsByThread.clear();
  }
  rewriteBackendThreadReferences(threadId: string, threadHandle: string, value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        this.rewriteBackendThreadReferences(threadId, threadHandle, entry)
      );
    }
    if (!isRecord(value)) {
      return value;
    }

    const rewritten: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Tool payloads are application data, not protocol thread references.
      rewritten[key] = [
        "arguments",
        "result",
        "structuredContent",
        "content",
        "_meta",
        "input",
        "output",
        "requestedSchema",
        "inputSchema",
        "outputSchema",
      ].includes(key)
        ? entry
        : this.rewriteBackendThreadReferences(threadId, threadHandle, entry);
    }

    if (rewritten.threadId === threadHandle) {
      rewritten.threadId = threadId;
    }

    if (isRecord(rewritten.thread) && rewritten.thread.id === threadHandle) {
      rewritten.thread = {
        ...rewritten.thread,
        id: threadId,
      };
    }

    return rewritten;
  }

  normalizeReadTurns(entry: ThreadRegistryEntry, turns: Turn[]): Turn[] {
    if (entry.backendType !== "codex" || turns.length === 0) {
      return turns;
    }

    const sessionTurnIds = readNativeSessionTurnIds(entry.path);
    if (!sessionTurnIds || sessionTurnIds.length === 0) {
      return turns;
    }

    const allowedTurnIds = new Set(sessionTurnIds);
    const filtered = turns.filter((turn) => allowedTurnIds.has(turn.id));
    return filtered.length > 0 ? filtered : turns;
  }

  private trackStreamedCommandItem(threadId: string, method: string, params: unknown): void {
    if (
      method === "item/commandExecution/outputDelta" &&
      isRecord(params) &&
      typeof params.itemId === "string"
    ) {
      const streamed = this.streamedCommandItemsByThread.get(threadId) ?? new Set<string>();
      streamed.add(params.itemId);
      this.streamedCommandItemsByThread.set(threadId, streamed);
      return;
    }

    if (
      method === "item/completed" &&
      isRecord(params) &&
      isRecord(params.item) &&
      params.item.type === "commandExecution" &&
      typeof params.item.id === "string"
    ) {
      this.streamedCommandItemsByThread.get(threadId)?.delete(params.item.id);
      return;
    }

    if (method !== "turn/completed") {
      return;
    }

    if (!isRecord(params) || !isRecord(params.turn) || typeof params.turn.id !== "string") {
      return;
    }

    const streamed = this.streamedCommandItemsByThread.get(threadId);
    if (streamed && streamed.size === 0) {
      this.streamedCommandItemsByThread.delete(threadId);
    }
  }

  private rewriteCompletedCommandOutput(
    threadId: string,
    method: string,
    rewritten: unknown
  ): unknown {
    if (
      method !== "item/completed" ||
      !isRecord(rewritten) ||
      !isRecord(rewritten.item) ||
      rewritten.item.type !== "commandExecution" ||
      typeof rewritten.item.id !== "string"
    ) {
      return rewritten;
    }

    const streamed = this.streamedCommandItemsByThread.get(threadId);
    if (!streamed?.has(rewritten.item.id)) {
      return rewritten;
    }

    if (!("aggregatedOutput" in rewritten.item) || rewritten.item.aggregatedOutput === null) {
      return rewritten;
    }

    return {
      ...rewritten,
      item: {
        ...rewritten.item,
        aggregatedOutput: null,
      },
    };
  }

  async syncCanonicalThreadStarted(
    threadId: string,
    params: unknown
  ): Promise<ThreadRegistryEntry | null> {
    if (!isRecord(params) || !isRecord(params.thread)) {
      return null;
    }

    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      return null;
    }

    const backendThread = params.thread;
    const path = typeof backendThread.path === "string" ? backendThread.path : entry.path;
    const cwd = typeof backendThread.cwd === "string" ? backendThread.cwd : entry.cwd;
    const sessionMetadata = readNativeSubAgentSessionMetadata(path);
    const agentNickname = sessionMetadata?.agentNickname ?? entry.agentNickname;
    const agentRole = sessionMetadata?.agentRole ?? entry.agentRole;
    const backendName =
      typeof backendThread.name === "string" && backendThread.name.trim().length > 0
        ? backendThread.name.trim()
        : null;

    let source = entry.source;
    if (isSubAgentThreadSource(entry.source)) {
      source = {
        subAgent: {
          thread_spawn: {
            ...entry.source.subAgent.thread_spawn,
            agent_nickname: agentNickname,
            agent_role: agentRole,
          },
        },
      };
    }

    const name = backendName ?? entry.name;

    if (
      path === entry.path &&
      cwd === entry.cwd &&
      agentNickname === entry.agentNickname &&
      agentRole === entry.agentRole &&
      name === entry.name &&
      source === entry.source
    ) {
      return null;
    }

    const updated = await this.threadRegistry.update(threadId, {
      path,
      cwd,
      source,
      agentNickname,
      agentRole,
      name,
    });
    return updated;
  }

  async syncCanonicalThreadRead(
    threadId: string,
    readResult: BackendThreadReadResult,
    options: {
      allowRecoveredNicknameNameFallback?: boolean;
    } = {}
  ): Promise<ThreadRegistryEntry | null> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      return null;
    }

    const path = readResult.path === undefined ? entry.path : readResult.path;
    const cwd = readResult.cwd ?? entry.cwd;
    const sessionMetadata =
      entry.backendType === "codex" ? readNativeSubAgentSessionMetadata(path) : null;
    const preserveExistingSubAgentIdentity = isSubAgentThreadSource(entry.source);
    const readAgentNickname =
      readResult.agentNickname === null && preserveExistingSubAgentIdentity
        ? entry.agentNickname
        : readResult.agentNickname;
    const readAgentRole =
      readResult.agentRole === null && preserveExistingSubAgentIdentity
        ? entry.agentRole
        : readResult.agentRole;
    const agentNickname =
      sessionMetadata?.agentNickname ??
      (readAgentNickname === undefined ? entry.agentNickname : readAgentNickname);
    const agentRole =
      sessionMetadata?.agentRole ?? (readAgentRole === undefined ? entry.agentRole : readAgentRole);
    const backendTitle =
      typeof readResult.title === "string" && readResult.title.trim().length > 0
        ? readResult.title.trim()
        : null;
    const allowRecoveredNicknameNameFallback = options.allowRecoveredNicknameNameFallback ?? false;

    let source = entry.source;
    if (isSubAgentThreadSource(entry.source)) {
      source = {
        subAgent: {
          thread_spawn: {
            ...entry.source.subAgent.thread_spawn,
            agent_nickname: agentNickname,
            agent_role: agentRole,
          },
        },
      };
    }

    const name =
      backendTitle ??
      entry.name ??
      (allowRecoveredNicknameNameFallback &&
      preserveExistingSubAgentIdentity &&
      typeof agentNickname === "string"
        ? agentNickname
        : null);

    if (
      path === entry.path &&
      cwd === entry.cwd &&
      agentNickname === entry.agentNickname &&
      agentRole === entry.agentRole &&
      name === entry.name &&
      source === entry.source
    ) {
      return null;
    }

    return await this.threadRegistry.update(threadId, {
      path,
      cwd,
      source,
      agentNickname,
      agentRole,
      name,
    });
  }

  private async ensureNativeSubAgentThreads(
    parentThreadId: string,
    item: Record<string, unknown>
  ): Promise<NativeSubAgentInfo[]> {
    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (receiverThreadIds.length === 0) {
      return [];
    }

    const parentEntry = await this.threadRegistry.get(parentThreadId);
    if (!parentEntry) {
      return [];
    }

    const prompt = typeof item.prompt === "string" ? item.prompt : "";
    const model =
      typeof item.model === "string"
        ? this.backendRouter.canonicalizeModelSelection(item.model)
        : null;
    const reasoningEffort = typeof item.reasoningEffort === "string" ? item.reasoningEffort : null;
    const toolCallId = typeof item.id === "string" ? item.id : "";
    const nativeChildren: NativeSubAgentInfo[] = [];

    for (const backendThreadId of receiverThreadIds) {
      const existing = await this.threadRegistry.findByBackendSessionId(
        backendThreadId,
        parentEntry.backendType
      );
      if (existing) {
        nativeChildren.push({
          localThreadId: existing.threadId,
          backendThreadId,
          nickname: existing.agentNickname,
        });
        continue;
      }

      const nickname = readNativeSubAgentNickname(parentEntry.path, toolCallId, backendThreadId);
      const entry = await this.threadRegistry.create({
        backendSessionId: backendThreadId,
        sessionId: parentEntry.sessionId ?? parentEntry.threadId,
        backendType: parentEntry.backendType,
        path: null,
        cwd: parentEntry.cwd ?? process.cwd(),
        preview: prompt.slice(0, 120),
        model,
        modelProvider: parentEntry.backendType,
        reasoningEffort,
        name: null,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_nickname: nickname,
              agent_role: "default",
            },
          },
        },
        agentNickname: nickname,
        agentRole: "default",
        gitInfo: null,
      });
      await this.onNativeThreadDiscovered(entry);

      nativeChildren.push({
        localThreadId: entry.threadId,
        backendThreadId,
        nickname,
      });
    }

    return nativeChildren;
  }

  private async rewriteNativeSubAgentToolItem(
    parentThreadId: string,
    parentThreadHandle: string,
    backendType: string,
    item: Record<string, unknown>,
    nativeChildren: readonly NativeSubAgentInfo[]
  ): Promise<Record<string, unknown>> {
    const childThreadIdByBackendId = new Map(
      nativeChildren.map((child) => [child.backendThreadId, child.localThreadId])
    );

    const resolveThreadReference = async (value: unknown): Promise<unknown> => {
      if (typeof value !== "string") {
        return value;
      }
      if (value === parentThreadId || value === parentThreadHandle) {
        return parentThreadId;
      }
      const existingThreadId = childThreadIdByBackendId.get(value);
      if (existingThreadId) {
        return existingThreadId;
      }
      const existing = await this.threadRegistry.findByBackendSessionId(value, backendType);
      return existing?.threadId ?? value;
    };

    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? await Promise.all(item.receiverThreadIds.map((entry) => resolveThreadReference(entry)))
      : item.receiverThreadIds;

    const rewritten: Record<string, unknown> = {
      ...item,
      senderThreadId: await resolveThreadReference(item.senderThreadId),
      receiverThreadIds,
      model:
        typeof item.model === "string"
          ? this.backendRouter.canonicalizeModelSelection(item.model)
          : item.model,
    };

    if (isRecord(item.agentsStates)) {
      rewritten.agentsStates = Object.fromEntries(
        await Promise.all(
          Object.entries(item.agentsStates).map(async ([key, value]) => [
            (await resolveThreadReference(key)) as string,
            value,
          ])
        )
      );
    }

    return rewritten;
  }

  async translateNotification(
    threadId: string,
    threadHandle: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    let rewritten = this.rewriteBackendThreadReferences(threadId, threadHandle, params);
    if (method === "turn/started" || method === "turn/completed") {
      rewritten = serializeTurnNotification(rewritten);
    }
    const entry = await this.threadRegistry.get(threadId);

    if (
      isRecord(rewritten) &&
      isRecord(rewritten.item) &&
      rewritten.item.type === "collabAgentToolCall" &&
      entry?.backendType === "codex"
    ) {
      const nativeChildren =
        rewritten.item.tool === "spawnAgent" && rewritten.item.status === "completed"
          ? await this.ensureNativeSubAgentThreads(threadId, rewritten.item)
          : [];
      rewritten.item = await this.rewriteNativeSubAgentToolItem(
        threadId,
        threadHandle,
        entry.backendType,
        rewritten.item,
        nativeChildren
      );
    }

    rewritten = this.rewriteCompletedCommandOutput(threadId, method, rewritten);
    this.trackStreamedCommandItem(threadId, method, rewritten);
    return rewritten;
  }
}
