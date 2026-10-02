import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryConfigStore } from "../src/config-store.js";
import { type ConfigObject, stringifyConfigToml } from "../src/config-toml.js";
import { DesktopPluginCatalog } from "../src/desktop-plugins.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function file(path: string, contents: string | ConfigObject) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codapter-plugin-catalog-"));
  directories.push(directory);
  const home = join(directory, "codex");
  const marketplace = join(directory, "bundled");
  const root = join(marketplace, "plugins", "browser");
  const skill = join(root, "skills", "control", "SKILL.md");
  await file(join(marketplace, ".agents", "plugins", "marketplace.json"), {
    name: "bundled",
    interface: { displayName: "Bundled" },
    plugins: [
      { name: "browser", source: { source: "local", path: "./plugins/browser" } },
      { name: "disabled", source: { source: "local", path: "./plugins/disabled" } },
    ],
  });
  await file(join(root, ".codex-plugin", "plugin.json"), {
    name: "browser",
    version: "2.0.0",
    description: "Current browser",
    skills: "./skills",
    apps: "./.app.json",
    interface: { displayName: "Browser", shortDescription: "Current browser" },
  });
  await file(
    skill,
    "---\nname: control-in-app-browser\ndescription: >-\n  Control the Browser\n  with signed-in tabs.\n---\n\nFULL_SELECTED_SKILL_BODY\n"
  );
  await file(join(root, ".app.json"), { apps: { documents: { id: "connector_documents" } } });
  await file(join(marketplace, "plugins", "disabled", ".codex-plugin", "plugin.json"), {
    name: "disabled",
    version: "1.0.0",
    skills: "skills",
  });
  await file(
    join(marketplace, "plugins", "disabled", "skills", "hidden", "SKILL.md"),
    "---\nname: hidden\ndescription: Disabled skill.\n---\nDISABLED_SKILL_BODY"
  );
  const native: ConfigObject = {
    model: "native-model-must-not-replace-pi",
    features: { apps: false },
    marketplaces: { bundled: { source_type: "local", source: marketplace } },
    plugins: { "browser@bundled": { enabled: true }, "disabled@bundled": { enabled: false } },
  };
  await file(join(home, "config.toml"), stringifyConfigToml(native));
  await file(join(home, "auth.json"), "AUTH_FILE_MUST_NOT_BE_READ");
  const configStore = new InMemoryConfigStore(join(directory, "adapter.toml"));
  const systemConfigFile = join(directory, "system.toml");
  const catalog = new DesktopPluginCatalog({ codexHome: home, configStore, systemConfigFile });
  return {
    directory,
    home,
    marketplace,
    root,
    skill,
    native,
    configStore,
    systemConfigFile,
    catalog,
  };
}

describe("DesktopPluginCatalog", () => {
  it("snapshots only effective Browser roots with native, CLI, adapter, and flat thread precedence", async () => {
    const f = await fixture();
    await file(
      join(f.home, "config.toml"),
      stringifyConfigToml({
        ...f.native,
        browser_use: {
          allow_history_access: false,
          default_origin_policy: { access: "deny", downloads: "deny" },
        },
        application: { network: { domains: { "native.example": "deny" } } },
      })
    );
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({
      config: {
        browser_use: {
          allow_history_access: false,
          default_origin_policy: { access: "deny", downloads: "deny" },
        },
        application: { network: { domains: { "native.example": "deny" } } },
      },
    });
    const catalog = new DesktopPluginCatalog({
      codexHome: f.home,
      configStore: f.configStore,
      systemConfigFile: f.systemConfigFile,
      overrides: [
        'browser_use.default_origin_policy.downloads="allow"',
        'application.network.domains."cli.example"="deny"',
        'model="NOT_A_PI_OVERRIDE"',
      ],
    });
    f.configStore.writeValue({
      keyPath: "browser_use.default_origin_policy.uploads",
      value: "deny",
      mergeStrategy: "replace",
    });
    const thread = {
      'browser_use.origins."https://thread.example".access': "deny",
      'application.network.domains."thread.example"': "deny",
    };
    const cap = await catalog.capabilities(f.directory, thread);
    expect(cap.browserConfig).toEqual({
      config: {
        browser_use: {
          allow_history_access: false,
          default_origin_policy: { access: "deny", downloads: "allow", uploads: "deny" },
          origins: { "https://thread.example": { access: "deny" } },
        },
        application: {
          network: {
            domains: { "native.example": "deny", "cli.example": "deny", "thread.example": "deny" },
          },
        },
      },
    });
    expect(JSON.stringify(cap.browserConfig)).not.toContain("NOT_A_PI_OVERRIDE");
    expect(JSON.stringify(cap.browserConfig)).not.toContain("AUTH_FILE_MUST_NOT_BE_READ");
    f.configStore.writeValue({
      keyPath: "browser_use.allow_history_access",
      value: true,
      mergeStrategy: "replace",
    });
    expect(cap.browserConfig).toMatchObject({
      config: { browser_use: { allow_history_access: false } },
    });
    expect((await catalog.capabilities(f.directory, thread)).browserConfig).toMatchObject({
      config: { browser_use: { allow_history_access: true } },
    });
    expect((await catalog.readConfig({ includeLayers: false })).config).toMatchObject({
      browser_use: {
        default_origin_policy: { access: "deny", downloads: "allow", uploads: "deny" },
      },
    });
  });

  it("fails Browser policy snapshots closed for unsupported system, selected profile, and ancestor project layers", async () => {
    const f = await fixture();
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({ config: {} });
    await file(
      f.systemConfigFile,
      stringifyConfigToml({ browser_use: { default_origin_policy: { access: "deny" } } })
    );
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({
      error: "Browser policy in native system configuration is unsupported",
    });
    await file(f.systemConfigFile, 'TOKEN="DO_NOT_EXPOSE" invalid');
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({
      error: "Native system configuration could not be verified for Browser policy",
    });
    await rm(f.systemConfigFile);
    await mkdir(f.systemConfigFile);
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({
      error: "Native system configuration could not be verified for Browser policy",
    });
    await rm(f.systemConfigFile, { recursive: true });
    await file(
      join(f.home, "policy.config.toml"),
      stringifyConfigToml({ application: { network: { domains: { "blocked.example": "deny" } } } })
    );
    expect(
      (await f.catalog.capabilities(f.directory, { profile: "policy" })).browserConfig
    ).toEqual({ error: "Browser policy in a selected native profile is unsupported" });
    expect(
      (await f.catalog.capabilities(f.directory, { profile: "missing" })).browserConfig
    ).toEqual({ error: "Selected native profile is unavailable for Browser policy" });
    expect(
      (
        await f.catalog.capabilities(f.directory, {
          profile: "flat",
          "profiles.flat.browser_use.default_origin_policy.access": "deny",
        })
      ).browserConfig
    ).toEqual({ error: "Browser policy in a selected native profile is unsupported" });
    await file(
      join(f.home, "config.toml"),
      stringifyConfigToml({
        ...f.native,
        profile: "legacy",
        profiles: {
          legacy: { browser_use: { default_origin_policy: { access: "deny" } } },
          dormant: { application: { network: {} } },
        },
      })
    );
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({
      error: "Browser policy in a selected native profile is unsupported",
    });
    await file(join(f.home, "config.toml"), stringifyConfigToml(f.native));
    await file(
      f.systemConfigFile,
      stringifyConfigToml({
        profile: "legacy",
        profiles: { legacy: { browser_use: { default_origin_policy: { access: "deny" } } } },
      })
    );
    expect((await f.catalog.capabilities(f.directory, null)).browserConfig).toEqual({
      error: "Browser policy in a selected native profile is unsupported",
    });
    await rm(f.systemConfigFile);
    const child = join(f.directory, "project", "nested");
    await mkdir(child, { recursive: true });
    await file(
      join(f.directory, "project", ".codex", "config.toml"),
      stringifyConfigToml({ application: { network: { domains: { "project.example": "deny" } } } })
    );
    expect((await f.catalog.capabilities(child, null)).browserConfig).toEqual({
      error: "Browser policy in native project configuration is unsupported",
    });
    await file(join(f.directory, "project", ".codex", "config.toml"), 'model = "unrelated-model"');
    expect((await f.catalog.capabilities(child, null)).browserConfig).toEqual({ config: {} });
  });

  it("honors ordered native skill enablement and rejects malformed plugin toggles", async () => {
    const f = await fixture();
    f.configStore.writeValue({
      keyPath: "skills.config",
      value: [
        { name: "control-in-app-browser", enabled: false },
        { path: f.skill, enabled: true },
      ],
      mergeStrategy: "replace",
    });
    expect((await f.catalog.capabilities(f.directory, null)).instructions.join("\n")).toContain(
      f.skill
    );
    f.configStore.writeValue({
      keyPath: "skills.config",
      value: [{ path: f.skill, enabled: false }],
      mergeStrategy: "replace",
    });
    expect((await f.catalog.capabilities(f.directory, null)).instructions.join("\n")).not.toContain(
      f.skill
    );
    expect(await f.catalog.skills({ cwds: [f.directory] })).toMatchObject({
      data: [
        {
          skills: [
            { name: "control-in-app-browser", enabled: false },
            { name: "hidden", enabled: false },
          ],
        },
      ],
    });
    await expect(
      f.catalog.expandInput([{ type: "skill", name: "Browser", path: f.skill }], f.directory)
    ).rejects.toThrow("Undeclared");
    f.configStore.writeValue({
      keyPath: 'plugins."browser@bundled".enabled',
      value: "false",
      mergeStrategy: "replace",
    });
    const capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.instructions.join("\n")).toContain("Invalid plugin enablement policy");
    await expect(
      f.catalog.expandInput(
        [{ type: "mention", name: "Browser", path: "plugin://browser@bundled" }],
        f.directory
      )
    ).rejects.toThrow("disabled");
  });

  it("normalizes manifest assets and rejects conflicting native authentication without leaking values", async () => {
    const f = await fixture();
    await file(join(f.root, ".codex-plugin", "plugin.json"), {
      name: "browser",
      interface: {
        displayName: "Browser",
        websiteURL: "https://example.com",
        composerIcon: "./assets/icon.png",
        screenshots: ["./assets/screen.png"],
      },
    });
    expect(await f.catalog.read({ pluginName: "browser" })).toMatchObject({
      plugin: {
        summary: {
          interface: {
            websiteUrl: "https://example.com",
            composerIcon: join(f.root, "assets", "icon.png"),
            screenshots: [join(f.root, "assets", "screen.png")],
          },
        },
      },
    });
    f.configStore.writeValue({
      keyPath: "mcp_servers.unsafe",
      value: {
        url: "https://example.com/mcp",
        auth: "chatgpt",
        http_headers: { authorization: "SECRET_NOT_IN_DIAGNOSTICS" },
      },
      mergeStrategy: "replace",
    });
    const capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.mcpServers).not.toHaveProperty("unsafe");
    expect(capabilities.instructions.join("\n")).toContain(
      "Conflicting MCP authentication sources"
    );
    expect(JSON.stringify(capabilities)).not.toContain("SECRET_NOT_IN_DIAGNOSTICS");
  });

  it("lists declared local packages, prefers current sources over stale cache and keeps skill inventory concise", async () => {
    const f = await fixture();
    const cached = join(f.home, "plugins", "cache", "bundled", "browser", "99.0.0");
    await file(join(cached, ".codex-plugin", "plugin.json"), {
      name: "browser",
      version: "99.0.0",
    });
    const listing = await f.catalog.list({ cwds: [f.directory] });
    expect(listing).toMatchObject({
      marketplaceLoadErrors: [],
      marketplaces: [
        {
          name: "bundled",
          plugins: [
            {
              id: "browser@bundled",
              installed: true,
              enabled: true,
              localVersion: "2.0.0",
              source: { type: "local", path: f.root },
            },
            { id: "disabled@bundled", installed: true, enabled: false },
          ],
        },
      ],
    });
    const installed = await f.catalog.installed({ cwds: [f.directory] });
    expect(installed.marketplaces).toEqual(listing.marketplaces);
    const detail = await f.catalog.read({
      pluginName: "browser",
      marketplacePath: join(f.marketplace, ".agents", "plugins", "marketplace.json"),
    });
    expect(detail).toMatchObject({
      plugin: {
        summary: { interface: { displayName: "Browser" } },
        skills: [
          {
            name: "control-in-app-browser",
            description: "Control the Browser with signed-in tabs.",
            path: f.skill,
            enabled: true,
          },
        ],
        apps: [{ id: "connector_documents" }],
      },
    });
    const capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.instructions.join("\n")).toContain(f.skill);
    expect(capabilities.instructions.join("\n")).not.toContain("FULL_SELECTED_SKILL_BODY");
    expect(capabilities.instructions.join("\n")).not.toContain("DISABLED_SKILL_BODY");
    expect(await f.catalog.skills({ cwds: [f.directory] })).toMatchObject({
      data: [
        {
          cwd: f.directory,
          skills: [
            { pluginId: "browser@bundled", scope: "plugin", enabled: true },
            { pluginId: "disabled@bundled", enabled: false },
          ],
        },
      ],
    });
  });

  it("merges native, CLI, adapter and thread config without replacing Pi defaults or writing native files", async () => {
    const f = await fixture();
    const nativeBefore = await readFile(join(f.home, "config.toml"), "utf8");
    const catalog = new DesktopPluginCatalog({
      codexHome: f.home,
      configStore: f.configStore,
      systemConfigFile: f.systemConfigFile,
      overrides: [
        'plugins."browser@bundled".enabled=false',
        "features.apps=true",
        'mcp_servers.cli.url="https://cli.example/mcp"',
        'model="ignored-native-model"',
      ],
    });
    expect((await catalog.capabilities(f.directory, null)).instructions.join("\n")).not.toContain(
      f.skill
    );
    f.configStore.writeValue({
      keyPath: 'plugins."browser@bundled".enabled',
      value: true,
      mergeStrategy: "replace",
    });
    expect((await catalog.capabilities(f.directory, null)).instructions.join("\n")).toContain(
      f.skill
    );
    const thread = {
      plugins: { "browser@bundled": { enabled: false } },
      mcp_servers: { cli: { enabled: false } },
    };
    const config = await catalog.config(f.directory, thread);
    expect(config).toMatchObject({
      plugins: { "browser@bundled": { enabled: false } },
      features: { apps: true },
    });
    expect(config).not.toHaveProperty("model");
    expect(f.configStore.read({ cwd: f.directory, includeLayers: false }).config.model).toBeNull();
    expect((await catalog.capabilities(f.directory, thread)).mcpServers).not.toHaveProperty("cli");
    expect(await readFile(join(f.home, "config.toml"), "utf8")).toBe(nativeBefore);
  });

  it("normalizes native GUI dotted thread overrides without flattening nested plugin IDs or unrelated config", async () => {
    const f = await fixture();
    const catalog = new DesktopPluginCatalog({
      codexHome: f.home,
      configStore: f.configStore,
      systemConfigFile: f.systemConfigFile,
      overrides: [
        'mcp_servers.node_repl.command="fallback-node"',
        'mcp_servers.node_repl.args=["fallback.mjs"]',
      ],
    });
    const thread: ConfigObject = {
      "features.apps": true,
      features: { apps: false, nested_feature: { enabled: true } },
      mcp_servers: { node_repl: { command: "nested-fallback", env: { SHARED: "nested" } } },
      "mcp_servers.node_repl": {
        command: "gui-node",
        args: ["--interactive", "/gui/runtime.mjs"],
        env: {
          NODE_REPL_NATIVE_MODULE_DIR: "/gui/modules",
          NODE_REPL_SERVER_ENTRY_PATH: "/gui/server.mjs",
        },
      },
      "mcp_servers.codex_app.env_vars": ["HOME", "PATH"],
      "apps.connector_openai_pages.tools": { delete_page: { enabled: false } },
      'plugins."browser@bundled".enabled': false,
      plugins: { "unknown.plugin@bundled": { enabled: false } },
      model: "native-gui-model-must-not-win",
      model_reasoning_effort: "high",
      unrelated: { nested: { flag: true } },
      "unrelated.invalid..path": true,
    };
    const original = structuredClone(thread);
    const normalized = await catalog.config(f.directory, thread);
    expect(normalized).toMatchObject({
      features: { apps: true, nested_feature: { enabled: true } },
      mcp_servers: {
        node_repl: {
          command: "gui-node",
          args: ["--interactive", "/gui/runtime.mjs"],
          env: {
            SHARED: "nested",
            NODE_REPL_NATIVE_MODULE_DIR: "/gui/modules",
            NODE_REPL_SERVER_ENTRY_PATH: "/gui/server.mjs",
          },
        },
        codex_app: { env_vars: ["HOME", "PATH"] },
      },
      apps: { connector_openai_pages: { tools: { delete_page: { enabled: false } } } },
      plugins: {
        "browser@bundled": { enabled: false },
        "unknown.plugin@bundled": { enabled: false },
      },
    });
    for (const key of [
      "features.apps",
      "mcp_servers.node_repl",
      "model",
      "model_reasoning_effort",
      "unrelated",
      "unrelated.invalid..path",
    ])
      expect(Object.hasOwn(normalized, key)).toBe(false);
    expect(thread).toEqual(original);
    const capabilities = await catalog.capabilities(f.directory, thread);
    expect(capabilities.mcpServers.node_repl).toMatchObject({
      command: "gui-node",
      args: ["--interactive", "/gui/runtime.mjs"],
      env: { NODE_REPL_NATIVE_MODULE_DIR: "/gui/modules" },
    });
    expect(capabilities.instructions.join("\n")).not.toContain(f.skill);
    await expect(
      catalog.expandInput(
        [{ type: "skill", name: "control-in-app-browser", path: f.skill }],
        f.directory,
        thread
      )
    ).rejects.toThrow("disabled");
    await expect(
      catalog.config(f.directory, { "mcp_servers.__proto__.enabled": true })
    ).rejects.toThrow("Invalid configuration key");
  });

  it("expands only selected enabled skills and rejects unknown, disabled and thread-disabled mentions", async () => {
    const f = await fixture();
    const text = { type: "text" as const, text: "Use the browser", text_elements: [] };
    const expanded = await f.catalog.expandInput(
      [text, { type: "mention", name: "Browser", path: "plugin://browser@bundled" }],
      f.directory
    );
    expect(expanded[0]).toEqual(text);
    expect(expanded[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("FULL_SELECTED_SKILL_BODY"),
      text_elements: [],
    });
    expect(expanded[1]).toMatchObject({ text: expect.stringContaining(f.skill) });
    const skillInput = [{ type: "skill" as const, name: "control-in-app-browser", path: f.skill }];
    expect(await f.catalog.expandInput(skillInput, f.directory)).toEqual([expanded[1]]);
    await expect(
      f.catalog.expandInput(skillInput, f.directory, {
        plugins: { "browser@bundled": { enabled: false } },
      })
    ).rejects.toThrow("disabled");
    for (const path of [
      "plugin://disabled@bundled",
      "plugin://unknown@bundled",
      join(f.home, "auth.json"),
    ]) {
      await expect(
        f.catalog.expandInput([{ type: "mention", name: "unsafe", path }], f.directory)
      ).rejects.toThrow("Unknown");
    }
  });

  it("rejects escaping declared paths and symlinks instead of exposing arbitrary files", async () => {
    const f = await fixture();
    await file(join(f.root, ".codex-plugin", "plugin.json"), {
      name: "browser",
      skills: "../../outside",
    });
    await file(
      join(f.marketplace, "outside", "SKILL.md"),
      "---\nname: outside\ndescription: Outside\n---\nSECRET"
    );
    expect((await f.catalog.capabilities(f.directory, null)).instructions.join("\n")).toContain(
      "escapes package root"
    );
    await file(join(f.root, ".codex-plugin", "plugin.json"), { name: "browser", skills: "skills" });
    await rm(f.skill);
    await symlink(join(f.marketplace, "outside", "SKILL.md"), f.skill);
    const capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.instructions.join("\n")).toContain("escapes package root");
    expect(capabilities.instructions.join("\n")).not.toContain("SECRET");
  });

  it("aligns only the native Browser cached service with its resolved source and rejects unavailable or escaping assets", async () => {
    const f = await fixture();
    await file(
      join(f.home, "config.toml"),
      stringifyConfigToml({
        ...f.native,
        marketplaces: { "openai-bundled": { source_type: "local", source: f.marketplace } },
        plugins: { "browser@openai-bundled": { enabled: true } },
      })
    );
    const service = join(f.root, "scripts", "browser-service.mjs");
    await file(service, "export const current = true;\n");
    const cached = join(
      f.home,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "26.928.31416",
      "scripts",
      "browser-service.mjs"
    );
    const codePaths = `${f.home}:/unrelated/node_modules`;
    const thread: ConfigObject = {
      "mcp_servers.node_repl": {
        command: "node",
        env: {
          NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
            browser: cached,
            unrelated: "/unrelated/service.mjs",
          }),
          NODE_REPL_TRUSTED_CODE_PATHS: codePaths,
          CODEX_CLI_PATH: "/gui/cli-tap",
          KEEP_LITERAL: "!must-not-execute",
          KEEP_DOLLARS: `\${DO_NOT_EXPAND}`,
        },
      },
    };
    const original = structuredClone(thread);
    const caps = await f.catalog.capabilities(f.directory, thread);
    expect(caps.mcpServers.node_repl).toMatchObject({
      env: {
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
          browser: service,
          unrelated: "/unrelated/service.mjs",
        }),
        NODE_REPL_TRUSTED_CODE_PATHS: codePaths,
        CODEX_CLI_PATH: "/gui/cli-tap",
        KEEP_LITERAL: "$!must-not-execute",
        KEEP_DOLLARS: `$\${DO_NOT_EXPAND}`,
      },
    });
    expect(thread).toEqual(original);
    await expect(readFile(cached)).rejects.toMatchObject({ code: "ENOENT" });
    const disabled = await f.catalog.capabilities(f.directory, thread, ["browser@openai-bundled"]);
    expect(disabled.mcpServers.node_repl).toMatchObject({
      env: {
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ unrelated: "/unrelated/service.mjs" }),
      },
    });
    expect(disabled.instructions.join("\n")).not.toContain(f.skill);
    await rm(service);
    const missing = await f.catalog.capabilities(f.directory, thread);
    expect(missing.mcpServers).not.toHaveProperty("node_repl");
    expect(missing.instructions.join("\n")).toContain("contained scripts/browser-service.mjs file");
    await file(join(f.directory, "outside.mjs"), "OUTSIDE_ASSET");
    await symlink(join(f.directory, "outside.mjs"), service);
    const escaping = await f.catalog.capabilities(f.directory, thread);
    expect(escaping.mcpServers).not.toHaveProperty("node_repl");
    expect(escaping.instructions.join("\n")).toContain(
      "contained scripts/browser-service.mjs file"
    );
    for (const browser of [
      "/explicit/custom-browser-service.mjs",
      join(
        f.home,
        "plugins",
        "cache",
        "other-marketplace",
        "browser",
        "1",
        "scripts",
        "browser-service.mjs"
      ),
    ]) {
      const env = { NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser }) };
      const unmodified = await f.catalog.capabilities(f.directory, {
        "mcp_servers.node_repl": { command: "node", env },
      });
      expect(unmodified.mcpServers.node_repl).toMatchObject({ env });
    }
  });

  it("translates MCP fields and fails closed for environment allowlists that Pi cannot enforce", async () => {
    const f = await fixture();
    vi.stubEnv("CODAPTER_ALLOWED_TEST", "allowed-secret");
    vi.stubEnv("CODAPTER_UNLISTED_TEST", "unlisted-secret");
    await file(join(f.root, ".mcp.json"), {
      mcpServers: {
        browser: {
          command: "./server",
          args: ["--stdio"],
          cwd: ".",
          env: { LITERAL: "!must-not-execute", DOLLAR: `\${MUST_NOT_EXPAND}` },
          startup_timeout_sec: 120,
          enabled_tools: ["read", "write"],
          disabled_tools: ["write"],
          omit_tools_from: ["code_mode"],
        },
        disabled: { enabled: false, command: "never-launch" },
        restricted: { command: "restricted", env_vars: ["CODAPTER_ALLOWED_TEST"] },
      },
    });
    const capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.mcpServers).toEqual({
      browser: {
        command: join(f.root, "server"),
        args: ["--stdio"],
        cwd: f.root,
        timeout: 120,
        exposure: "hidden",
        toolExposure: { read: "deferred", write: "hidden" },
        env: {
          LITERAL: "$!must-not-execute",
          DOLLAR: `$\${MUST_NOT_EXPAND}`,
        },
      },
    });
    expect(capabilities.instructions.join("\n")).toContain(
      "environment allowlist cannot be enforced"
    );
    expect(JSON.stringify(capabilities)).not.toContain("unlisted-secret");
    expect(JSON.stringify(capabilities)).not.toContain("allowed-secret");
  });

  it("refreshes MCP config and fails closed with explicit diagnostics for unsupported restrictive policies", async () => {
    const f = await fixture();
    await file(join(f.root, ".mcp.json"), {
      mcpServers: {
        shared: { command: "plugin-server" },
        gated: { command: "gated", default_tools_approval_mode: "prompt" },
      },
    });
    f.configStore.writeBatch({
      edits: [
        {
          keyPath: "mcp_servers.shared",
          value: {
            url: "https://native.example/mcp",
            http_headers: { "X-Test": "literal" },
            tool_timeout_sec: 10,
          },
          mergeStrategy: "replace",
        },
        {
          keyPath: "mcp_servers.remote",
          value: { command: "remote", env_vars: [{ name: "TOKEN", source: "remote" }] },
          mergeStrategy: "replace",
        },
        {
          keyPath: "mcp_servers.timeouts",
          value: { command: "timeouts", startup_timeout_sec: 120, tool_timeout_sec: 1 },
          mergeStrategy: "replace",
        },
      ],
    });
    let capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.mcpServers).toEqual({
      shared: {
        url: "https://native.example/mcp",
        headers: { "X-Test": "literal" },
        timeout: 10,
        exposure: "codemode",
      },
    });
    expect(capabilities.instructions.join("\n")).toContain("approval gate");
    expect(capabilities.instructions.join("\n")).toContain("Remote MCP environment");
    expect(capabilities.instructions.join("\n")).toContain("distinct startup and tool timeouts");
    f.configStore.writeValue({
      keyPath: "mcp_servers.shared.enabled",
      value: false,
      mergeStrategy: "replace",
    });
    capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.mcpServers).not.toHaveProperty("shared");
  });

  it("uses existing Pi ChatGPT provider auth for native apps and honors global and restrictive app gates", async () => {
    const f = await fixture();
    expect((await f.catalog.capabilities(f.directory, null)).mcpServers).not.toHaveProperty(
      "codex_apps"
    );
    f.configStore.writeValue({ keyPath: "features.apps", value: true, mergeStrategy: "replace" });
    expect((await f.catalog.capabilities(f.directory, null)).mcpServers.codex_apps).toEqual({
      url: "https://chatgpt.com/backend-api/ps/mcp",
      auth: { provider: "openai-codex" },
      headers: { "X-OpenAI-Product-Sku": "codex" },
      exposure: "codemode",
      _codapter: { disabledConnectors: [], disabledTools: {} },
    });
    f.configStore.writeValue({
      keyPath: 'apps."connector_documents".enabled',
      value: false,
      mergeStrategy: "replace",
    });
    const capabilities = await f.catalog.capabilities(f.directory, null);
    expect(capabilities.mcpServers.codex_apps).toMatchObject({
      _codapter: { disabledConnectors: ["connector_documents"] },
      auth: { provider: "openai-codex" },
    });
    expect(JSON.stringify(capabilities)).not.toContain("AUTH_FILE_MUST_NOT_BE_READ");
    f.configStore.writeValue({
      keyPath: "mcp_servers.codex_apps",
      value: { url: "https://chatgpt.com/backend-api/ps/mcp" },
      mergeStrategy: "replace",
    });
    expect((await f.catalog.capabilities(f.directory, null)).mcpServers.codex_apps).toMatchObject({
      auth: { provider: "openai-codex" },
      headers: { "X-OpenAI-Product-Sku": "codex" },
      _codapter: { disabledConnectors: ["connector_documents"] },
    });
    f.configStore.writeValue({
      keyPath: "mcp_servers.codex_apps.url",
      value: "https://untrusted.example/mcp",
      mergeStrategy: "replace",
    });
    const wrongEndpoint = await f.catalog.capabilities(f.directory, null);
    expect(wrongEndpoint.mcpServers).not.toHaveProperty("codex_apps");
    expect(wrongEndpoint.instructions.join("\n")).toContain("canonical ChatGPT apps MCP endpoint");
    f.configStore.writeValue({
      keyPath: "apps._default.enabled",
      value: false,
      mergeStrategy: "replace",
    });
    const gated = await f.catalog.capabilities(f.directory, null);
    expect(gated.mcpServers).not.toHaveProperty("codex_apps");
    expect(gated.instructions.join("\n")).toContain(
      "exceed the supported connector denylist policy"
    );
  });

  it("emits exact per-connector tool denials and fails closed when deny-only relay semantics are insufficient", async () => {
    const f = await fixture();
    const thread: ConfigObject = {
      "features.apps": true,
      "apps.connector_openai_pages.tools": {
        mcp__codex_apps__delete_page: { enabled: false },
        "Delete page": { enabled: false },
        " literal whitespace ": { enabled: false },
        "wild*literal": { enabled: false },
      },
      'apps." connector_documents ".tools': { read_file: { enabled: false } },
    };
    // Connector IDs are normalized, while tool keys remain exact native policy
    // keys, including namespaces, punctuation, whitespace, and literal stars.
    const marker = {
      disabledConnectors: [],
      disabledTools: {
        connector_documents: ["read_file"],
        connector_openai_pages: [
          " literal whitespace ",
          "Delete page",
          "mcp__codex_apps__delete_page",
          "wild*literal",
        ],
      },
    };
    expect((await f.catalog.capabilities(f.directory, thread)).mcpServers.codex_apps).toMatchObject(
      { _codapter: marker }
    );
    for (const tools of [
      { raw_name: { enabled: true }, Title: { enabled: false } },
      { raw_name: {}, Title: { enabled: false } },
      { raw_name: { approval_mode: "approve" }, Title: { enabled: false } },
      { raw_name: { enabled: false, approval_mode: "prompt" } },
      [{ tool_name: "raw_name", enabled: false }],
    ]) {
      const gated = await f.catalog.capabilities(f.directory, {
        "features.apps": true,
        "apps.connector_openai_pages.tools": tools,
      });
      expect(gated.mcpServers).not.toHaveProperty("codex_apps");
      expect(gated.instructions.join("\n")).toContain("exact tool denials");
    }
    for (const policy of [
      { default_tools_enabled: false },
      { destructive_enabled: false },
      { open_world_enabled: false },
      { default_tools_approval_mode: "prompt" },
      { links: { account: { default_tools_approval_mode: "prompt" } } },
    ]) {
      const gated = await f.catalog.capabilities(f.directory, {
        "features.apps": true,
        apps: { connector_openai_pages: policy },
      });
      expect(gated.mcpServers).not.toHaveProperty("codex_apps");
      expect(gated.instructions.join("\n")).toContain("exact tool denials");
    }
    f.configStore.writeValue({
      keyPath: "mcp_servers.codex_apps",
      value: { url: "https://chatgpt.com/backend-api/ps/mcp" },
      mergeStrategy: "replace",
    });
    expect((await f.catalog.capabilities(f.directory, thread)).mcpServers.codex_apps).toMatchObject(
      { _codapter: marker, auth: { provider: "openai-codex" } }
    );
    f.configStore.writeValue({
      keyPath: "mcp_servers.codex_apps.url",
      value: "https://untrusted.example/mcp",
      mergeStrategy: "replace",
    });
    const gated = await f.catalog.capabilities(f.directory, thread);
    expect(gated.mcpServers).not.toHaveProperty("codex_apps");
    expect(gated.instructions.join("\n")).toContain("canonical ChatGPT apps MCP endpoint");
  });

  it("does not replace a missing declared current source with an old cached package", async () => {
    const f = await fixture();
    await file(
      join(
        f.home,
        "plugins",
        "cache",
        "bundled",
        "browser",
        "99.0.0",
        ".codex-plugin",
        "plugin.json"
      ),
      { name: "browser", version: "99.0.0" }
    );
    await rm(f.root, { recursive: true });
    const listing = await f.catalog.list();
    expect(listing).toMatchObject({
      marketplaces: [
        {
          plugins: expect.arrayContaining([
            expect.objectContaining({ id: "browser@bundled", installed: false }),
          ]),
        },
      ],
      marketplaceLoadErrors: [{ message: expect.stringContaining("not materialized") }],
    });
    await expect(
      f.catalog.expandInput(
        [{ type: "mention", name: "Browser", path: "plugin://browser@bundled" }],
        f.directory
      )
    ).rejects.toThrow("unavailable");
  });
});
