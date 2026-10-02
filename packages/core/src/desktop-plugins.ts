import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InMemoryConfigStore } from "./config-store.js";
import {
  type ConfigObject,
  configObject,
  configOverridesForRoots,
  mergeConfigObjects,
  parseConfigOverride,
  parseConfigToml,
} from "./config-toml.js";
import { browserConfigSnapshot } from "./desktop-browser-policy.js";
import type { DesktopSessionCapabilities } from "./desktop-capabilities.js";
import {
  cachedPluginRoot,
  type DesktopPluginPackage,
  declaredPath,
  jsonObjectFile,
  loadPluginPackage,
  optionalText,
  pluginSegment,
} from "./desktop-plugin-files.js";
import { implicitChatGptMcp, translateDesktopMcpServer } from "./desktop-plugin-mcp.js";
import { adaptNodeReplBrowserService } from "./desktop-plugin-node-repl.js";
import type {
  ConfigLayer,
  ConfigReadParams,
  ConfigReadResponse,
  JsonValue,
  PluginInstalledParams,
  PluginInstalledResponse,
  PluginListParams,
  PluginListResponse,
  PluginReadParams,
  SkillsListParams,
  SkillsListResponse,
  UserInput,
} from "./protocol.js";

export interface DesktopPluginCatalogOptions {
  readonly codexHome: string;
  readonly configStore: InMemoryConfigStore;
  readonly overrides?: readonly string[];
  /** Defaults to the canonical native system config path. */
  readonly systemConfigFile?: string;
}

export type DesktopPluginReadParams = PluginReadParams;

interface CatalogPlugin {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly marketplacePath: string;
  readonly declared: ConfigObject;
  readonly policy: ConfigObject;
  readonly enabled: boolean;
  readonly package: DesktopPluginPackage | null;
}

interface CatalogConfiguration {
  readonly config: ConfigObject;
  readonly profile: JsonValue | undefined;
  readonly profiles: ConfigObject | null;
}

interface CatalogSnapshot extends CatalogConfiguration {
  readonly marketplaces: JsonValue[];
  readonly plugins: CatalogPlugin[];
  readonly errors: { marketplacePath: string; message: string }[];
}

const CONFIG_KEYS = [
  "plugins",
  "marketplaces",
  "mcp_servers",
  "apps",
  "features",
  "skills",
  "apps_mcp_product_sku",
  "browser_use",
  "application",
];

function desktopConfig(value: ConfigObject): ConfigObject {
  return Object.fromEntries(
    CONFIG_KEYS.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]]))
  );
}

function adapterDesktopConfig(value: ConfigObject): ConfigObject {
  const selected = desktopConfig(value);
  // The adapter's default null is absence, not a user override that clears a
  // native Browser policy. TOML cannot persist an explicit null object field.
  if (selected.browser_use === null) delete selected.browser_use;
  return selected;
}

function desktopThreadConfig(value: ConfigObject): ConfigObject {
  return configOverridesForRoots(value, CONFIG_KEYS);
}

function recordAt(value: unknown): ConfigObject {
  return configObject(value) ? value : {};
}

function skillEnabled(config: ConfigObject, name: string, path: string): boolean {
  const rules = recordAt(config.skills).config;
  if (rules === undefined) return true;
  if (!Array.isArray(rules)) throw new Error("Invalid GUI skill enablement rules");
  let enabled = true;
  for (const rule of rules) {
    if (
      !configObject(rule) ||
      typeof rule.enabled !== "boolean" ||
      (rule.path === undefined && rule.name === undefined)
    )
      throw new Error("Invalid GUI skill enablement rule");
    if (rule.name === name || rule.path === path) enabled = rule.enabled;
  }
  return enabled;
}

function interfaceFields(value: unknown, root?: string): ConfigObject | null {
  if (!configObject(value)) return null;
  const result: ConfigObject = {};
  for (const key of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "websiteUrl",
    "privacyPolicyUrl",
    "termsOfServiceUrl",
    "brandColor",
    "composerIcon",
    "composerIconUrl",
    "logo",
    "logoDark",
    "logoUrl",
    "logoUrlDark",
  ])
    result[key] = typeof value[key] === "string" ? value[key] : null;
  for (const key of ["capabilities", "screenshots", "screenshotUrls"])
    result[key] = Array.isArray(value[key]) ? value[key] : [];
  result.defaultPrompt = Array.isArray(value.defaultPrompt) ? value.defaultPrompt : null;
  for (const key of ["website", "privacyPolicy", "termsOfService"]) {
    if (typeof value[`${key}URL`] === "string") result[`${key}Url`] = value[`${key}URL`];
  }
  const asset = (path: string): string => {
    if (!root) return path;
    const absolute = resolve(root, path);
    const offset = relative(root, absolute);
    if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset))
      throw new Error("Plugin interface asset escapes package root");
    return absolute;
  };
  for (const key of ["composerIcon", "logo", "logoDark"])
    if (typeof result[key] === "string") result[key] = asset(result[key]);
  result.screenshots = Array.isArray(value.screenshots)
    ? value.screenshots.filter((path): path is string => typeof path === "string").map(asset)
    : [];
  return result;
}

function summary(plugin: CatalogPlugin): ConfigObject {
  const manifest = plugin.package?.manifest;
  const policy = recordAt(plugin.declared.policy);
  const declaredSource = recordAt(plugin.declared.source);
  let source: ConfigObject = plugin.package
    ? { type: "local", path: plugin.package.root }
    : { type: "remote" };
  if (declaredSource.source === "local" && typeof declaredSource.path === "string")
    source = {
      type: "local",
      path: resolve(plugin.marketplacePath, "../../..", declaredSource.path),
    };
  else if (declaredSource.source === "git" && typeof declaredSource.url === "string")
    source = {
      type: "git",
      url: declaredSource.url,
      path: declaredSource.path ?? null,
      refName: declaredSource.ref ?? null,
      sha: declaredSource.sha ?? null,
    };
  else if (declaredSource.source === "npm" && typeof declaredSource.package === "string")
    source = {
      type: "npm",
      package: declaredSource.package,
      version: declaredSource.version ?? null,
      registry: declaredSource.registry ?? null,
    };
  return {
    id: plugin.id,
    name: plugin.name,
    remotePluginId: null,
    version: manifest?.version ?? null,
    localVersion: manifest?.version ?? null,
    shareContext: null,
    source,
    installed: plugin.package !== null,
    installedAt: null,
    enabled: plugin.enabled,
    installPolicy: ["AVAILABLE", "NOT_AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(
      String(policy.installation)
    )
      ? policy.installation
      : "AVAILABLE",
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: policy.authentication === "ON_USE" ? "ON_USE" : "ON_INSTALL",
    availability: "AVAILABLE",
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: interfaceFields(
      manifest?.interface ?? plugin.declared.interface,
      plugin.package?.root
    ),
    keywords: Array.isArray(manifest?.keywords) ? manifest.keywords : [],
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Plugin could not be loaded";
}

export class DesktopPluginCatalog {
  private readonly codexHome: string;
  private readonly overrides: ConfigObject;
  private readonly profileOverrides: ConfigObject;
  private readonly configStore: InMemoryConfigStore;
  private readonly systemConfigFile: string | undefined;

  constructor(options: DesktopPluginCatalogOptions) {
    this.codexHome = resolve(options.codexHome);
    this.configStore = options.configStore;
    this.systemConfigFile = options.systemConfigFile;
    const overrides = (options.overrides ?? []).reduce<ConfigObject>(
      (config, override) => mergeConfigObjects(config, parseConfigOverride(override)),
      {}
    );
    this.overrides = desktopConfig(overrides);
    this.profileOverrides = { profile: overrides.profile, profiles: overrides.profiles };
  }

  private async nativeConfig(): Promise<ConfigObject> {
    const text = await optionalText(join(this.codexHome, "config.toml"));
    try {
      return text === null ? {} : parseConfigToml(text);
    } catch {
      throw new Error("Invalid native desktop plugin configuration");
    }
  }

  async config(
    cwd = process.cwd(),
    threadConfig: ConfigObject | null = null
  ): Promise<ConfigObject> {
    return (await this.resolvedConfig(cwd, threadConfig)).config;
  }

  private async resolvedConfig(
    cwd: string,
    threadConfig: ConfigObject | null
  ): Promise<CatalogConfiguration> {
    const native = await this.nativeConfig();
    const adapter = this.configStore.read({ cwd, includeLayers: false }).config;
    const thread = threadConfig ?? {};
    const threadProfiles = configOverridesForRoots(thread, ["profile", "profiles"]);
    const merged = mergeConfigObjects(
      mergeConfigObjects(
        mergeConfigObjects(desktopConfig(native), this.overrides),
        adapterDesktopConfig(adapter)
      ),
      desktopThreadConfig(thread)
    );
    for (const key of CONFIG_KEYS.filter((key) => key !== "apps_mcp_product_sku")) {
      if (merged[key] !== undefined && merged[key] !== null && !configObject(merged[key]))
        throw new Error(`Invalid desktop configuration table: ${key}`);
    }
    const profile =
      threadProfiles.profile ?? adapter.profile ?? this.profileOverrides.profile ?? native.profile;
    let profiles: ConfigObject | null = {};
    for (const layer of [native, this.profileOverrides, adapter, threadProfiles]) {
      if (layer.profiles === undefined) continue;
      if (!configObject(layer.profiles)) {
        profiles = null;
        break;
      }
      profiles = mergeConfigObjects(profiles, layer.profiles);
    }
    return { config: merged, profile, profiles };
  }

  async readConfig(params: ConfigReadParams): Promise<ConfigReadResponse> {
    const base = this.configStore.read({ ...params, includeLayers: true });
    const native = desktopConfig(await this.nativeConfig());
    const overlay = mergeConfigObjects(
      mergeConfigObjects(native, this.overrides),
      adapterDesktopConfig(base.config)
    );
    const layer = (name: ConfigLayer["name"], config: ConfigObject): ConfigLayer => ({
      name,
      config,
      version: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
      disabledReason: null,
    });
    const nativeLayer = layer({ type: "user", file: join(this.codexHome, "config.toml") }, native);
    const cliLayer = layer({ type: "sessionFlags" }, this.overrides);
    const origins = { ...base.origins };
    for (const source of [nativeLayer, cliLayer]) {
      for (const key of Object.keys(recordAt(source.config))) {
        origins[key] = { name: source.name, version: source.version };
      }
    }
    const adapterLayer = base.layers?.[0];
    if (adapterLayer) {
      for (const key of Object.keys(adapterDesktopConfig(base.config)))
        origins[key] = { name: adapterLayer.name, version: adapterLayer.version };
    }
    return {
      config: { ...base.config, ...overlay },
      origins,
      layers: params.includeLayers ? [nativeLayer, cliLayer, ...(base.layers ?? [])] : null,
    };
  }

  private async snapshot(
    cwd: string,
    threadConfig: ConfigObject | null = null,
    disabledPluginIds: readonly string[] = []
  ): Promise<CatalogSnapshot> {
    const resolved = await this.resolvedConfig(cwd, threadConfig);
    const { config } = resolved;
    const plugins: CatalogPlugin[] = [];
    const marketplaces: JsonValue[] = [];
    const errors: CatalogSnapshot["errors"] = [];
    const configured = recordAt(config.plugins);
    const sources = recordAt(config.marketplaces);
    const marketplaceNames = new Set(Object.keys(sources));
    for (const id of Object.keys(configured)) {
      const split = id.lastIndexOf("@");
      if (split > 0) marketplaceNames.add(id.slice(split + 1));
      else
        errors.push({
          marketplacePath: this.codexHome,
          message: `Invalid configured plugin ID: ${id}`,
        });
    }
    for (const name of [...marketplaceNames].sort()) {
      let path = this.codexHome;
      const entries: CatalogPlugin[] = [];
      let marketplaceInterface: ConfigObject | null = null;
      try {
        pluginSegment(name);
        const source = recordAt(sources[name]);
        path =
          source.source_type === "local" && typeof source.source === "string"
            ? resolve(cwd, source.source)
            : join(this.codexHome, ".tmp", "marketplaces", name);
        const file = path.endsWith("marketplace.json")
          ? path
          : join(path, ".agents", "plugins", "marketplace.json");
        const marketplace = await jsonObjectFile(file);
        const root = path.endsWith("marketplace.json") ? resolve(path, "../../..") : path;
        if (!marketplace)
          errors.push({
            marketplacePath: file,
            message: `Configured marketplace is not materialized: ${name}`,
          });
        else {
          if (!Array.isArray(marketplace.plugins))
            throw new Error(`Invalid marketplace plugin inventory: ${file}`);
          marketplaceInterface = configObject(marketplace.interface)
            ? { displayName: marketplace.interface.displayName ?? null }
            : null;
        }
        const declarations = new Map<string, ConfigObject>();
        for (const declaration of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
          if (!configObject(declaration) || typeof declaration.name !== "string")
            throw new Error(`Invalid marketplace plugin declaration: ${file}`);
          pluginSegment(declaration.name);
          if (declarations.has(declaration.name))
            throw new Error(`Duplicate marketplace plugin: ${declaration.name}`);
          declarations.set(declaration.name, declaration);
        }
        for (const id of Object.keys(configured)) {
          if (id.endsWith(`@${name}`)) {
            const pluginName = pluginSegment(id.slice(0, -(name.length + 1)));
            if (!declarations.has(pluginName)) declarations.set(pluginName, { name: pluginName });
          }
        }
        for (const [pluginName, declared] of declarations) {
          const id = `${pluginName}@${name}`;
          const policy = recordAt(configured[id]);
          const validPolicy =
            configObject(configured[id]) &&
            (policy.enabled === undefined || typeof policy.enabled === "boolean");
          const enabled =
            validPolicy && policy.enabled !== false && !disabledPluginIds.includes(id);
          if (configured[id] !== undefined && !validPolicy)
            errors.push({
              marketplacePath: file,
              message: `Invalid plugin enablement policy: ${id}`,
            });
          let loaded: DesktopPluginPackage | null = null;
          try {
            const declaredSource = recordAt(declared.source);
            if (declaredSource.source === "local" && typeof declaredSource.path === "string") {
              loaded = await loadPluginPackage(resolve(root, declaredSource.path), id);
              if (!loaded) throw new Error(`Declared plugin source is not materialized: ${id}`);
            } else {
              const cached = await cachedPluginRoot(this.codexHome, name, pluginName);
              if (cached) loaded = await loadPluginPackage(cached, id);
              if (!loaded && enabled) throw new Error(`Enabled plugin is not materialized: ${id}`);
            }
          } catch (error) {
            errors.push({ marketplacePath: file, message: message(error) });
          }
          const plugin: CatalogPlugin = {
            id,
            name: pluginName,
            marketplace: name,
            marketplacePath: file,
            declared,
            policy,
            enabled,
            package: loaded,
          };
          entries.push(plugin);
          plugins.push(plugin);
        }
      } catch (error) {
        errors.push({ marketplacePath: path, message: message(error) });
      }
      marketplaces.push({
        name,
        path: path.endsWith("marketplace.json")
          ? path
          : join(path, ".agents", "plugins", "marketplace.json"),
        interface: marketplaceInterface,
        plugins: entries.map(summary),
      });
    }
    return { ...resolved, marketplaces, plugins, errors };
  }

  async list(params: PluginListParams = {}): Promise<PluginListResponse> {
    const snapshot = await this.snapshot(params.cwds?.[0] ?? process.cwd());
    return {
      marketplaces: snapshot.marketplaces,
      marketplaceLoadErrors: snapshot.errors,
      featuredPluginIds: [],
      remoteSyncError: null,
    };
  }

  async installed(params: PluginInstalledParams = {}): Promise<PluginInstalledResponse> {
    const response = await this.list({ cwds: params.cwds });
    return {
      marketplaceLoadErrors: response.marketplaceLoadErrors,
      marketplaces: response.marketplaces.map((marketplace) => {
        if (!configObject(marketplace) || !Array.isArray(marketplace.plugins)) return marketplace;
        return {
          ...marketplace,
          plugins: marketplace.plugins.filter(
            (plugin) =>
              configObject(plugin) &&
              (plugin.installed === true ||
                (typeof plugin.name === "string" &&
                  params.installSuggestionPluginNames?.includes(plugin.name)))
          ),
        };
      }),
    };
  }

  async read(params: DesktopPluginReadParams): Promise<{ plugin: JsonValue }> {
    const snapshot = await this.snapshot(process.cwd());
    const plugin = snapshot.plugins.find(
      (entry) =>
        entry.name === params.pluginName &&
        (params.remoteMarketplaceName === undefined ||
          params.remoteMarketplaceName === null ||
          entry.marketplace === params.remoteMarketplaceName) &&
        (params.marketplacePath === undefined ||
          params.marketplacePath === null ||
          entry.marketplacePath === resolve(params.marketplacePath))
    );
    if (!plugin) throw new Error(`Unknown configured plugin: ${params.pluginName}`);
    const loaded = plugin.package;
    return {
      plugin: {
        marketplaceName: plugin.marketplace,
        marketplacePath: plugin.marketplacePath,
        summary: summary(plugin),
        shareUrl: null,
        description:
          typeof loaded?.manifest.description === "string" ? loaded.manifest.description : null,
        skills:
          loaded?.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            shortDescription: null,
            interface: null,
            path: skill.path,
            enabled: plugin.enabled && skillEnabled(snapshot.config, skill.name, skill.path),
          })) ?? [],
        onboardingSkill: null,
        hooks: [],
        apps: plugin.enabled
          ? (loaded?.apps ?? [])
              .filter(
                (app) =>
                  (recordAt(recordAt(snapshot.config.apps)[String(app.id)]).enabled ??
                    recordAt(recordAt(snapshot.config.apps)._default).enabled) !== false
              )
              .map((app) => ({
                id: app.id ?? "",
                name: app.name ?? "",
                description: app.description ?? null,
                installUrl: app.installUrl ?? null,
                category: app.category ?? null,
              }))
          : [],
        appTemplates: [],
        mcpServers: plugin.enabled ? Object.keys(loaded?.mcpServers ?? {}) : [],
        scheduledTasks: null,
      },
    };
  }

  async skills(params: SkillsListParams = {}): Promise<SkillsListResponse> {
    const data: JsonValue[] = [];
    for (const cwd of params.cwds?.length ? params.cwds : [process.cwd()]) {
      const snapshot = await this.snapshot(cwd);
      data.push({
        cwd,
        skills: snapshot.plugins.flatMap(
          (plugin) =>
            plugin.package?.skills.map((skill) => ({
              ...skill,
              scope: "plugin",
              enabled: plugin.enabled && skillEnabled(snapshot.config, skill.name, skill.path),
            })) ?? []
        ),
        errors: snapshot.errors.map((error) => ({
          path: error.marketplacePath,
          message: error.message,
        })),
      });
    }
    return { data };
  }

  async capabilities(
    cwd: string,
    threadConfig: ConfigObject | null,
    disabledPluginIds: readonly string[] = []
  ): Promise<Pick<DesktopSessionCapabilities, "mcpServers" | "instructions" | "browserConfig">> {
    const snapshot = await this.snapshot(cwd, threadConfig, disabledPluginIds);
    const mcpServers: Record<string, JsonValue> = {};
    const conflicts = new Set<string>();
    const instructions: string[] = [];
    const diagnostics = snapshot.errors.map((error) => error.message);
    const browserConfig = await browserConfigSnapshot(snapshot.config, {
      codexHome: this.codexHome,
      cwd,
      systemConfigFile: this.systemConfigFile,
      profile: snapshot.profile,
      profiles: snapshot.profiles,
    });
    if (browserConfig.error) diagnostics.push(browserConfig.error);
    const apps = implicitChatGptMcp(snapshot.config);
    const browser = snapshot.plugins.find((plugin) => plugin.id === "browser@openai-bundled");
    const adapt = async (name: string, raw: unknown) =>
      name === "node_repl" && configObject(raw)
        ? adaptNodeReplBrowserService(
            raw,
            this.codexHome,
            browser && { enabled: browser.enabled, root: browser.package?.root ?? null }
          )
        : raw;
    for (const plugin of snapshot.plugins) {
      if (!plugin.enabled || !plugin.package) continue;
      for (const skill of plugin.package.skills)
        if (
          recordAt(snapshot.config.skills).include_instructions !== false &&
          skillEnabled(snapshot.config, skill.name, skill.path)
        )
          instructions.push(
            `GUI plugin ${plugin.id}: ${skill.name} - ${skill.description.replace(/\s+/g, " ")} (read ${skill.path}).`
          );
      for (const [name, server] of Object.entries(plugin.package.mcpServers)) {
        const overlay = recordAt(recordAt(plugin.policy.mcp_servers)[name]);
        const raw = configObject(server) ? mergeConfigObjects(server, overlay) : server;
        if (configObject(raw) && raw.enabled === false) continue;
        try {
          if (mcpServers[name] !== undefined || conflicts.has(name)) {
            conflicts.add(name);
            delete mcpServers[name];
            throw new Error(`Conflicting plugin MCP server: ${name}`);
          }
          mcpServers[name] = translateDesktopMcpServer(
            name,
            await adapt(name, raw),
            plugin.package.root
          );
        } catch (error) {
          diagnostics.push(`${plugin.id}/${name}: ${message(error)}`);
        }
      }
    }
    for (const [name, server] of Object.entries(recordAt(snapshot.config.mcp_servers))) {
      // Explicit native configuration takes precedence over plugin contributions.
      delete mcpServers[name];
      if (configObject(server) && server.enabled === false) continue;
      if (name === "codex_apps" && !apps.server) continue;
      try {
        const translated = translateDesktopMcpServer(name, await adapt(name, server), cwd);
        if (name === "codex_apps" && apps.server) {
          const marker = recordAt(apps.server._codapter);
          const disabled = marker.disabledConnectors;
          if (translated.url === apps.server.url) {
            translated._codapter = apps.server._codapter;
            translated.headers = {
              ...recordAt(apps.server.headers),
              ...recordAt(translated.headers),
            };
            if (
              translated.auth === undefined &&
              !Object.keys(recordAt(translated.headers)).some(
                (header) => header.toLowerCase() === "authorization"
              )
            )
              translated.auth = apps.server.auth;
          } else if (
            (Array.isArray(disabled) && disabled.length) ||
            Object.values(recordAt(marker.disabledTools)).some(
              (tools) => Array.isArray(tools) && tools.length
            )
          )
            throw new Error(
              "ChatGPT app filtering requires the canonical ChatGPT apps MCP endpoint"
            );
        }
        mcpServers[name] = translated;
      } catch (error) {
        diagnostics.push(`${name}: ${message(error)}`);
      }
    }
    if (
      apps.server &&
      mcpServers.codex_apps === undefined &&
      recordAt(snapshot.config.mcp_servers).codex_apps === undefined
    )
      mcpServers.codex_apps = apps.server;
    if (apps.diagnostic) diagnostics.push(apps.diagnostic);
    for (const diagnostic of [...new Set(diagnostics)])
      instructions.push(`GUI capability unavailable: ${diagnostic}`);
    return { mcpServers, instructions, browserConfig };
  }

  async expandInput(
    input: readonly UserInput[],
    cwd: string,
    threadConfig: ConfigObject | null = null,
    disabledPluginIds: readonly string[] = []
  ): Promise<UserInput[]> {
    if (!input.some((item) => item.type === "skill" || item.type === "mention")) return [...input];
    const snapshot = await this.snapshot(cwd, threadConfig, disabledPluginIds);
    const result: UserInput[] = [];
    for (const item of input) {
      if (item.type !== "skill" && item.type !== "mention") {
        result.push(item);
        continue;
      }
      let selected: CatalogPlugin | undefined;
      let skillPaths: readonly string[];
      if (item.type === "mention" && item.path.startsWith("plugin://")) {
        const id = item.path.slice("plugin://".length);
        selected = snapshot.plugins.find((plugin) => plugin.id === id);
        skillPaths =
          selected?.package?.skills
            .filter((skill) => skillEnabled(snapshot.config, skill.name, skill.path))
            .map((skill) => skill.path) ?? [];
      } else {
        const path = resolve(cwd, item.path);
        selected = snapshot.plugins.find((plugin) =>
          plugin.package?.skills.some((skill) => skill.path === path)
        );
        skillPaths = [path];
      }
      if (!selected?.enabled || !selected.package)
        throw new Error(`Unknown, disabled, or unavailable GUI plugin input: ${item.name}`);
      const contents: string[] = [];
      for (const path of skillPaths) {
        if (
          !selected.package.skills.some(
            (skill) => skill.path === path && skillEnabled(snapshot.config, skill.name, skill.path)
          )
        )
          throw new Error(`Undeclared GUI skill: ${item.name}`);
        const content = await optionalText(await declaredPath(selected.package.root, path));
        if (content === null) throw new Error(`GUI skill is no longer available: ${item.name}`);
        contents.push(`GUI plugin ${selected.id}, skill ${path}:\n${content}`);
      }
      if (!contents.length && typeof selected.package.manifest.description === "string")
        contents.push(selected.package.manifest.description);
      if (!contents.length) contents.push(`Selected GUI plugin ${selected.id}.`);
      result.push({ type: "text", text: contents.join("\n\n"), text_elements: [] });
    }
    return result;
  }
}
