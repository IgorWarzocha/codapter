import type {
  BackendAppServerEvent,
  BackendModelSummary,
  BackendResolveServerRequestInput,
  BackendThreadArchiveInput,
  BackendThreadForkInput,
  BackendThreadForkResult,
  BackendThreadReadInput,
  BackendThreadReadResult,
  BackendThreadResumeInput,
  BackendThreadResumeResult,
  BackendThreadSetNameInput,
  BackendThreadStartInput,
  BackendThreadStartResult,
  BackendTurnInterruptInput,
  BackendTurnStartInput,
  BackendTurnStartResult,
  Disposable,
  IBackend,
  ParsedBackendSelection,
} from "@codapter/core";
import { BackendThreadEventBuffer, parseBackendModelId } from "@codapter/core";
import { parseModelCatalog } from "./model-catalog.js";
import {
  type CodexBackendOptions,
  type CodexRpcEvent,
  CodexRpcTransport,
} from "./rpc-transport.js";

export type { CodexBackendOptions } from "./rpc-transport.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawModelId(value: string): string {
  const parsed = parseBackendModelId(value);
  return parsed?.rawModelId ?? value;
}

function mergeConfig(
  config: Record<string, unknown> | null | undefined,
  reasoningEffort: string | null | undefined
): Record<string, unknown> | null {
  const merged = config ? { ...config } : {};
  if (reasoningEffort) {
    merged.model_reasoning_effort = reasoningEffort;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function inferThreadHandle(method: string, params: unknown): string | null {
  if (isRecord(params) && typeof params.threadId === "string" && params.threadId.length > 0) {
    return params.threadId;
  }
  if (isRecord(params) && isRecord(params.thread) && typeof params.thread.id === "string") {
    return params.thread.id;
  }
  if (method === "thread/started" && isRecord(params) && isRecord(params.thread)) {
    return typeof params.thread.id === "string" ? params.thread.id : null;
  }
  return null;
}

function rewriteInboundModelFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteInboundModelFields(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model" && typeof entry === "string") {
      rewritten[key] = rawModelId(entry);
      continue;
    }
    rewritten[key] = rewriteInboundModelFields(entry);
  }
  return rewritten;
}

export class CodexBackend implements IBackend {
  public readonly backendType = "codex";

  private readonly rpc: CodexRpcTransport;
  private readonly eventBuffer = new BackendThreadEventBuffer();
  private readonly knownThreadHandles = new Set<string>();

  constructor(options: CodexBackendOptions = {}) {
    this.rpc = new CodexRpcTransport(
      options,
      (event) => this.handleRpcEvent(event),
      (message) => {
        for (const threadHandle of this.knownThreadHandles) {
          this.eventBuffer.emit(threadHandle, { kind: "disconnect", threadHandle, message });
        }
      }
    );
  }

  initialize(): Promise<void> {
    return this.rpc.initialize();
  }

  dispose(): Promise<void> {
    return this.rpc.dispose();
  }

  isAlive(): boolean {
    return this.rpc.isAlive();
  }

  parseModelSelection(model: string | null | undefined): ParsedBackendSelection | null {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    if (!parsed) {
      return {
        backendType: this.backendType,
        rawModelId: model,
      };
    }
    if (parsed.backendType !== this.backendType) {
      return null;
    }
    return parsed;
  }

  async listModels(): Promise<readonly BackendModelSummary[]> {
    const models: unknown[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const response = await this.rpc.request("model/list", { cursor, includeHidden: true });
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new Error("Invalid Codex model/list response");
      }
      models.push(...response.data);
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (cursor !== null && seenCursors.has(cursor))
        throw new Error("Codex model/list repeated a cursor");
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
    return parseModelCatalog(models);
  }

  async threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult> {
    const response = (await this.rpc.request("thread/start", {
      model: input.model,
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandbox: input.sandbox ?? null,
      config: mergeConfig(input.config ?? null, input.reasoningEffort),
      serviceTier: input.serviceTier ?? null,
      serviceName: input.serviceName ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.developerInstructions ?? null,
      personality: input.personality ?? null,
      ephemeral: input.ephemeral ?? null,
      experimentalRawEvents: input.experimentalRawEvents ?? false,
      persistExtendedHistory: input.persistExtendedHistory ?? false,
    })) as { thread?: { id?: string; path?: string | null }; reasoningEffort?: string | null };
    const threadHandle = response.thread?.id;
    if (!threadHandle) {
      throw new Error("Codex thread/start did not return thread.id");
    }
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      path: response.thread?.path ?? null,
      model: input.model,
      reasoningEffort: response.reasoningEffort ?? input.reasoningEffort,
    };
  }

  async threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult> {
    const response = (await this.rpc.request("thread/resume", {
      threadId: input.threadHandle,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandbox: input.sandbox ?? null,
      config: mergeConfig(input.config ?? null, input.reasoningEffort),
      serviceTier: input.serviceTier ?? null,
      serviceName: input.serviceName ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.developerInstructions ?? null,
      personality: input.personality ?? null,
      persistExtendedHistory: input.persistExtendedHistory ?? false,
    })) as { thread?: { id?: string; path?: string | null }; reasoningEffort?: string | null };
    const threadHandle = response.thread?.id ?? input.threadHandle;
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      path: response.thread?.path ?? null,
      model: input.model,
      reasoningEffort: response.reasoningEffort ?? input.reasoningEffort,
    };
  }

  async threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult> {
    const response = (await this.rpc.request("thread/fork", {
      threadId: input.sourceThreadHandle,
      cwd: input.cwd,
      model: input.model,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandbox: input.sandbox ?? null,
      config: mergeConfig(input.config ?? null, input.reasoningEffort),
      serviceTier: input.serviceTier ?? null,
      serviceName: input.serviceName ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.developerInstructions ?? null,
      persistExtendedHistory: input.persistExtendedHistory ?? false,
      ephemeral: input.ephemeral ?? false,
    })) as { thread?: { id?: string; path?: string | null }; reasoningEffort?: string | null };
    const threadHandle = response.thread?.id;
    if (!threadHandle) {
      throw new Error("Codex thread/fork did not return thread.id");
    }
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      path: response.thread?.path ?? null,
      model: input.model,
      reasoningEffort: response.reasoningEffort ?? input.reasoningEffort,
    };
  }

  async threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult> {
    const response = (await this.rpc.request("thread/read", {
      threadId: input.threadHandle,
      includeTurns: input.includeTurns,
    })) as {
      thread?: {
        id?: string;
        name?: string | null;
        turns?: unknown[];
        model?: string | null;
        path?: string | null;
        cwd?: string | null;
        agentNickname?: string | null;
        agentRole?: string | null;
      };
    };
    const thread = response.thread ?? {};
    const threadHandle = typeof thread.id === "string" ? thread.id : input.threadHandle;
    this.knownThreadHandles.add(threadHandle);
    return {
      threadHandle,
      title: typeof thread.name === "string" ? thread.name : null,
      model: typeof thread.model === "string" ? rawModelId(thread.model) : null,
      ...((typeof thread.path === "string" || thread.path === null) && {
        path: thread.path ?? null,
      }),
      ...(typeof thread.cwd === "string" && { cwd: thread.cwd }),
      ...((typeof thread.agentNickname === "string" || thread.agentNickname === null) && {
        agentNickname: thread.agentNickname ?? null,
      }),
      ...((typeof thread.agentRole === "string" || thread.agentRole === null) && {
        agentRole: thread.agentRole ?? null,
      }),
      turns: Array.isArray(thread.turns)
        ? (rewriteInboundModelFields(thread.turns) as BackendThreadReadResult["turns"])
        : [],
    };
  }

  async threadArchive(input: BackendThreadArchiveInput): Promise<void> {
    await this.rpc.request("thread/archive", { threadId: input.threadHandle });
  }

  async threadSetName(input: BackendThreadSetNameInput): Promise<void> {
    await this.rpc.request("thread/name/set", {
      threadId: input.threadHandle,
      name: input.name,
    });
  }

  async turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult> {
    const response = (await this.rpc.request("turn/start", {
      threadId: input.threadHandle,
      input: input.input,
      cwd: input.cwd,
      approvalPolicy: input.approvalPolicy ?? null,
      approvalsReviewer: input.approvalsReviewer ?? null,
      sandboxPolicy: input.sandboxPolicy ?? null,
      model: input.model,
      serviceTier: input.serviceTier ?? null,
      effort: input.reasoningEffort,
      summary: input.summary ?? null,
      personality: input.personality ?? null,
      outputSchema: input.outputSchema ?? null,
      collaborationMode: input.collaborationMode ?? null,
    })) as { turn?: { id?: string | null } };
    return {
      accepted: true,
      turnId: response.turn?.id ?? null,
    };
  }

  async turnInterrupt(input: BackendTurnInterruptInput): Promise<void> {
    await this.rpc.request("turn/interrupt", {
      threadId: input.threadHandle,
      turnId: input.turnId,
    });
  }

  async resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void> {
    this.rpc.respond(input.requestId, input.response);
  }

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    return this.eventBuffer.subscribe(threadHandle, listener);
  }

  private handleRpcEvent(event: CodexRpcEvent): void {
    const threadHandle = inferThreadHandle(event.method, event.params);
    if (!threadHandle) return;
    this.knownThreadHandles.add(threadHandle);
    this.eventBuffer.emit(threadHandle, {
      ...(event.id === undefined
        ? { kind: "notification" }
        : { kind: "serverRequest", requestId: event.id }),
      threadHandle,
      method: event.method,
      params: rewriteInboundModelFields(event.params),
    });
  }
}

export function createCodexBackend(options: CodexBackendOptions = {}): CodexBackend {
  return new CodexBackend(options);
}
