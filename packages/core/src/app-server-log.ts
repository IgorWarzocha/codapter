import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppServerLogger } from "./app-server.js";

export interface DebugLogRecord {
  readonly at: string;
  readonly component: "app-server";
  readonly kind: "startup" | "shutdown" | "backend-event" | "notification" | "state-transition";
  readonly threadId?: string;
  readonly turnId?: string;
  readonly accepted?: boolean;
  readonly method?: string;
  readonly eventType?: string;
  readonly payload?: unknown;
  readonly diagnostics?: unknown;
  readonly durationMs?: number;
}

export class DebugLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly filePath: string,
    private readonly logger: AppServerLogger
  ) {}

  async write(record: DebugLogRecord): Promise<void> {
    if (this.failed) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });

    try {
      await this.pending;
    } catch (error) {
      this.failed = true;
      this.logger.warn("Failed to write debug log", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async flush(): Promise<void> {
    try {
      await this.pending;
    } catch {
      // The logger already reported the failure path.
    }
  }
}
