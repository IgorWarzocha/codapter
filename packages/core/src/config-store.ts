import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { configKeyPath, parseConfigToml, stringifyConfigToml } from "./config-toml.js";
import type {
  Config,
  ConfigBatchWriteParams,
  ConfigEdit,
  ConfigLayer,
  ConfigLayerMetadata,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigValueWriteParams,
  ConfigWriteResponse,
  JsonValue,
  WriteStatus,
} from "./protocol.js";

function createDefaultConfig(): Config {
  return {
    model: null,
    review_model: null,
    model_context_window: null,
    model_auto_compact_token_limit: null,
    model_auto_compact_token_limit_scope: null,
    model_provider: null,
    approval_policy: null,
    approvals_reviewer: null,
    sandbox_mode: null,
    sandbox_workspace_write: null,
    forced_chatgpt_workspace_id: null,
    forced_login_method: null,
    web_search: null,
    tools: null,
    profile: null,
    profiles: {},
    instructions: null,
    developer_instructions: null,
    compact_prompt: null,
    model_reasoning_effort: null,
    model_reasoning_summary: null,
    model_verbosity: null,
    service_tier: null,
    analytics: null,
    browser_use: null,
    computer_use: null,
    desktop: null,
  };
}

function isJsonObject(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureContainer(root: { [key: string]: JsonValue | undefined }, key: string) {
  const current = root[key];
  if (isJsonObject(current)) {
    return current;
  }

  const next: { [key: string]: JsonValue | undefined } = {};
  root[key] = next;
  return next;
}

function applyEdit(config: Config, edit: ConfigEdit | ConfigValueWriteParams): void {
  const segments = configKeyPath(edit.keyPath);

  let cursor: { [key: string]: JsonValue | undefined } = config;
  for (const segment of segments.slice(0, -1)) {
    cursor = ensureContainer(cursor, segment);
  }

  const finalSegment = segments.at(-1);
  if (!finalSegment) {
    return;
  }

  if (edit.mergeStrategy === "upsert") {
    const current = cursor[finalSegment];
    if (isJsonObject(current) && isJsonObject(edit.value)) {
      cursor[finalSegment] = {
        ...current,
        ...structuredClone(edit.value),
      };
      return;
    }
  }

  cursor[finalSegment] = structuredClone(edit.value);
}

function loadConfigFromDisk(filePath: string): Config {
  const config = createDefaultConfig();
  if (!existsSync(filePath)) {
    return config;
  }

  return Object.assign(config, parseConfigToml(readFileSync(filePath, "utf8")));
}

export class InMemoryConfigStore {
  private readonly filePath: string;
  private versionCounter = 1;
  private config: Config;

  constructor(
    filePath = process.env.CODAPTER_CONFIG_FILE ??
      resolve(homedir(), ".config", "codapter", "config.toml")
  ) {
    this.filePath = filePath;
    this.config = loadConfigFromDisk(filePath);
  }

  read(params: ConfigReadParams): ConfigReadResponse {
    const layerMetadata: ConfigLayerMetadata = {
      name: { type: "user", file: this.filePath },
      version: this.version,
    };

    const layer: ConfigLayer = {
      name: layerMetadata.name,
      version: layerMetadata.version,
      config: this.config,
      disabledReason: null,
    };

    return {
      config: this.config,
      origins: {},
      layers: params.includeLayers ? [layer] : null,
    };
  }

  writeValue(params: ConfigValueWriteParams): ConfigWriteResponse {
    return this.writeBatch({ edits: [params], expectedVersion: params.expectedVersion });
  }

  writeBatch(params: ConfigBatchWriteParams): ConfigWriteResponse {
    this.assertVersion(params.expectedVersion ?? null);
    const candidate = structuredClone(this.config);
    for (const edit of params.edits) {
      applyEdit(candidate, edit);
    }
    this.persist(candidate);
    this.config = candidate;
    this.versionCounter += 1;
    return this.createWriteResponse("ok");
  }

  get version(): string {
    return String(this.versionCounter);
  }

  private assertVersion(expectedVersion: string | null): void {
    if (expectedVersion !== null && expectedVersion !== this.version) {
      throw new Error(`Config version mismatch: expected ${expectedVersion}, got ${this.version}`);
    }
  }

  private createWriteResponse(status: WriteStatus): ConfigWriteResponse {
    return {
      status,
      version: this.version,
      filePath: this.filePath,
      overriddenMetadata: null,
    };
  }

  private persist(config: Config): void {
    const contents = stringifyConfigToml(config);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, contents, { encoding: "utf8", mode: 0o600 });
  }
}
