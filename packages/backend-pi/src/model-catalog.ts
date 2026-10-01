import type { BackendModelSummary } from "@codapter/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface UpstreamModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
}

function normalizeModelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function mapUpstreamModel(model: unknown, index: number): BackendModelSummary | null {
  if (!isRecord(model)) {
    return null;
  }

  const provider = typeof model.provider === "string" ? model.provider : "pi";
  const id = typeof model.id === "string" ? model.id : "unknown";
  const combinedId = normalizeModelKey(provider, id);
  const displayName = typeof model.name === "string" && model.name.length > 0 ? model.name : id;
  const reasoning = Boolean(model.reasoning);
  const inputModalities = Array.isArray(model.input)
    ? model.input.filter((value): value is string => typeof value === "string")
    : ["text"];

  return {
    id: combinedId,
    model: combinedId,
    displayName,
    description: displayName,
    hidden: false,
    isDefault: index === 0,
    inputModalities,
    supportedReasoningEfforts: reasoning
      ? [
          {
            reasoningEffort: "minimal",
            description: "Fast responses with lighter reasoning",
          },
          {
            reasoningEffort: "low",
            description: "Balances speed with some reasoning",
          },
          {
            reasoningEffort: "medium",
            description: "Provides a solid balance of reasoning depth and latency",
          },
          {
            reasoningEffort: "high",
            description: "Greater reasoning depth for complex problems",
          },
          {
            reasoningEffort: "xhigh",
            description: "Extra high reasoning depth for complex problems",
          },
        ]
      : [
          {
            reasoningEffort: "none",
            description: "No additional reasoning",
          },
        ],
    defaultReasoningEffort: reasoning ? "medium" : "none",
    supportsPersonality: false,
  };
}

export function mapAvailableModelsToSummaries(
  models: unknown,
  defaults?: {
    readonly modelId?: string | undefined;
    readonly reasoningEffort?: string | undefined;
    readonly thinkingLevels?: readonly string[] | undefined;
  }
): BackendModelSummary[] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .map((model, index) => mapUpstreamModel(model, index))
    .filter((model): model is BackendModelSummary => model !== null)
    .map((model) => ({
      ...model,
      ...(defaults?.modelId ? { isDefault: model.id === defaults.modelId } : {}),
      ...(model.id === defaults?.modelId && defaults.thinkingLevels
        ? {
            supportedReasoningEfforts: defaults.thinkingLevels.map((level) => ({
              reasoningEffort: level === "off" ? "none" : level,
              description: level === "off" ? "No additional reasoning" : `${level} reasoning`,
            })),
          }
        : {}),
      ...(defaults?.reasoningEffort && model.defaultReasoningEffort !== "none"
        ? {
            defaultReasoningEffort:
              defaults.reasoningEffort === "off" ? "none" : defaults.reasoningEffort,
          }
        : {}),
    }));
}

export function parseStateModelId(model: UpstreamModel | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  return normalizeModelKey(model.provider, model.id);
}

export function parseStateModelContextWindow(model: UpstreamModel | undefined): number | null {
  if (!model) {
    return null;
  }
  return typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
    ? model.contextWindow
    : null;
}

function isUpstreamModel(value: unknown): value is UpstreamModel {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
}

export function parseUpstreamModelFromResponse(value: unknown): UpstreamModel | undefined {
  if (isRecord(value) && isUpstreamModel(value.model)) {
    return value.model;
  }
  if (isUpstreamModel(value)) {
    return value;
  }
  return undefined;
}
