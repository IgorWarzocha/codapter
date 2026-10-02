import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesktopSessionCapabilities } from "@codapter/core";

export interface PiBackendSessionRecord {
  readonly desktopCapabilities?: Pick<DesktopSessionCapabilities, "tools" | "instructions">;
  readonly opaqueSessionId: string;
  readonly sessionFile: string;
  readonly sessionName: string | null;
  readonly modelId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PiBackendStateFile {
  readonly sessions: Record<string, PiBackendSessionRecord>;
}

function createEmptyState(): PiBackendStateFile {
  return { sessions: {} };
}

export class PiBackendStateStore {
  private readonly filePath: string;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private state: PiBackendStateFile = createEmptyState();

  constructor(sessionDir: string) {
    this.filePath = join(sessionDir, ".codapter-pi-backend.json");
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loading) this.loading = this.readState();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async readState(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PiBackendStateFile;
      this.state =
        parsed && typeof parsed === "object" && parsed.sessions ? parsed : createEmptyState();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.state = createEmptyState();
    }

    this.loaded = true;
  }

  async get(opaqueSessionId: string): Promise<PiBackendSessionRecord | null> {
    await this.load();
    return this.state.sessions[opaqueSessionId] ?? null;
  }

  async upsert(record: PiBackendSessionRecord): Promise<void> {
    await this.load();
    this.state = {
      sessions: {
        ...this.state.sessions,
        [record.opaqueSessionId]: record,
      },
    };
    await this.persist();
  }

  async update(
    opaqueSessionId: string,
    patch: Partial<Omit<PiBackendSessionRecord, "opaqueSessionId">>
  ): Promise<PiBackendSessionRecord> {
    await this.load();
    const current = this.state.sessions[opaqueSessionId];
    if (!current) {
      throw new Error(`Unknown Pi session: ${opaqueSessionId}`);
    }

    const updated: PiBackendSessionRecord = {
      ...current,
      ...patch,
    };
    this.state = {
      sessions: {
        ...this.state.sessions,
        [opaqueSessionId]: updated,
      },
    };
    await this.persist();
    return updated;
  }

  async list(): Promise<PiBackendSessionRecord[]> {
    await this.load();
    return Object.values(this.state.sessions);
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    // A failed write remains visible to its caller without poisoning later saves.
    this.writes = write.catch(() => {});
    return write;
  }
}
