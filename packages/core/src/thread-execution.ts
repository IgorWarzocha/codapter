import { parseBackendModelId } from "./backend.js";
import type { BackendRouter, RoutedBackendSelection } from "./backend-router.js";
import type { InMemoryConfigStore } from "./config-store.js";
import type {
  ConfigReadResponse,
  JsonValue,
  SandboxMode,
  SandboxPolicy,
  Thread,
  ThreadStartResponse,
} from "./protocol.js";

export const DEFAULT_APPROVAL_POLICY = "never";
export const DEFAULT_APPROVALS_REVIEWER = "user";
const DEFAULT_SANDBOX_MODE: SandboxMode = "workspace-write";
export interface ThreadExecutionContext {
  readonly cwd: string;
  readonly model: string | null;
  readonly approvalPolicy: string | null;
  readonly approvalsReviewer: string | null;
  readonly sandbox: SandboxMode | null;
  readonly sandboxPolicy: JsonValue | null;
  readonly config: { [key: string]: JsonValue | undefined } | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly serviceName: string | null;
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  readonly personality: string | null;
  readonly summary: string | null;
  readonly collaborationMode: JsonValue | null;
}

function readStringRecordValue(record: unknown, key: string): string | null {
  if (typeof record !== "object" || record === null) {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
function resolveCollaborationModeSetting(
  collaborationMode: JsonValue | null | undefined,
  key: string
): string | null {
  if (typeof collaborationMode !== "object" || collaborationMode === null) {
    return null;
  }
  const settings = (collaborationMode as Record<string, unknown>).settings;
  return readStringRecordValue(settings, key);
}
export function rewriteCollaborationModeSettings(
  collaborationMode: JsonValue | null,
  options: {
    model: string | null;
    reasoningEffort: string | null;
  }
): JsonValue | null {
  if (typeof collaborationMode !== "object" || collaborationMode === null) {
    return collaborationMode;
  }

  const mode = collaborationMode as Record<string, JsonValue | undefined>;
  const settings: Record<string, JsonValue | undefined> = isRecord(mode.settings)
    ? { ...(mode.settings as Record<string, JsonValue | undefined>) }
    : {};

  if (options.model) {
    settings.model = options.model;
  } else {
    settings.model = undefined;
  }

  if (options.reasoningEffort) {
    settings.reasoning_effort = options.reasoningEffort;
  } else {
    settings.reasoning_effort = undefined;
  }

  return {
    ...mode,
    settings,
  };
}
export function buildSandboxPolicy(
  mode: SandboxMode | null | undefined,
  cwd: string
): SandboxPolicy {
  switch (mode ?? DEFAULT_SANDBOX_MODE) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return {
        type: "readOnly",
        access: { type: "fullAccess" },
        networkAccess: false,
      };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ThreadExecutionSettings {
  private readonly threadExecutionContexts = new Map<string, ThreadExecutionContext>();
  constructor(
    private readonly backendRouter: BackendRouter,
    private readonly configStore: InMemoryConfigStore
  ) {}

  forget(threadId: string): void {
    this.threadExecutionContexts.delete(threadId);
  }
  clear(): void {
    this.threadExecutionContexts.clear();
  }
  private readEffectiveConfig(cwd: string | null): ConfigReadResponse["config"] {
    return this.configStore.read({ includeLayers: false, cwd }).config;
  }

  resolveRequestedModel(
    cwd: string | null,
    requestedModel: string | null | undefined,
    collaborationMode?: JsonValue | null,
    persistedModel?: string | null
  ): string | null {
    const model =
      requestedModel ??
      resolveCollaborationModeSetting(collaborationMode, "model") ??
      persistedModel ??
      this.readEffectiveConfig(cwd).model;
    return this.backendRouter.canonicalizeModelSelection(model);
  }

  coerceModelToRequestedProvider(
    model: string | null,
    modelProvider: string | null | undefined,
    explicitlyRequestedModel: string | null | undefined
  ): string | null {
    if (!model) {
      return model;
    }
    if (!explicitlyRequestedModel && !this.backendRouter.parseModelSelection(model)) {
      return null;
    }
    if (explicitlyRequestedModel || !modelProvider) {
      return model;
    }
    const parsed = this.backendRouter.parseModelSelection(model);
    if (!parsed || parsed.selection.backendType !== modelProvider) {
      return null;
    }
    return model;
  }

  resolveRequestedReasoningEffort(
    cwd: string | null,
    requestedEffort: string | null | undefined,
    collaborationMode?: JsonValue | null,
    persistedEffort?: string | null
  ): string | null {
    return (
      requestedEffort ??
      resolveCollaborationModeSetting(collaborationMode, "reasoning_effort") ??
      persistedEffort ??
      this.readEffectiveConfig(cwd).model_reasoning_effort
    );
  }

  recordThreadExecutionContext(threadId: string, context: ThreadExecutionContext): void {
    this.threadExecutionContexts.set(threadId, structuredClone(context));
  }

  cloneThreadExecutionContext(threadId: string): ThreadExecutionContext | null {
    const context = this.threadExecutionContexts.get(threadId);
    return context ? structuredClone(context) : null;
  }

  async buildThreadExecutionResponse(
    thread: Thread,
    persistedModel: string | null,
    persistedReasoningEffort: string | null,
    requestedModel: string | null,
    requestedCwd: string | null,
    requestedApprovalPolicy: string | null,
    requestedApprovalsReviewer: string | null,
    requestedSandboxMode: SandboxMode | null,
    requestedReasoningEffort: string | null
  ): Promise<ThreadStartResponse> {
    const models = await this.backendRouter.listModels();
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    const cwd = requestedCwd ?? thread.cwd;

    return {
      thread,
      model: requestedModel ?? persistedModel ?? defaultModel?.model ?? "unknown::default",
      modelProvider: thread.modelProvider,
      serviceTier: this.threadExecutionContexts.get(thread.id)?.serviceTier ?? null,
      disabledPluginIds: [],
      instructionSources: [],
      cwd,
      approvalPolicy: requestedApprovalPolicy ?? DEFAULT_APPROVAL_POLICY,
      approvalsReviewer: requestedApprovalsReviewer ?? DEFAULT_APPROVALS_REVIEWER,
      sandbox: buildSandboxPolicy(requestedSandboxMode, cwd),
      reasoningEffort:
        requestedReasoningEffort ??
        persistedReasoningEffort ??
        defaultModel?.defaultReasoningEffort ??
        null,
    };
  }

  async resolveThreadStartSelection(
    model: string | null,
    modelProvider: string | null | undefined,
    ephemeral: boolean
  ): Promise<RoutedBackendSelection> {
    try {
      return await this.backendRouter.resolveModelSelection(model, modelProvider);
    } catch (error) {
      if (!ephemeral || !model || parseBackendModelId(model)) {
        throw error;
      }
      const codexBackend = this.backendRouter.getBackend("codex");
      if (!codexBackend?.isAlive()) {
        throw error;
      }
      return {
        backend: codexBackend,
        selection: {
          backendType: codexBackend.backendType,
          rawModelId: model,
        },
      };
    }
  }
}
