import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BackendImageInput,
  BackendMessage,
  BackendSessionLaunchConfig,
  DesktopSessionCapabilities,
} from "@codapter/core";
import { PiModelDiscovery } from "./model-discovery.js";
import {
  type PiProcessLaunchOptions,
  PiProcessSession,
  type PiSessionStateSnapshot,
} from "./pi-process.js";
import { type PiBackendSessionRecord, PiBackendStateStore } from "./state-store.js";

export interface PiBackendOptions {
  readonly sessionDir?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly debugLogFilePath?: string | null;
  readonly idleTimeoutMs?: number;
  readonly collabExtensionPath?: string | null;
  readonly desktopExtensionPath?: string | null;
  readonly desktopMcpProxyPath?: string | null;
  readonly staticAvailableModelsPath?: string | null;
  readonly requestTimeoutMs?: number;
}

interface ManagedSession {
  readonly process: PiProcessSession;
  record: PiBackendSessionRecord;
}

// Session lifecycle must detach listeners before replacement, reattach after
// activation, and defer idle disposal while a thread has reserved a turn.
interface PiSessionObserver {
  hasActiveTurn(handle: string): boolean;
  detach(handle: string): void;
  reconnect(handle: string): void;
  remove(handle: string): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSessionDir(): string {
  return join(
    process.env.CODAPTER_STATE_DIR ?? join(homedir(), ".local", "share", "codapter"),
    "backend-pi"
  );
}

function cloneMessage(message: BackendMessage): BackendMessage {
  return {
    ...message,
    content: structuredClone(message.content),
  };
}

function cloneMessages(messages: readonly BackendMessage[]): BackendMessage[] {
  return messages.map(cloneMessage);
}

function opaqueSessionId(): string {
  return `pi_session_${randomUUID()}`;
}

export class PiSessionRuntime {
  public readonly sessionDir: string;

  private readonly launchOptions: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly requestTimeoutMs?: number;
  };
  private readonly idleTimeoutMs: number;
  private readonly stateStore: PiBackendStateStore;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly ownedProcesses = new Set<PiProcessSession>();
  private readonly activating = new Map<string, Promise<ManagedSession>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly models: PiModelDiscovery;
  private readonly launchConfigs = new Map<string, BackendSessionLaunchConfig>();
  private initialized = false;
  private disposed = false;
  private readonly collabExtensionPath: string | null;
  private readonly desktopExtensionPath: string | null;
  private readonly desktopMcpProxyPath: string | null;

  constructor(
    options: PiBackendOptions,
    private readonly observer: PiSessionObserver
  ) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir();
    const launchOptions: {
      command?: string;
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      requestTimeoutMs?: number;
    } = {};
    if (options.command !== undefined) {
      launchOptions.command = options.command;
    }
    if (options.args !== undefined) {
      launchOptions.args = options.args;
    }
    if (options.env !== undefined) {
      launchOptions.env = options.env;
    }
    if (options.cwd !== undefined) {
      launchOptions.cwd = options.cwd;
    }
    if (options.debugLogFilePath !== undefined) {
      launchOptions.env = {
        ...(launchOptions.env ?? {}),
        CODAPTER_DEBUG_LOG_FILE: options.debugLogFilePath ?? "",
      };
    }
    if (options.requestTimeoutMs !== undefined) {
      launchOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    this.launchOptions = launchOptions;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.collabExtensionPath = options.collabExtensionPath ?? null;
    this.desktopExtensionPath = options.desktopExtensionPath ?? null;
    this.desktopMcpProxyPath = options.desktopMcpProxyPath ?? null;
    this.stateStore = new PiBackendStateStore(this.sessionDir);
    this.models = new PiModelDiscovery(
      options.staticAvailableModelsPath ?? null,
      (id) => this.createProcess(id),
      (process) => this.disposeProcess(process),
      () => this.assertReady()
    );
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    await this.stateStore.load();
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    const disposals = Array.from(this.ownedProcesses, (process) => this.disposeProcess(process));
    await Promise.all(disposals);

    this.sessions.clear();
    this.launchConfigs.clear();
    this.models.clear();
  }

  isAlive(): boolean {
    return this.initialized && !this.disposed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getProcess(handle: string): PiProcessSession | undefined {
    return this.sessions.get(handle)?.process;
  }

  async getActiveProcess(handle: string): Promise<PiProcessSession> {
    return (await this.ensureActiveSession(handle)).process;
  }

  async createSession(config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    const sessionId = opaqueSessionId();
    if (config) this.launchConfigs.set(sessionId, config);
    const process = this.createProcess(sessionId, config, true);
    try {
      const snapshot = await process.startFresh();
      this.assertReady();
      const record = await this.persistSnapshot(sessionId, snapshot);
      this.assertReady();
      this.sessions.set(sessionId, { process, record });
      this.resetIdleTimer(sessionId);
      return sessionId;
    } catch (error) {
      this.launchConfigs.delete(sessionId);
      await this.disposeProcess(process);
      throw error;
    }
  }

  async resumeSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    if (config) {
      const previous = this.launchConfigs.get(sessionId);
      const record = await this.requireRecord(sessionId);
      const desktopCapabilities =
        config.desktopCapabilities ??
        previous?.desktopCapabilities ??
        (record.desktopCapabilities
          ? { ...record.desktopCapabilities, mcpServers: {} }
          : undefined);
      this.launchConfigs.set(sessionId, {
        ...previous,
        ...config,
        ...(desktopCapabilities ? { desktopCapabilities } : {}),
      });
    }
    await this.ensureActiveSession(sessionId);
    if (config?.desktopCapabilities) {
      await this.refreshDesktopCapabilities(sessionId, config.desktopCapabilities);
    }
    this.resetIdleTimer(sessionId);
    return sessionId;
  }

  async forkSession(sessionId: string, config?: BackendSessionLaunchConfig): Promise<string> {
    this.assertReady();
    const source = await this.ensureActiveSession(sessionId);
    if (!source.record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const forkedSessionId = opaqueSessionId();
    const forkConfig = {
      ...config,
      desktopCapabilities: config?.desktopCapabilities ??
        this.launchConfigs.get(sessionId)?.desktopCapabilities ?? {
          tools: source.record.desktopCapabilities?.tools ?? [],
          instructions: source.record.desktopCapabilities?.instructions ?? [],
          mcpServers: {},
        },
    };
    this.launchConfigs.set(forkedSessionId, forkConfig);
    const process = this.createProcess(forkedSessionId, forkConfig, true);
    try {
      await process.attachSession(source.record.sessionFile);
      // clone keeps the whole active branch. fork rewinds to BEFORE a user message.
      await process.cloneSession();
      const snapshot = await process.getState();
      this.assertReady();
      const record = await this.persistSnapshot(forkedSessionId, snapshot, source.record.createdAt);
      this.assertReady();
      this.sessions.set(forkedSessionId, { process, record });
      this.resetIdleTimer(forkedSessionId);
      return forkedSessionId;
    } catch (error) {
      this.launchConfigs.delete(forkedSessionId);
      await this.disposeProcess(process);
      throw error;
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.assertReady();
    await this.requireRecord(sessionId);
    this.clearIdleTimer(sessionId);

    const session = this.sessions.get(sessionId);
    if (session) {
      await this.disposeProcess(session.process);
      this.sessions.delete(sessionId);
    }
    this.launchConfigs.delete(sessionId);
    this.observer.remove(sessionId);
  }

  async readSessionHistory(sessionId: string): Promise<BackendMessage[]> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session?.process.isRunning()) {
      this.resetIdleTimer(sessionId);
      return cloneMessages(await session.process.getMessages());
    }

    const record = await this.requireRecord(sessionId);
    if (!record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const reader = this.createProcess(`read:${sessionId}`);
    try {
      await reader.attachSession(record.sessionFile);
      return cloneMessages(await reader.getMessages());
    } finally {
      await this.disposeProcess(reader);
    }
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.setSessionName(name);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      sessionName: name,
      updatedAt: nowIso(),
    });
  }

  async getSessionPath(sessionId: string): Promise<string | null> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.record.sessionFile;
    }

    const record = await this.requireRecord(sessionId);
    return record.sessionFile;
  }

  async prompt(
    sessionId: string,
    turnId: string,
    text: string,
    images?: readonly BackendImageInput[],
    capabilities?: DesktopSessionCapabilities
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    if (capabilities) await this.refreshDesktopCapabilities(sessionId, capabilities);
    await session.process.prompt(turnId, text, images);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async abort(sessionId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.abort();
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  listModels() {
    return this.models.list();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    const resolved = await this.models.resolve(modelId);
    await session.process.setModel(resolved.provider, resolved.modelId);
    session.record = await this.updateRecord(sessionId, {
      modelId: resolved.id,
      updatedAt: nowIso(),
    });
  }

  async setThinkingLevel(sessionId: string, effort: string): Promise<void> {
    const session = await this.ensureActiveSession(sessionId);
    await session.process.setThinkingLevel(effort);
  }

  async respondToElicitation(
    sessionId: string,
    requestId: string,
    response: unknown
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.respondToElicitation(requestId, response);
    this.resetIdleTimer(sessionId);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    if (this.idleTimeoutMs <= 0 || this.disposed) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      void this.disposeIdleSession(sessionId);
    }, this.idleTimeoutMs);
    timer.unref();
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const existing = this.idleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(sessionId);
    }
  }

  private async disposeIdleSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    if (session.process.isBusy || this.observer.hasActiveTurn(sessionId)) {
      this.resetIdleTimer(sessionId);
      return;
    }
    this.observer.detach(sessionId);
    console.error(`[codapter] Idle timeout: disposing Pi session ${sessionId}`);
    this.sessions.delete(sessionId);
    await this.disposeProcess(session.process);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Pi backend has been disposed");
    }
  }

  assertReady(): void {
    this.assertNotDisposed();
    if (!this.initialized) {
      throw new Error("Pi backend must be initialized before use");
    }
  }

  private createProcess(
    sessionId: string,
    launchConfig?: BackendSessionLaunchConfig,
    desktopSession = false
  ): PiProcessSession {
    const effectiveLaunchConfig = launchConfig ?? this.launchConfigs.get(sessionId);
    const options: PiProcessLaunchOptions = {
      sessionDir: this.sessionDir,
      opaqueSessionId: sessionId,
      ...this.launchOptions,
      ...(effectiveLaunchConfig?.cwd ? { cwd: effectiveLaunchConfig.cwd } : {}),
      ...(this.collabExtensionPath !== null
        ? { collabExtensionPath: this.collabExtensionPath }
        : {}),
      ...(desktopSession && this.desktopExtensionPath !== null
        ? { desktopExtensionPath: this.desktopExtensionPath }
        : {}),
      ...(desktopSession && this.desktopMcpProxyPath !== null
        ? { desktopMcpProxyPath: this.desktopMcpProxyPath }
        : {}),
      ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
    };

    this.assertReady();
    const process = new PiProcessSession(options);
    this.ownedProcesses.add(process);
    return process;
  }

  private async disposeProcess(process: PiProcessSession): Promise<void> {
    try {
      await process.dispose();
    } finally {
      this.ownedProcesses.delete(process);
    }
  }

  private async ensureActiveSession(sessionId: string): Promise<ManagedSession> {
    this.assertReady();
    const existing = this.sessions.get(sessionId);
    if (existing?.process.isRunning()) {
      return existing;
    }

    const pending = this.activating.get(sessionId);
    if (pending) return await pending;
    const activation = this.activateSession(sessionId);
    this.activating.set(sessionId, activation);
    try {
      return await activation;
    } finally {
      this.activating.delete(sessionId);
    }
  }

  private async activateSession(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    this.observer.detach(sessionId);
    if (existing) {
      await this.disposeProcess(existing.process);
      this.sessions.delete(sessionId);
    }
    const record = await this.requireRecord(sessionId);
    if (!this.launchConfigs.has(sessionId) && record.desktopCapabilities) {
      this.launchConfigs.set(sessionId, {
        desktopCapabilities: {
          ...record.desktopCapabilities,
          mcpServers: {},
        },
      });
    }
    const process = this.createProcess(sessionId, undefined, true);
    try {
      const snapshot = await process.attachSession(record.sessionFile);
      this.assertReady();
      const nextRecord = await this.persistSnapshot(sessionId, snapshot, record.createdAt);
      this.assertReady();
      const session = { process, record: nextRecord };
      this.sessions.set(sessionId, session);
      this.observer.reconnect(sessionId);
      return session;
    } catch (error) {
      await this.disposeProcess(process);
      throw error;
    }
  }

  async requireRecord(sessionId: string): Promise<PiBackendSessionRecord> {
    const record = await this.stateStore.get(sessionId);
    if (!record) {
      throw new Error(`Unknown Pi session: ${sessionId}`);
    }
    return record;
  }

  private async persistSnapshot(
    sessionId: string,
    snapshot: PiSessionStateSnapshot,
    createdAt?: string
  ): Promise<PiBackendSessionRecord> {
    if (!snapshot.sessionFile) {
      throw new Error("Pi session snapshot did not include a session file");
    }
    const capabilities = this.launchConfigs.get(sessionId)?.desktopCapabilities;
    const record: PiBackendSessionRecord = {
      opaqueSessionId: sessionId,
      sessionFile: snapshot.sessionFile,
      sessionName: snapshot.sessionName ?? null,
      modelId: snapshot.modelId ?? null,
      createdAt: createdAt ?? nowIso(),
      updatedAt: nowIso(),
      ...(capabilities
        ? {
            desktopCapabilities: {
              tools: structuredClone(capabilities.tools),
              instructions: [...capabilities.instructions],
            },
          }
        : {}),
    };
    await this.stateStore.upsert(record);
    return record;
  }

  private async updateRecord(
    sessionId: string,
    patch: Partial<Omit<PiBackendSessionRecord, "opaqueSessionId" | "createdAt">>
  ): Promise<PiBackendSessionRecord> {
    return await this.stateStore.update(sessionId, patch);
  }

  private async refreshDesktopCapabilities(
    sessionId: string,
    capabilities: DesktopSessionCapabilities
  ): Promise<void> {
    this.launchConfigs.set(sessionId, {
      ...this.launchConfigs.get(sessionId),
      desktopCapabilities: structuredClone(capabilities),
    });
    this.sessions.get(sessionId)?.process.refreshDesktopCapabilities(capabilities);
    const record = await this.updateRecord(sessionId, {
      desktopCapabilities: {
        tools: structuredClone(capabilities.tools),
        instructions: [...capabilities.instructions],
      },
    });
    const session = this.sessions.get(sessionId);
    if (session) session.record = record;
  }
}
