import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PiLogRecord {
  readonly at: string;
  readonly component: "pi-process";
  readonly kind: "startup" | "shutdown" | "stdin" | "stdout" | "stderr" | "parsed-event";
  readonly raw: string;
  readonly eventType?: string;
  readonly assistantEventType?: string;
  readonly emittedType?: string;
  readonly delta?: string;
  readonly pid?: number;
  readonly command?: string;
  readonly sessionId?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export class PiLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly filePath: string) {}

  write(record: PiLogRecord): void {
    if (this.failed) {
      return;
    }

    const line = `${JSON.stringify(record)}\n`;
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });

    void this.pending.catch(() => {
      this.failed = true;
    });
  }

  async flush(): Promise<void> {
    try {
      await this.pending;
    } catch {
      this.failed = true;
    }
  }
}
