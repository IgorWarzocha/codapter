import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PiBackendStateStore } from "../src/state-store.js";

it("serializes concurrent session snapshots without lost records or temp-file collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codapter-pi-state-"));
  try {
    const store = new PiBackendStateStore(root);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.upsert({
          opaqueSessionId: `session-${index}`,
          sessionFile: `file-${index}.jsonl`,
          sessionName: null,
          modelId: null,
          createdAt: "created",
          updatedAt: "updated",
        })
      )
    );
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update(`session-${index}`, {
          sessionName: `named-${index}`,
        })
      )
    );
    const reopened = new PiBackendStateStore(root);
    const records = await reopened.list();
    expect(records).toHaveLength(20);
    expect(records.every((record) => record.sessionName?.startsWith("named-"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
