import type {
  BackendAppServerEvent,
  BackendCapabilities,
  BackendImageInput,
  BackendMessage,
  BackendModelSummary,
  BackendResolveServerRequestInput,
  BackendSessionLaunchConfig,
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
} from "@codapter/core";
import { parseBackendModelId } from "@codapter/core";
import { mapHistoryToTurns, mergeHistoryTurnsWithLiveTurn } from "./session-history.js";
import { type PiBackendOptions, PiSessionRuntime } from "./session-runtime.js";
import { PiThreadController } from "./thread-controller.js";

export type { PiBackendOptions } from "./session-runtime.js";

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  requiresAuth: false,
  supportsImages: true,
  supportsThinking: true,
  supportsParallelTools: true,
  supportedToolTypes: [],
};

function cloneCapabilities(capabilities: BackendCapabilities): BackendCapabilities {
  return {
    ...capabilities,
    supportedToolTypes: [...capabilities.supportedToolTypes],
  };
}

export class PiBackend implements IBackend {
  public readonly backendType = "pi";
  public readonly sessionDir: string;
  private readonly runtime: PiSessionRuntime;
  private readonly threads: PiThreadController;

  constructor(options: PiBackendOptions = {}) {
    this.threads = new PiThreadController(
      this,
      (handle) => this.runtime.getActiveProcess(handle),
      (handle) => this.runtime.getProcess(handle),
      (handle) => this.runtime.resetIdleTimer(handle)
    );
    this.runtime = new PiSessionRuntime(options, this.threads);
    this.sessionDir = this.runtime.sessionDir;
  }

  initialize(): Promise<void> {
    return this.runtime.initialize();
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
    this.threads.dispose();
  }

  isAlive(): boolean {
    return this.runtime.isAlive();
  }

  parseModelSelection(model: string | null | undefined) {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    if (!parsed || parsed.backendType !== this.backendType) {
      return null;
    }
    return parsed;
  }

  async threadStart(input: BackendThreadStartInput): Promise<BackendThreadStartResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.createSession(launchConfig);
    try {
      if (input.model) {
        await this.setModel(threadHandle, input.model);
      }
      if (input.reasoningEffort) {
        await this.setThinkingLevel(threadHandle, input.reasoningEffort);
      }
      this.threads.bindThread(threadHandle, input.threadId);
      return {
        threadHandle,
        path: await this.getSessionPath(threadHandle),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      };
    } catch (error) {
      if (!this.runtime.isDisposed) await this.disposeSession(threadHandle);
      throw error;
    }
  }

  async threadResume(input: BackendThreadResumeInput): Promise<BackendThreadResumeResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.resumeSession(input.threadHandle, launchConfig);
    if (input.model) {
      await this.setModel(threadHandle, input.model);
    }
    if (input.reasoningEffort) {
      await this.setThinkingLevel(threadHandle, input.reasoningEffort);
    }
    this.threads.bindThread(threadHandle, input.threadId);
    return {
      threadHandle,
      path: await this.getSessionPath(threadHandle),
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadFork(input: BackendThreadForkInput): Promise<BackendThreadForkResult> {
    const launchConfig = { ...input.launchConfig, cwd: input.cwd };
    const threadHandle = await this.forkSession(input.sourceThreadHandle, launchConfig);
    try {
      if (input.model) {
        await this.setModel(threadHandle, input.model);
      }
      if (input.reasoningEffort) {
        await this.setThinkingLevel(threadHandle, input.reasoningEffort);
      }
      this.threads.bindThread(threadHandle, input.threadId);
      return {
        threadHandle,
        path: await this.getSessionPath(threadHandle),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      };
    } catch (error) {
      if (!this.runtime.isDisposed) await this.disposeSession(threadHandle);
      throw error;
    }
  }

  async threadRead(input: BackendThreadReadInput): Promise<BackendThreadReadResult> {
    let turns = input.includeTurns
      ? mapHistoryToTurns(await this.readSessionHistory(input.threadHandle))
      : [];
    const liveTurn = this.threads.liveTurn(input.threadHandle);
    if (input.includeTurns && liveTurn) {
      turns = mergeHistoryTurnsWithLiveTurn(
        turns,
        liveTurn as unknown as {
          readonly items?: readonly Record<string, unknown>[];
          readonly status?: string;
        }
      );
      turns.push(liveTurn as unknown as (typeof turns)[number]);
    }
    const record = await this.runtime.requireRecord(input.threadHandle);
    return {
      threadHandle: input.threadHandle,
      title: record.sessionName,
      model: record.modelId,
      turns: turns as unknown as BackendThreadReadResult["turns"],
    };
  }

  async threadArchive(input: BackendThreadArchiveInput): Promise<void> {
    await this.disposeSession(input.threadHandle);
  }

  async threadSetName(input: BackendThreadSetNameInput): Promise<void> {
    await this.setSessionName(input.threadHandle, input.name);
  }

  async turnStart(input: BackendTurnStartInput): Promise<BackendTurnStartResult> {
    this.runtime.assertReady();
    return this.threads.turnStart(input);
  }

  async turnInterrupt(input: BackendTurnInterruptInput): Promise<void> {
    return this.threads.turnInterrupt(input);
  }

  async resolveServerRequest(input: BackendResolveServerRequestInput): Promise<void> {
    return this.threads.resolveServerRequest(input);
  }

  // Session-oriented API remains supported alongside IBackend.
  createSession(config?: BackendSessionLaunchConfig) {
    return this.runtime.createSession(config);
  }
  resumeSession(handle: string, config?: BackendSessionLaunchConfig) {
    return this.runtime.resumeSession(handle, config);
  }
  forkSession(handle: string, config?: BackendSessionLaunchConfig) {
    return this.runtime.forkSession(handle, config);
  }
  disposeSession(handle: string) {
    return this.runtime.disposeSession(handle);
  }
  readSessionHistory(handle: string): Promise<BackendMessage[]> {
    return this.runtime.readSessionHistory(handle);
  }
  setSessionName(handle: string, name: string) {
    return this.runtime.setSessionName(handle, name);
  }
  getSessionPath(handle: string) {
    return this.runtime.getSessionPath(handle);
  }
  prompt(handle: string, turnId: string, text: string, images?: readonly BackendImageInput[]) {
    return this.runtime.prompt(handle, turnId, text, images);
  }
  abort(handle: string) {
    return this.runtime.abort(handle);
  }
  listModels(): Promise<BackendModelSummary[]> {
    return this.runtime.listModels();
  }
  setModel(handle: string, modelId: string) {
    return this.runtime.setModel(handle, modelId);
  }
  setThinkingLevel(handle: string, effort: string) {
    return this.runtime.setThinkingLevel(handle, effort);
  }
  respondToElicitation(handle: string, requestId: string, response: unknown) {
    return this.runtime.respondToElicitation(handle, requestId, response);
  }
  async getCapabilities(): Promise<BackendCapabilities> {
    this.runtime.assertReady();
    return cloneCapabilities(DEFAULT_CAPABILITIES);
  }
  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void): Disposable {
    this.runtime.assertReady();
    return this.threads.onEvent(threadHandle, listener);
  }
}

export function createPiBackend(options: PiBackendOptions = {}): PiBackend {
  return new PiBackend(options);
}
