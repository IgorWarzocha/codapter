import type {
  BackendModelSummary,
  JsonValue,
  ModelAccessPrograms,
  ModelServiceTier,
} from "@codapter/core";
import { parseBackendModelId } from "@codapter/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawModelId(value: string): string {
  return parseBackendModelId(value)?.rawModelId ?? value;
}

function modelServiceTiers(value: unknown): ModelServiceTier[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.description !== "string"
    ) {
      throw new Error("Invalid Codex model service tier");
    }
    return { id: entry.id, name: entry.name, description: entry.description };
  });
}

function modelAccessPrograms(value: unknown): ModelAccessPrograms | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.cyber))
    throw new Error("Invalid Codex model access programs");
  return {
    cyber: value.cyber.map((entry) => {
      if (entry !== "standard" && entry !== "daybreakBlue" && entry !== "daybreakRed") {
        throw new Error("Invalid Codex model cyber access program");
      }
      return entry;
    }),
  };
}

function jsonMetadata(value: unknown): JsonValue | null {
  // Responses are already parsed JSON. These nullable catalog objects are opaque
  // to the router and must reach desktop unchanged.
  return (value ?? null) as JsonValue;
}

export function parseModelCatalog(models: readonly unknown[]): BackendModelSummary[] {
  return models.map((model) => {
    if (!isRecord(model) || typeof model.id !== "string") throw new Error("Invalid Codex model id");
    const id = rawModelId(model.id);
    const rawModel = typeof model.model === "string" ? rawModelId(model.model) : id;
    return {
      id,
      model: rawModel,
      displayName: typeof model.displayName === "string" ? model.displayName : rawModel,
      description: typeof model.description === "string" ? model.description : rawModel,
      hidden: Boolean(model.hidden),
      isDefault: Boolean(model.isDefault),
      inputModalities: Array.isArray(model.inputModalities)
        ? model.inputModalities.filter((entry): entry is string => typeof entry === "string")
        : ["text"],
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
            .filter((entry): entry is Record<string, unknown> => isRecord(entry))
            .map((entry) => ({
              reasoningEffort:
                typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : "medium",
              description: typeof entry.description === "string" ? entry.description : "",
            }))
        : [],
      defaultReasoningEffort:
        typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "medium",
      supportsPersonality: Boolean(model.supportsPersonality),
      upgrade: typeof model.upgrade === "string" ? model.upgrade : null,
      upgradeInfo: jsonMetadata(model.upgradeInfo),
      availabilityNux: jsonMetadata(model.availabilityNux),
      modelSpecialty: typeof model.modelSpecialty === "string" ? model.modelSpecialty : null,
      multiAgentVersion:
        model.multiAgentVersion === "disabled" ||
        model.multiAgentVersion === "v1" ||
        model.multiAgentVersion === "v2"
          ? model.multiAgentVersion
          : null,
      additionalSpeedTiers: Array.isArray(model.additionalSpeedTiers)
        ? model.additionalSpeedTiers.filter((entry): entry is string => typeof entry === "string")
        : [],
      serviceTiers: modelServiceTiers(model.serviceTiers),
      defaultServiceTier:
        typeof model.defaultServiceTier === "string" ? model.defaultServiceTier : null,
      availableAccessPrograms: modelAccessPrograms(model.availableAccessPrograms),
    } satisfies BackendModelSummary;
  });
}
