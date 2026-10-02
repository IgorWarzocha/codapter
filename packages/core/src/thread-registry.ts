import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ConfigObject } from "./config-toml.js";
import { threadBrowserOverrides } from "./desktop-browser-policy.js";
import type { DynamicToolSpec, GitInfo, SessionSource } from "./protocol.js";
import { normalizeDisabledPluginIds, normalizeDynamicTools } from "./thread-desktop.js";

type StoredSessionSource = Exclude<SessionSource, "appServer"> | { type: "appServer" };

export interface ThreadRegistryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ThreadRegistryEntry {
  readonly threadId: string;
  readonly backendSessionId: string;
  readonly backendType: string;
  readonly sessionId?: string;
  readonly forkedFromId?: string | null;
  readonly ephemeral: boolean;
  readonly hidden: boolean;
  readonly name: string | null;
  readonly path: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly cwd: string | null;
  readonly preview: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly reasoningEffort: string | null;
  readonly source: StoredSessionSource;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly gitInfo: GitInfo | null;
  readonly dynamicTools?: readonly DynamicToolSpec[];
  readonly disabledPluginIds?: readonly string[];
  /** Thread-only policy; null means original overrides are unknown. */
  readonly browserOverrides?: ConfigObject | null;
}

export interface CreateThreadRegistryEntry {
  readonly threadId?: string;
  readonly backendSessionId: string;
  readonly backendType: string;
  readonly sessionId?: string;
  readonly forkedFromId?: string | null;
  readonly ephemeral?: boolean;
  readonly hidden?: boolean;
  readonly name?: string | null;
  readonly path?: string | null;
  readonly archived?: boolean;
  readonly cwd?: string | null;
  readonly preview?: string | null;
  readonly model?: string | null;
  readonly modelProvider?: string | null;
  readonly reasoningEffort?: string | null;
  readonly source?: StoredSessionSource;
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  readonly gitInfo?: GitInfo | null;
  readonly dynamicTools?: readonly DynamicToolSpec[];
  readonly disabledPluginIds?: readonly string[];
  readonly browserOverrides?: ConfigObject | null;
}

export interface UpdateThreadRegistryEntry {
  readonly backendSessionId?: string;
  readonly backendType?: string;
  readonly ephemeral?: boolean;
  readonly hidden?: boolean;
  readonly name?: string | null;
  readonly path?: string | null;
  readonly updatedAt?: string;
  readonly archived?: boolean;
  readonly cwd?: string | null;
  readonly preview?: string | null;
  readonly model?: string | null;
  readonly modelProvider?: string | null;
  readonly reasoningEffort?: string | null;
  readonly source?: StoredSessionSource;
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  readonly gitInfo?: GitInfo | null;
  readonly dynamicTools?: readonly DynamicToolSpec[];
  readonly disabledPluginIds?: readonly string[];
  readonly browserOverrides?: ConfigObject | null;
}

interface ThreadRegistryFile {
  readonly threads: ThreadRegistryEntry[];
}

function defaultLogger(): ThreadRegistryLogger {
  return {
    warn(message, context) {
      if (context) {
        console.warn(message, context);
        return;
      }
      console.warn(message);
    },
  };
}

function defaultStateFilePath(): string {
  return resolve(
    process.env.CODAPTER_STATE_DIR ?? resolve(homedir(), ".local", "share", "codapter"),
    "threads.json"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThreadRegistryEntry(value: unknown): value is ThreadRegistryEntry {
  if (!isRecord(value)) {
    return false;
  }

  const source = value.source;
  const validSource =
    source === undefined ||
    source === null ||
    source === "appServer" ||
    (isRecord(source) && source.type === "appServer") ||
    (isRecord(source) &&
      isRecord(source.subAgent) &&
      isRecord(source.subAgent.thread_spawn) &&
      typeof source.subAgent.thread_spawn.parent_thread_id === "string" &&
      typeof source.subAgent.thread_spawn.depth === "number" &&
      (typeof source.subAgent.thread_spawn.agent_nickname === "string" ||
        source.subAgent.thread_spawn.agent_nickname === null ||
        source.subAgent.thread_spawn.agent_nickname === undefined) &&
      (typeof source.subAgent.thread_spawn.agent_role === "string" ||
        source.subAgent.thread_spawn.agent_role === null ||
        source.subAgent.thread_spawn.agent_role === undefined));

  return (
    typeof value.threadId === "string" &&
    typeof value.backendSessionId === "string" &&
    typeof value.backendType === "string" &&
    (typeof value.sessionId === "string" || value.sessionId === undefined) &&
    (typeof value.forkedFromId === "string" ||
      value.forkedFromId === null ||
      value.forkedFromId === undefined) &&
    (typeof value.ephemeral === "boolean" || value.ephemeral === undefined) &&
    (typeof value.hidden === "boolean" || value.hidden === undefined) &&
    (typeof value.name === "string" || value.name === null) &&
    (typeof value.path === "string" || value.path === null || value.path === undefined) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.archived === "boolean" &&
    (typeof value.cwd === "string" || value.cwd === null) &&
    (typeof value.preview === "string" || value.preview === null) &&
    (typeof value.model === "string" || value.model === null || value.model === undefined) &&
    (typeof value.modelProvider === "string" || value.modelProvider === null) &&
    (typeof value.reasoningEffort === "string" ||
      value.reasoningEffort === null ||
      value.reasoningEffort === undefined) &&
    validSource &&
    (typeof value.agentNickname === "string" ||
      value.agentNickname === null ||
      value.agentNickname === undefined) &&
    (typeof value.agentRole === "string" ||
      value.agentRole === null ||
      value.agentRole === undefined) &&
    (isRecord(value.gitInfo) || value.gitInfo === null)
  );
}

export class ThreadRegistry {
  private readonly filePath: string;
  private readonly logger: ThreadRegistryLogger;
  private readonly entries = new Map<string, ThreadRegistryEntry>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private pendingPersistence: Promise<void> = Promise.resolve();

  constructor(filePath = defaultStateFilePath(), logger: ThreadRegistryLogger = defaultLogger()) {
    this.filePath = filePath;
    this.logger = logger;
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loading) {
      this.loading = this.loadFile().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private async loadFile(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn("Failed to parse thread registry; starting with an empty registry", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.loaded = true;
      return;
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.threads)) {
      this.logger.warn("Invalid thread registry root; starting with an empty registry", {
        filePath: this.filePath,
      });
      this.loaded = true;
      return;
    }

    for (const entry of parsed.threads) {
      if (!isThreadRegistryEntry(entry)) {
        this.logger.warn("Skipping invalid thread registry entry", {
          filePath: this.filePath,
        });
        continue;
      }
      const rawSource = (entry as { source?: unknown }).source;
      let dynamicTools: DynamicToolSpec[];
      let disabledPluginIds: string[];
      let browserOverrides: ConfigObject | null | undefined;
      try {
        dynamicTools = normalizeDynamicTools(entry.dynamicTools);
        disabledPluginIds = normalizeDisabledPluginIds(entry.disabledPluginIds);
        browserOverrides =
          entry.backendType === "pi"
            ? entry.browserOverrides == null
              ? null
              : threadBrowserOverrides(entry.browserOverrides)
            : undefined;
      } catch (error) {
        this.logger.warn("Skipping thread with invalid desktop metadata", {
          threadId: entry.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      this.entries.set(entry.threadId, {
        ...entry,
        dynamicTools,
        disabledPluginIds,
        browserOverrides,
        ephemeral: entry.ephemeral ?? false,
        hidden: entry.hidden ?? false,
        path: entry.path ?? null,
        model: entry.model ?? null,
        source:
          rawSource === "appServer" || rawSource === undefined || rawSource === null
            ? { type: "appServer" }
            : entry.source,
        reasoningEffort: entry.reasoningEffort ?? null,
        agentNickname: entry.agentNickname ?? null,
        agentRole: entry.agentRole ?? null,
      });
    }

    this.loaded = true;
  }

  async list(): Promise<ThreadRegistryEntry[]> {
    await this.load();
    return [...this.entries.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  async get(threadId: string): Promise<ThreadRegistryEntry | null> {
    await this.load();
    return this.entries.get(threadId) ?? null;
  }

  async findByBackendSessionId(
    backendSessionId: string,
    backendType?: string | null
  ): Promise<ThreadRegistryEntry | null> {
    await this.load();
    for (const entry of this.entries.values()) {
      if (entry.backendSessionId !== backendSessionId) {
        continue;
      }
      if (backendType && entry.backendType !== backendType) {
        continue;
      }
      return entry;
    }
    return null;
  }

  async create(input: CreateThreadRegistryEntry): Promise<ThreadRegistryEntry> {
    await this.load();

    const now = new Date().toISOString();
    const threadId = input.threadId ?? randomUUID();
    const entry: ThreadRegistryEntry = {
      threadId,
      sessionId: input.sessionId ?? threadId,
      forkedFromId: input.forkedFromId ?? null,
      backendSessionId: input.backendSessionId,
      backendType: input.backendType,
      ephemeral: input.ephemeral ?? false,
      hidden: input.hidden ?? false,
      name: input.name ?? null,
      path: input.path ?? null,
      createdAt: now,
      updatedAt: now,
      archived: input.archived ?? false,
      cwd: input.cwd ?? null,
      preview: input.preview ?? null,
      model: input.model ?? null,
      modelProvider: input.modelProvider ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      source: input.source ?? { type: "appServer" },
      agentNickname: input.agentNickname ?? null,
      agentRole: input.agentRole ?? null,
      gitInfo: input.gitInfo ?? null,
      dynamicTools: normalizeDynamicTools(input.dynamicTools),
      disabledPluginIds: normalizeDisabledPluginIds(input.disabledPluginIds),
      browserOverrides:
        input.backendType === "pi"
          ? input.browserOverrides == null
            ? null
            : threadBrowserOverrides(input.browserOverrides)
          : undefined,
    };

    this.entries.set(entry.threadId, entry);
    await this.persist();
    return entry;
  }

  async update(threadId: string, patch: UpdateThreadRegistryEntry): Promise<ThreadRegistryEntry> {
    await this.load();

    const current = this.entries.get(threadId);
    if (!current) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    const updated: ThreadRegistryEntry = {
      ...current,
      ...patch,
      dynamicTools: normalizeDynamicTools(patch.dynamicTools ?? current.dynamicTools),
      disabledPluginIds: normalizeDisabledPluginIds(
        patch.disabledPluginIds ?? current.disabledPluginIds
      ),
      browserOverrides:
        (patch.backendType ?? current.backendType) === "pi"
          ? patch.browserOverrides === undefined
            ? current.browserOverrides
            : patch.browserOverrides === null
              ? null
              : threadBrowserOverrides(patch.browserOverrides)
          : undefined,
      threadId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    this.entries.set(threadId, updated);
    await this.persist();
    return updated;
  }

  async delete(threadId: string): Promise<void> {
    await this.load();
    this.entries.delete(threadId);
    await this.persist();
  }

  private persist(): Promise<void> {
    const payload: ThreadRegistryFile = {
      threads: [...this.entries.values()],
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    // Atomic rename is not enough: concurrent snapshots must reach disk in mutation order.
    const write = this.pendingPersistence
      .catch(() => {})
      .then(() => this.writeSnapshot(serialized));
    this.pendingPersistence = write;
    return write;
  }

  private async writeSnapshot(serialized: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
