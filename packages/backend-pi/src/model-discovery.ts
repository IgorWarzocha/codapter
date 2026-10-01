import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BackendModelSummary } from "@codapter/core";
import { mapAvailableModelsToSummaries } from "./model-catalog.js";
import type { PiProcessSession } from "./pi-process.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneModels(models: readonly BackendModelSummary[]): BackendModelSummary[] {
  return models.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  }));
}

function toRequestedModelCandidates(modelId: string): string[] {
  if (modelId.includes("/")) {
    return [modelId];
  }

  return [modelId, `openai-codex/${modelId}`];
}

// Owns discovery, coalescing and defensive catalog snapshots. Process lifetime
// stays with the session runtime, including probes and disposal during discovery.
export class PiModelDiscovery {
  private readonly modelCache = new Map<string, BackendModelSummary>();
  private modelListPromise: Promise<BackendModelSummary[]> | null = null;

  constructor(
    private readonly staticAvailableModelsPath: string | null,
    private readonly createProcess: (id: string) => PiProcessSession,
    private readonly disposeProcess: (process: PiProcessSession) => Promise<void>,
    private readonly assertReady: () => void
  ) {}

  clear(): void {
    this.modelCache.clear();
    this.modelListPromise = null;
  }

  async list(): Promise<BackendModelSummary[]> {
    this.assertReady();
    if (this.modelCache.size > 0) {
      return cloneModels([...this.modelCache.values()]);
    }

    if (this.modelListPromise) {
      return cloneModels(await this.modelListPromise);
    }

    try {
      this.modelListPromise = this.loadAvailableModels();
      return cloneModels(await this.modelListPromise);
    } finally {
      this.modelListPromise = null;
    }
  }

  async resolve(modelId: string): Promise<{ id: string; provider: string; modelId: string }> {
    if (this.modelCache.size === 0) {
      await this.list();
    }

    const model = toRequestedModelCandidates(modelId)
      .map((candidate) => this.modelCache.get(candidate))
      .find((candidate) => candidate !== undefined);
    if (!model) {
      throw new Error(`Unknown Pi model: ${modelId}`);
    }

    const separator = model.model.indexOf("/");
    const provider = model.model.slice(0, separator);
    const rawModelId = model.model.slice(separator + 1);
    return {
      id: model.id,
      provider,
      modelId: rawModelId,
    };
  }

  private async loadStaticModels(filePath: string): Promise<BackendModelSummary[]> {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const models = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : [];
    return mapAvailableModelsToSummaries(models);
  }

  private async loadAvailableModels(): Promise<BackendModelSummary[]> {
    if (this.staticAvailableModelsPath) {
      const summaries = await this.loadStaticModels(this.staticAvailableModelsPath);
      this.replaceModelCache(summaries);
      return summaries;
    }

    const probe = this.createProcess(`models:${randomUUID()}`);
    try {
      const models = await probe.getAvailableModels();
      const defaults = await probe.getState();
      const thinkingLevels = await probe.getAvailableThinkingLevels();
      const summaries = mapAvailableModelsToSummaries(models, { ...defaults, thinkingLevels });
      this.assertReady();
      this.replaceModelCache(summaries);
      return summaries;
    } finally {
      await this.disposeProcess(probe);
    }
  }

  private replaceModelCache(models: readonly BackendModelSummary[]): void {
    this.modelCache.clear();
    for (const model of models) {
      this.modelCache.set(model.id, model);
    }
  }
}
