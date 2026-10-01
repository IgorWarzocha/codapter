import { validateHeaderValue } from "node:http";
import { AccountSession, type StoredAuthState } from "./account-session.js";
import { type AppServerIdentity, createIdentity, resolveCodexHome } from "./app-server-identity.js";
import { DebugLogWriter } from "./app-server-log.js";
import type { IBackend } from "./backend.js";
import { BackendRouter } from "./backend-router.js";
import { BackendServerRequests } from "./backend-server-requests.js";
import { CommandExecManager } from "./command-exec.js";
import { InMemoryConfigStore } from "./config-store.js";
import {
  failure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcEnvelope,
  type JsonRpcMessage,
  type JsonRpcResponse,
  success,
} from "./jsonrpc.js";
import type {
  AppListResponse,
  CollaborationModeListResponse,
  CommandExecParams,
  CommandExecResizeParams,
  CommandExecTerminateParams,
  CommandExecWriteParams,
  ConfigBatchWriteParams,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  ConfigValueWriteParams,
  ConfigWriteResponse,
  ExperimentalFeatureListResponse,
  InitializeParams,
  InitializeResponse,
  McpServerStatusListResponse,
  ModelListParams,
  ModelListResponse,
  PluginListResponse,
  SkillsListResponse,
} from "./protocol.js";
import { ThreadExecutionSettings } from "./thread-execution.js";
import { ThreadRegistry, type ThreadRegistryLogger } from "./thread-registry.js";
import { ThreadSessions } from "./thread-sessions.js";

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const JSON_RPC_NOT_INITIALIZED = -32002;
const JSON_RPC_ALREADY_INITIALIZED = -32003;
export interface AppServerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

export type AppServerOutgoingMessage = JsonRpcEnvelope;

export interface AppServerConnectionOptions {
  readonly backend?: IBackend;
  readonly backendRouter?: BackendRouter;
  readonly collabEnabled?: boolean;
  readonly configStore?: InMemoryConfigStore;
  readonly initialAuthState?: StoredAuthState | null;
  readonly identity?: AppServerIdentity;
  readonly logger?: AppServerLogger;
  readonly debugLogFilePath?: string | null;
  readonly threadRegistry?: ThreadRegistry;
  readonly onMessage?: (message: AppServerOutgoingMessage) => void | Promise<void>;
}

interface ConnectionState {
  initialized: boolean;
  initializedNotificationReceived: boolean;
  clientInfo: InitializeParams["clientInfo"] | null;
  optedOutNotifications: Set<string>;
}

function defaultLogger(): AppServerLogger {
  return {
    warn(message, context) {
      if (context) {
        console.warn(message, context);
        return;
      }
      console.warn(message);
    },
  };
}

function truncateForLog(value: unknown, limit = 240): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "undefined";
  }
  if (serialized.length <= limit) {
    return serialized;
  }
  return `${serialized.slice(0, limit)}...`;
}

export class AppServerConnection {
  private readonly backendRouter: BackendRouter;
  private readonly configStore: InMemoryConfigStore;
  private readonly identity: AppServerIdentity;
  private readonly logger: AppServerLogger;
  private readonly debugLogWriter: DebugLogWriter | null;
  private readonly onMessage: AppServerConnectionOptions["onMessage"];
  private readonly commandExecManager: CommandExecManager;
  private readonly accountSession: AccountSession;
  private readonly threads: ThreadSessions;
  private readonly serverRequests: BackendServerRequests;
  private readonly state: ConnectionState = {
    initialized: false,
    initializedNotificationReceived: false,
    clientInfo: null,
    optedOutNotifications: new Set(),
  };
  constructor(options: AppServerConnectionOptions = {}) {
    this.backendRouter =
      options.backendRouter ??
      (options.backend ? new BackendRouter([options.backend]) : new BackendRouter());
    this.configStore = options.configStore ?? new InMemoryConfigStore();
    this.identity = options.identity ?? createIdentity();
    this.logger = options.logger ?? defaultLogger();
    const debugLogFilePath =
      options.debugLogFilePath ?? process.env.CODAPTER_DEBUG_LOG_FILE ?? null;
    this.debugLogWriter =
      debugLogFilePath && debugLogFilePath.length > 0
        ? new DebugLogWriter(debugLogFilePath, this.logger)
        : null;
    const threadRegistry =
      options.threadRegistry ?? new ThreadRegistry(undefined, this.logger as ThreadRegistryLogger);
    this.onMessage = options.onMessage;
    this.commandExecManager = new CommandExecManager({
      onNotification: async (notification) => {
        await this.publish(notification.method, notification.params);
      },
    });
    this.accountSession = new AccountSession(options.initialAuthState ?? null, (method, params) =>
      this.publish(method, params)
    );
    this.serverRequests = new BackendServerRequests(
      this.backendRouter,
      this.logger,
      (message) => this.send(message),
      (method, params, threadId) => this.publish(method, params, threadId)
    );
    this.threads = new ThreadSessions({
      backendRouter: this.backendRouter,
      threadRegistry,
      execution: new ThreadExecutionSettings(this.backendRouter, this.configStore),
      serverRequests: this.serverRequests,
      collabEnabled: Boolean(options.collabEnabled),
      logger: this.logger,
      debugLogWriter: this.debugLogWriter,
      publish: (method, params, threadId) => this.publish(method, params, threadId),
    });
    void this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "startup",
    });
  }

  async dispose(): Promise<void> {
    await this.threads.dispose();
    await this.commandExecManager.dispose();
    await this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "shutdown",
    });
    await this.debugLogWriter?.flush();
  }
  get collabSocketPath(): string | null {
    return this.threads.collabSocketPath;
  }
  async handleMessage(message: unknown): Promise<JsonRpcResponse | null> {
    if (isJsonRpcResponse(message)) {
      return this.serverRequests.resolve(message);
    }

    if (isJsonRpcNotification(message)) {
      return this.handleNotification(message);
    }

    if (!isJsonRpcRequest(message)) {
      return failure(null, JSON_RPC_INVALID_PARAMS, "Invalid JSON-RPC message");
    }

    const request = message;

    try {
      if (request.method === "initialize") {
        return this.handleInitialize(request.id, request.params);
      }

      if (!this.state.initialized) {
        return failure(request.id, JSON_RPC_NOT_INITIALIZED, "Not initialized");
      }

      switch (request.method) {
        case "config/read":
          return success(request.id, this.handleConfigRead(request.params));
        case "config/value/write":
          return success(request.id, this.handleConfigValueWrite(request.params));
        case "config/batchWrite":
          return success(request.id, this.handleConfigBatchWrite(request.params));
        case "configRequirements/read":
          return success(request.id, this.handleConfigRequirementsRead());
        case "account/read":
          return success(request.id, this.accountSession.read(request.params));
        case "account/login/start":
          return success(request.id, await this.accountSession.loginStart(request.params));
        case "account/login/cancel":
          return success(request.id, this.accountSession.loginCancel(request.params));
        case "account/logout":
          return success(request.id, await this.accountSession.logout());
        case "account/rateLimits/read":
          return success(request.id, this.accountSession.rateLimits());
        case "getAuthStatus":
          return success(request.id, this.accountSession.authStatus(request.params));
        case "skills/list":
          return success(request.id, this.handleSkillsList());
        case "plugin/list":
          return success(request.id, this.handlePluginList());
        case "app/list":
          return success(request.id, this.handleAppList(request.params));
        case "model/list":
          return success(request.id, await this.handleModelList(request.params));
        case "experimentalFeature/list":
          return success(request.id, this.handleExperimentalFeatureList(request.params));
        case "collaborationMode/list":
          return success(request.id, this.handleCollaborationModeList());
        case "mcpServerStatus/list":
          return success(request.id, this.handleMcpServerStatusList(request.params));
        case "thread/start":
          return success(request.id, await this.threads.start(request.params));
        case "thread/resume":
          return success(request.id, await this.threads.resume(request.params));
        case "thread/fork":
          return success(request.id, await this.threads.fork(request.params));
        case "thread/read":
          return success(request.id, await this.threads.read(request.params));
        case "thread/turns/list":
          return success(request.id, await this.threads.history.listTurns(request.params));
        case "thread/items/list":
          return success(request.id, await this.threads.history.listItems(request.params));
        case "thread/list":
          return success(request.id, await this.threads.catalog.list(request.params));
        case "thread/loaded/list":
          return success(request.id, this.threads.listLoaded(request.params));
        case "thread/name/set":
          return success(request.id, await this.threads.catalog.setName(request.params));
        case "thread/archive":
          return success(request.id, await this.threads.archive(request.params));
        case "thread/unarchive":
          return success(request.id, await this.threads.catalog.unarchive(request.params));
        case "thread/metadata/update":
          return success(request.id, await this.threads.catalog.updateMetadata(request.params));
        case "thread/unsubscribe":
          return success(request.id, this.threads.unsubscribe(request.params));
        case "turn/start":
          return success(request.id, await this.threads.turns.start(request.params));
        case "turn/interrupt":
          return success(request.id, await this.threads.turns.interrupt(request.params));
        case "command/exec":
          return success(
            request.id,
            await this.commandExecManager.execute(request.params as CommandExecParams)
          );
        case "command/exec/write":
          await this.commandExecManager.write(request.params as CommandExecWriteParams);
          return success(request.id, {});
        case "command/exec/resize":
          await this.commandExecManager.resize(request.params as CommandExecResizeParams);
          return success(request.id, {});
        case "command/exec/terminate":
          await this.commandExecManager.terminate(request.params as CommandExecTerminateParams);
          return success(request.id, {});
        default:
          this.logger.warn("Unrecognized RPC method", {
            method: request.method,
            requestId: request.id,
            params: truncateForLog(request.params),
          });
          return failure(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method not found: ${request.method}`
          );
      }
    } catch (error) {
      return failure(
        request.id,
        JSON_RPC_INTERNAL_ERROR,
        error instanceof Error ? error.message : "Internal error"
      );
    }
  }

  emitNotification(method: string, params?: unknown): AppServerNotification | null {
    if (this.state.optedOutNotifications.has(method)) {
      return null;
    }

    return params === undefined ? { method } : { method, params };
  }

  get clientInfo(): InitializeParams["clientInfo"] | null {
    return this.state.clientInfo;
  }

  get initializedNotificationReceived(): boolean {
    return this.state.initializedNotificationReceived;
  }

  private async publish(method: string, params?: unknown, threadId?: string): Promise<void> {
    if (!this.onMessage) {
      return;
    }
    if (threadId && !this.threads.isSubscribed(threadId)) {
      return;
    }

    const notification = this.emitNotification(method, params);
    if (notification) {
      await this.debugLogWriter?.write({
        at: new Date().toISOString(),
        component: "app-server",
        kind: "notification",
        threadId,
        method,
        payload: params,
      });
      await this.send(notification);
    }
  }

  private async send(message: AppServerOutgoingMessage): Promise<void> {
    await this.onMessage?.(message);
  }

  private handleNotification(message: JsonRpcMessage): null {
    if (!this.state.initialized) {
      return null;
    }

    if (message.method === "initialized") {
      this.state.initializedNotificationReceived = true;
      void this.accountSession.initialized();
    }

    return null;
  }

  private handleInitialize(id: string | number, params: unknown): JsonRpcResponse {
    if (this.state.initialized) {
      return failure(id, JSON_RPC_ALREADY_INITIALIZED, "Already initialized");
    }

    let parsed: InitializeParams;
    try {
      parsed = this.parseInitializeParams(params);
      validateHeaderValue("x-codapter-client", parsed.clientInfo.name);
    } catch {
      return failure(id, JSON_RPC_INVALID_PARAMS, "Invalid initialize params");
    }

    this.state.initialized = true;
    this.state.clientInfo = parsed.clientInfo;
    this.state.optedOutNotifications = new Set(
      parsed.capabilities?.optOutNotificationMethods ?? []
    );

    const response: InitializeResponse = {
      userAgent: this.identity.userAgent,
      codexHome: resolveCodexHome(),
      platformFamily: this.identity.platformFamily,
      platformOs: this.identity.platformOs,
    };

    return success(id, response);
  }

  private parseInitializeParams(value: unknown): InitializeParams {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid initialize params");
    }

    const candidate = value as Record<string, unknown>;
    const clientInfo = candidate.clientInfo;
    if (!clientInfo || typeof clientInfo !== "object") {
      throw new Error("Invalid initialize params");
    }

    const client = clientInfo as Record<string, unknown>;
    if (typeof client.name !== "string" || typeof client.version !== "string") {
      throw new Error("Invalid initialize params");
    }

    let capabilities: InitializeParams["capabilities"] = null;
    if (candidate.capabilities !== undefined && candidate.capabilities !== null) {
      if (typeof candidate.capabilities !== "object") {
        throw new Error("Invalid initialize params");
      }
      const raw = candidate.capabilities as Record<string, unknown>;
      capabilities = {
        experimentalApi: Boolean(raw.experimentalApi),
        optOutNotificationMethods: Array.isArray(raw.optOutNotificationMethods)
          ? raw.optOutNotificationMethods.filter(
              (entry): entry is string => typeof entry === "string"
            )
          : null,
      };
    }

    return {
      clientInfo: {
        name: client.name,
        title: typeof client.title === "string" ? client.title : null,
        version: client.version,
      },
      capabilities,
    };
  }

  private handleConfigRead(params: unknown): ConfigReadResponse {
    const parsed = (params ?? {}) as Partial<ConfigReadParams>;
    return this.configStore.read({
      includeLayers: Boolean(parsed.includeLayers),
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
    });
  }

  private handleConfigValueWrite(params: unknown): ConfigWriteResponse {
    return this.configStore.writeValue(params as ConfigValueWriteParams);
  }

  private handleConfigBatchWrite(params: unknown): ConfigWriteResponse {
    return this.configStore.writeBatch(params as ConfigBatchWriteParams);
  }

  private handleConfigRequirementsRead(): ConfigRequirementsReadResponse {
    return { requirements: null };
  }

  private handleSkillsList(): SkillsListResponse {
    return { data: [] };
  }

  private handlePluginList(): PluginListResponse {
    return {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
      remoteSyncError: null,
    };
  }

  private handleAppList(_params: unknown): AppListResponse {
    return {
      data: [],
      nextCursor: null,
    };
  }

  private handleExperimentalFeatureList(_params: unknown): ExperimentalFeatureListResponse {
    return {
      data: [],
      nextCursor: null,
    };
  }

  private handleCollaborationModeList(): CollaborationModeListResponse {
    return {
      data: [],
    };
  }

  private handleMcpServerStatusList(_params: unknown): McpServerStatusListResponse {
    return {
      data: [],
      nextCursor: null,
    };
  }

  private async handleModelList(params: unknown): Promise<ModelListResponse> {
    const { models, diagnostics, totalDurationMs } = await this.backendRouter.listModelsDetailed();
    const parsed = (params ?? {}) as Partial<ModelListParams>;
    const visible = parsed.includeHidden ? models : models.filter((model) => !model.hidden);
    const cursor = Number(parsed.cursor ?? 0);
    const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    const limit = parsed.limit ?? visible.length;
    if (!Number.isInteger(limit) || limit < 0) throw new Error("Invalid model/list limit");
    const page = visible.slice(start, start + limit);

    const response: ModelListResponse = {
      data: page.map((model) => ({
        id: model.id,
        model: model.model,
        upgrade: model.upgrade ?? null,
        upgradeInfo: model.upgradeInfo ?? null,
        availabilityNux: model.availabilityNux ?? null,
        displayName: model.displayName,
        description: model.description,
        modelSpecialty: model.modelSpecialty ?? null,
        multiAgentVersion: model.multiAgentVersion ?? null,
        additionalSpeedTiers: [...(model.additionalSpeedTiers ?? [])],
        serviceTiers: [...(model.serviceTiers ?? [])],
        defaultServiceTier: model.defaultServiceTier ?? null,
        availableAccessPrograms: model.availableAccessPrograms ?? null,
        hidden: model.hidden,
        supportedReasoningEfforts: [...model.supportedReasoningEfforts],
        defaultReasoningEffort: model.defaultReasoningEffort,
        inputModalities: [...model.inputModalities],
        supportsPersonality: model.supportsPersonality,
        isDefault: model.isDefault,
      })),
      nextCursor: limit > 0 && start + limit < visible.length ? String(start + limit) : null,
    };

    void this.debugLogWriter?.write({
      at: new Date().toISOString(),
      component: "app-server",
      kind: "backend-event",
      method: "model/list",
      payload: response,
      diagnostics,
      durationMs: totalDurationMs,
    });

    return response;
  }
}

export { readStoredAuthState, type StoredAuthState } from "./account-session.js";
export type { AppServerIdentity } from "./app-server-identity.js";
