import type { BackendRouter } from "./backend-router.js";
import type {
  GitInfo,
  Thread,
  ThreadListParams,
  ThreadListResponse,
  ThreadMetadataUpdateParams,
  ThreadMetadataUpdateResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStatus,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  Turn,
} from "./protocol.js";
import { serializeThread } from "./thread-protocol.js";
import type { ThreadRegistry, ThreadRegistryEntry } from "./thread-registry.js";

const DEFAULT_MODEL_PROVIDER = "unknown";
const INTERNAL_TITLE_THREAD_PROMPT_PREFIX =
  "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task";
const INTERNAL_TITLE_THREAD_PROMPT_MARKER = "Generate a concise UI title";
const INTERNAL_TITLE_THREAD_PREVIEW_PREFIX = INTERNAL_TITLE_THREAD_PROMPT_PREFIX.slice(0, 120);

export function isInternalTitlePrompt(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) &&
    normalized.includes(INTERNAL_TITLE_THREAD_PROMPT_MARKER)
  );
}
function isInternalTitlePreview(preview: string | null): boolean {
  const normalized = preview?.trim() ?? "";
  return (
    normalized.startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) ||
    normalized.startsWith(INTERNAL_TITLE_THREAD_PREVIEW_PREFIX)
  );
}
function threadSourceKinds(source: ThreadRegistryEntry["source"]): string[] {
  if ("type" in source) {
    return ["appServer"];
  }

  if ("thread_spawn" in source.subAgent) {
    return ["subAgent", "subAgentThreadSpawn"];
  }

  return ["subAgent"];
}

export class ThreadCatalog {
  constructor(
    private readonly backendRouter: BackendRouter,
    private readonly threadRegistry: ThreadRegistry,
    private readonly statusForThread: (threadId: string) => ThreadStatus,
    private readonly publish: (method: string, params: unknown, threadId: string) => Promise<void>
  ) {}
  private buildThread(entry: ThreadRegistryEntry, turns: Turn[]): Thread {
    return serializeThread(entry, this.statusForThread(entry.threadId), turns);
  }
  async list(params: unknown): Promise<ThreadListResponse> {
    const parsed = (params ?? {}) as Partial<ThreadListParams>;
    const cursor = Number(parsed.cursor ?? "0");
    const limit = parsed.limit ?? 50;
    const entries = [];
    for (const entry of await this.threadRegistry.list()) {
      if (!entry.hidden && isInternalTitlePreview(entry.preview)) {
        entries.push(
          await this.threadRegistry.update(entry.threadId, {
            hidden: true,
            preview: null,
          })
        );
        continue;
      }
      entries.push(entry);
    }

    const visibleEntries = entries
      .filter((entry) => !entry.hidden)
      .filter((entry) => {
        if (parsed.archived !== null && parsed.archived !== undefined) {
          return entry.archived === parsed.archived;
        }
        return !entry.archived;
      })
      .filter(
        (entry) =>
          !parsed.cwd ||
          (Array.isArray(parsed.cwd)
            ? parsed.cwd.includes(entry.cwd ?? "")
            : entry.cwd === parsed.cwd)
      )
      .filter((entry) =>
        !parsed.searchTerm
          ? true
          : `${entry.name ?? ""} ${entry.preview ?? ""}`
              .toLowerCase()
              .includes(parsed.searchTerm.toLowerCase())
      )
      .filter((entry) =>
        !parsed.sourceKinds || parsed.sourceKinds.length === 0
          ? true
          : threadSourceKinds(entry.source).some((kind) => parsed.sourceKinds?.includes(kind))
      )
      .filter((entry) =>
        !parsed.modelProviders || parsed.modelProviders.length === 0
          ? true
          : parsed.modelProviders.includes(entry.modelProvider ?? DEFAULT_MODEL_PROVIDER)
      )
      .sort((left, right) => {
        const key = parsed.sortKey === "updated_at" ? "updatedAt" : "createdAt";
        const order = left[key].localeCompare(right[key]);
        return parsed.sortDirection === "asc" ? order : -order;
      });

    const start = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    const slice = visibleEntries.slice(start, start + limit);
    return {
      data: slice.map((entry) => this.buildThread(entry, [])),
      nextCursor: start + limit < visibleEntries.length ? String(start + limit) : null,
      backwardsCursor: slice.length > 0 ? String(visibleEntries.length - 1 - start) : null,
    };
  }
  async setName(params: unknown): Promise<ThreadSetNameResponse> {
    const parsed = params as ThreadSetNameParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.backendRouter.requireBackend(entry.backendType);
    await backend.threadSetName({
      threadId: parsed.threadId,
      threadHandle: entry.backendSessionId,
      name: parsed.name,
    });
    await this.threadRegistry.update(parsed.threadId, { name: parsed.name });
    await this.publish(
      "thread/name/updated",
      { threadId: parsed.threadId, threadName: parsed.name },
      parsed.threadId
    );
    return {};
  }
  async unarchive(params: unknown): Promise<ThreadUnarchiveResponse> {
    const parsed = params as ThreadUnarchiveParams;
    const updated = await this.threadRegistry.update(parsed.threadId, { archived: false });
    const thread = this.buildThread(updated, []);
    await this.publish("thread/unarchived", { threadId: parsed.threadId }, parsed.threadId);
    return { thread };
  }
  async updateMetadata(params: unknown): Promise<ThreadMetadataUpdateResponse> {
    const parsed = params as ThreadMetadataUpdateParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const gitInfo = this.applyGitInfoPatch(entry.gitInfo, parsed.gitInfo);
    const updated = await this.threadRegistry.update(parsed.threadId, { gitInfo });
    return { thread: this.buildThread(updated, []) };
  }
  private applyGitInfoPatch(
    existing: GitInfo | null,
    patch: ThreadMetadataUpdateParams["gitInfo"] | undefined
  ): GitInfo | null {
    if (patch === undefined) {
      return existing;
    }
    if (patch === null) {
      return null;
    }
    return {
      sha: patch.sha ?? existing?.sha ?? null,
      branch: patch.branch ?? existing?.branch ?? null,
      originUrl: patch.originUrl ?? existing?.originUrl ?? null,
    };
  }
  private async getThreadEntry(threadId: string): Promise<ThreadRegistryEntry> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    return entry;
  }
}
