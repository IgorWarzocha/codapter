import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryConfigStore } from "../src/config-store.js";

describe("InMemoryConfigStore", () => {
  it("loads and persists native quoted plugin settings and ordered skill rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-config-native-"));
    const filePath = join(directory, "config.toml");
    try {
      await writeFile(
        filePath,
        `[plugins."browser@openai-bundled"]\nenabled = true\n[mcp_servers.node_repl]\ncommand = "node"\nenv = { NODE_REPL_HOME = "\${HOME}/native" }\n[skills]\nconfig = [{ name = "browser", enabled = false }, { path = "/plugin/SKILL.md", enabled = true }]\n`
      );
      const store = new InMemoryConfigStore(filePath);
      store.writeValue({
        keyPath: 'plugins."browser@openai-bundled".enabled',
        value: false,
        mergeStrategy: "replace",
      });
      store.writeValue({
        keyPath: "mcp_servers.node_repl.env",
        value: { EXTRA: "literal" },
        mergeStrategy: "upsert",
      });
      expect(new InMemoryConfigStore(filePath).read({ includeLayers: false }).config).toMatchObject(
        {
          model: null,
          plugins: { "browser@openai-bundled": { enabled: false } },
          mcp_servers: {
            node_repl: { env: { NODE_REPL_HOME: `\${HOME}/native`, EXTRA: "literal" } },
          },
          skills: {
            config: [
              { name: "browser", enabled: false },
              { path: "/plugin/SKILL.md", enabled: true },
            ],
          },
        }
      );
      await writeFile(filePath, '"__proto__" = { polluted = true }');
      expect(() => new InMemoryConfigStore(filePath)).toThrow();
      await writeFile(filePath, 'http_headers = { Authorization = "SECRET_FIXTURE" invalid }');
      expect(() => new InMemoryConfigStore(filePath)).toThrow(/Invalid.*configuration/);
      expect(Object.prototype).not.toHaveProperty("polluted");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not publish config or version changes when validation or serialization fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-config-transaction-"));
    const filePath = join(directory, "config.toml");
    try {
      const store = new InMemoryConfigStore(filePath);
      store.writeValue({ keyPath: "model", value: "original", mergeStrategy: "replace" });
      const snapshot = store.read({ includeLayers: true });
      const original = structuredClone(snapshot.config);
      const raw = await readFile(filePath, "utf8");
      const version = store.version;
      expect(() =>
        store.writeBatch({
          expectedVersion: version,
          edits: [
            { keyPath: "model", value: "must-not-publish", mergeStrategy: "replace" },
            { keyPath: 'plugins."__proto__".enabled', value: true, mergeStrategy: "replace" },
          ],
        })
      ).toThrow();
      expect(store.read({ includeLayers: false }).config).toEqual(original);
      expect(snapshot.config).toEqual(original);
      expect(store.version).toBe(version);
      expect(await readFile(filePath, "utf8")).toBe(raw);
      expect(() =>
        store.writeValue({
          keyPath: "skills.config",
          value: [{ enabled: true }, null, { enabled: false }],
          mergeStrategy: "replace",
          expectedVersion: version,
        })
      ).toThrow();
      expect(() =>
        store.writeValue({
          keyPath: "mcp_servers.extra",
          value: JSON.parse('{"constructor":{"polluted":true}}'),
          mergeStrategy: "replace",
          expectedVersion: version,
        })
      ).toThrow();
      expect(store.read({ includeLayers: false }).config).toEqual(original);
      expect(store.version).toBe(version);
      expect(await readFile(filePath, "utf8")).toBe(raw);
      store.writeValue({
        keyPath: "model",
        value: "committed",
        mergeStrategy: "replace",
        expectedVersion: version,
      });
      expect(store.version).toBe(String(Number(version) + 1));
      expect(new InMemoryConfigStore(filePath).read({ includeLayers: false }).config.model).toBe(
        "committed"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves config and version unchanged when the disk write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-config-io-"));
    const filePath = join(directory, "config.toml");
    try {
      const store = new InMemoryConfigStore(filePath);
      const original = structuredClone(store.read({ includeLayers: false }).config);
      const version = store.version;
      // A regular file in place of the parent deterministically rejects writes,
      // including when tests run as root and chmod would not establish failure.
      await rm(directory, { recursive: true });
      await writeFile(directory, "not a directory");
      expect(() =>
        store.writeValue({ keyPath: "model", value: "uncommitted", mergeStrategy: "replace" })
      ).toThrow();
      expect(store.read({ includeLayers: false }).config).toEqual(original);
      expect(store.version).toBe(version);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists config values to disk across instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-config-store-"));
    const filePath = join(directory, "config.toml");

    try {
      const first = new InMemoryConfigStore(filePath);
      first.writeBatch({
        edits: [
          {
            keyPath: "model",
            value: "openai-codex/gpt-5.4",
            mergeStrategy: "upsert",
          },
          {
            keyPath: "model_reasoning_effort",
            value: "medium",
            mergeStrategy: "upsert",
          },
        ],
        filePath: null,
        expectedVersion: null,
      });

      const raw = await readFile(filePath, "utf8");
      expect(raw).toContain('model = "openai-codex/gpt-5.4"');
      expect(raw).toContain('model_reasoning_effort = "medium"');

      const second = new InMemoryConfigStore(filePath);
      expect(second.read({ includeLayers: false, cwd: null }).config).toMatchObject({
        model: "openai-codex/gpt-5.4",
        model_reasoning_effort: "medium",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
