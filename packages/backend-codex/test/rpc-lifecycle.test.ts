import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexBackend } from "../src/index.js";

function killFixture(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

describe("Codex RPC lifetime", () => {
  it("rejects outstanding requests when disposal starts, before the child exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-cancel-"));
    const scriptPath = join(root, "blocked.mjs");
    const markerPath = join(root, "request-received");
    await writeFile(
      scriptPath,
      `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'model/list') writeFileSync(${JSON.stringify(markerPath)}, 'ready');
});`
    );
    const backend = createCodexBackend({ command: process.execPath, args: [scriptPath] });
    try {
      await backend.initialize();
      const outcome = backend.listModels().then(
        () => "resolved",
        (error: Error) => error.message
      );
      for (let attempt = 0; ; attempt++) {
        try {
          await readFile(markerPath);
          break;
        } catch (error) {
          if (attempt >= 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const disposal = backend.dispose();
      expect(backend.isAlive()).toBe(false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          outcome,
          new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve("still pending"), 100);
          }),
        ]);
        expect(result).toMatch(/disposed/i);
      } finally {
        clearTimeout(timer);
        await disposal;
      }
    } finally {
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills a child that ignores SIGTERM instead of abandoning it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-stubborn-"));
    const scriptPath = join(root, "stubborn.mjs");
    const pidPath = join(root, "pid");
    await writeFile(
      scriptPath,
      `import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
});`
    );
    const backend = createCodexBackend({ command: process.execPath, args: [scriptPath] });
    let pid: number | undefined;
    try {
      await backend.initialize();
      const childPid = Number(await readFile(pidPath, "utf8"));
      pid = childPid;
      await Promise.all([backend.dispose(), backend.dispose()]);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      // Also reap the fixture if a regression leaves the owned child alive.
      if (pid !== undefined) killFixture(pid);
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares concurrent startup and can start a fresh child after disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-restart-"));
    const scriptPath = join(root, "startup.mjs");
    const pidsPath = join(root, "pids");
    await writeFile(
      scriptPath,
      `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(pidsPath)}, process.pid + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n'), 20);
  }
});`
    );
    const backend = createCodexBackend({ command: process.execPath, args: [scriptPath] });
    try {
      await Promise.all([backend.initialize(), backend.initialize()]);
      expect((await readFile(pidsPath, "utf8")).trim().split("\n")).toHaveLength(1);
      await backend.dispose();
      await backend.initialize();
      expect(backend.isAlive()).toBe(true);
      expect((await readFile(pidsPath, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      await backend.dispose();
      const pids = (await readFile(pidsPath, "utf8")).trim().split("\n").map(Number);
      for (const pid of pids) killFixture(pid);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a pending RPC with stderr context when its child exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-pending-exit-"));
    const scriptPath = join(root, "exit.mjs");
    await writeFile(
      scriptPath,
      `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'model/list') {
    process.stderr.write('catalog request failed\\n', () => process.exit(1));
  }
});`
    );
    const backend = createCodexBackend({ command: process.execPath, args: [scriptPath] });
    try {
      await backend.initialize();
      await expect(backend.listModels()).rejects.toThrow("catalog request failed");
      expect(backend.isAlive()).toBe(false);
    } finally {
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
