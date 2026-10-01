import { randomUUID } from "node:crypto";
import type { BackendRouter } from "./backend-router.js";
import type { CollabManager } from "./collab-manager.js";
import type {
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from "./protocol.js";
import { isInternalTitlePrompt } from "./thread-catalog.js";
import {
  buildSandboxPolicy,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_APPROVALS_REVIEWER,
  type ThreadExecutionSettings,
} from "./thread-execution.js";
import { serializeTurn } from "./thread-protocol.js";
import type { ThreadRegistry, ThreadRegistryEntry } from "./thread-registry.js";
import type { ThreadRuntime } from "./thread-runtime.js";

function isSubAgentThreadSource(
  source: ThreadRegistryEntry["source"]
): source is Extract<ThreadRegistryEntry["source"], { subAgent: unknown }> {
  return "subAgent" in source;
}

export class ThreadTurns {
  constructor(
    private readonly backendRouter: BackendRouter,
    private readonly threadRegistry: ThreadRegistry,
    private readonly execution: ThreadExecutionSettings,
    private readonly collabManager: CollabManager | null,
    private readonly runtimeForThread: (threadId: string) => ThreadRuntime | undefined
  ) {}
  async start(params: unknown): Promise<TurnStartResponse> {
    const parsed = params as TurnStartParams;
    const runtime = this.runtimeForThread(parsed.threadId);
    if (!runtime) throw new Error(`Thread ${parsed.threadId} is not loaded`);
    await runtime.requireReady();
    let entry = await this.getThreadEntry(parsed.threadId);
    const { text, preview } = this.normalizeUserInputs(parsed.input);
    const backend = this.backendRouter.requireBackend(entry.backendType);
    const effectiveModel = this.execution.resolveRequestedModel(
      parsed.cwd ?? entry.cwd,
      parsed.model,
      parsed.collaborationMode ?? null,
      entry.model
    );
    const effectiveReasoningEffort = this.execution.resolveRequestedReasoningEffort(
      parsed.cwd ?? entry.cwd,
      parsed.effort,
      parsed.collaborationMode ?? null,
      entry.reasoningEffort
    );
    const requestedSelection =
      effectiveModel !== null ? this.backendRouter.parseModelSelection(effectiveModel) : null;
    if (requestedSelection && requestedSelection.selection.backendType !== entry.backendType) {
      throw new Error(
        `Cannot run turn on backend ${requestedSelection.selection.backendType}; thread belongs to ${entry.backendType}`
      );
    }
    const threadPatch: {
      hidden?: boolean;
      preview?: string | null;
      cwd?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
    } = {};
    if (!entry.preview && preview) {
      if (isInternalTitlePrompt(text)) {
        threadPatch.hidden = true;
        threadPatch.preview = null;
      } else {
        threadPatch.preview = preview;
      }
    }
    if (parsed.cwd) {
      threadPatch.cwd = parsed.cwd;
    }
    if (entry.model !== effectiveModel) {
      threadPatch.model = effectiveModel;
    }
    if (entry.reasoningEffort !== effectiveReasoningEffort) {
      threadPatch.reasoningEffort = effectiveReasoningEffort;
    }
    if (Object.keys(threadPatch).length > 0) {
      entry = await this.threadRegistry.update(parsed.threadId, threadPatch);
    }

    const existingExecutionContext = this.execution.cloneThreadExecutionContext(parsed.threadId);
    this.execution.recordThreadExecutionContext(parsed.threadId, {
      cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
      model: entry.model,
      approvalPolicy:
        parsed.approvalPolicy ??
        existingExecutionContext?.approvalPolicy ??
        DEFAULT_APPROVAL_POLICY,
      approvalsReviewer:
        parsed.approvalsReviewer ??
        existingExecutionContext?.approvalsReviewer ??
        DEFAULT_APPROVALS_REVIEWER,
      sandbox: existingExecutionContext?.sandbox ?? null,
      sandboxPolicy:
        parsed.sandboxPolicy ??
        existingExecutionContext?.sandboxPolicy ??
        buildSandboxPolicy(
          existingExecutionContext?.sandbox ?? null,
          parsed.cwd ?? entry.cwd ?? process.cwd()
        ),
      config: existingExecutionContext?.config ?? null,
      reasoningEffort: entry.reasoningEffort,
      serviceTier: parsed.serviceTier ?? existingExecutionContext?.serviceTier ?? null,
      serviceName: existingExecutionContext?.serviceName ?? null,
      baseInstructions: existingExecutionContext?.baseInstructions ?? null,
      developerInstructions: existingExecutionContext?.developerInstructions ?? null,
      personality: parsed.personality ?? existingExecutionContext?.personality ?? null,
      summary: parsed.summary ?? existingExecutionContext?.summary ?? null,
      collaborationMode:
        parsed.collaborationMode ?? existingExecutionContext?.collaborationMode ?? null,
    });

    const turnId = randomUUID();
    runtime.beginTurn(turnId);
    const collabAgent = isSubAgentThreadSource(entry.source)
      ? (this.collabManager?.getAgentByThreadId(parsed.threadId) ?? null)
      : null;
    if (collabAgent) {
      this.collabManager?.syncExternalTurnStart(parsed.threadId, turnId);
    } else {
      runtime.bindSubscription(
        !runtime.managedByCollab || this.collabManager?.getAgentByThreadId(parsed.threadId) === null
      );
    }

    await runtime.publishStatus();

    let backendTurnId: string = turnId;
    try {
      const startedTurn = await backend.turnStart({
        threadId: parsed.threadId,
        threadHandle: runtime.threadHandle,
        turnId,
        cwd: parsed.cwd ?? entry.cwd ?? process.cwd(),
        input: parsed.input,
        model: requestedSelection?.selection.rawModelId ?? null,
        reasoningEffort: effectiveReasoningEffort,
        approvalPolicy: parsed.approvalPolicy ?? null,
        approvalsReviewer: parsed.approvalsReviewer ?? null,
        sandboxPolicy: parsed.sandboxPolicy ?? null,
        serviceTier: parsed.serviceTier ?? null,
        summary: parsed.summary ?? null,
        personality: parsed.personality ?? null,
        outputSchema: parsed.outputSchema ?? null,
        collaborationMode: parsed.collaborationMode ?? null,
      });
      if (startedTurn.turnId) {
        backendTurnId = startedTurn.turnId;
        runtime.acceptTurnId(startedTurn.turnId);
      }
      runtime.recordLoadedTurnId(backendTurnId, turnId);
    } catch (error) {
      await runtime.finishTurn(turnId);
      throw error;
    }

    return {
      turn: serializeTurn({
        id: backendTurnId,
        status: "inProgress",
        error: null,
        items: [],
      }),
    };
  }
  async interrupt(params: unknown): Promise<TurnInterruptResponse> {
    const parsed = params as TurnInterruptParams;
    const entry = await this.getThreadEntry(parsed.threadId);
    const backend = this.backendRouter.requireBackend(entry.backendType);
    const runtime = this.runtimeForThread(parsed.threadId);
    if (runtime?.status !== "turn_active" || runtime.activeTurnId !== parsed.turnId) {
      throw new Error(`No active turn ${parsed.turnId} for thread ${parsed.threadId}`);
    }

    await backend.turnInterrupt({
      threadId: parsed.threadId,
      threadHandle: runtime.threadHandle,
      turnId: parsed.turnId,
    });
    await runtime.finishTurn(parsed.turnId);
    if (
      isSubAgentThreadSource(entry.source) &&
      this.collabManager?.getAgentByThreadId(parsed.threadId)
    ) {
      this.collabManager?.syncExternalTurnInterrupt(parsed.threadId);
    }
    return {};
  }
  private normalizeUserInputs(input: readonly UserInput[]): { text: string; preview: string } {
    const text = input
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    return { text, preview: text.slice(0, 120) };
  }
  private async getThreadEntry(threadId: string): Promise<ThreadRegistryEntry> {
    const entry = await this.threadRegistry.get(threadId);
    if (!entry) {
      throw new Error(`Unknown thread: ${threadId}`);
    }
    return entry;
  }
}
