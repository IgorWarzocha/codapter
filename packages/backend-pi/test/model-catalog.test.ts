import { describe, expect, it } from "vitest";
import { mapAvailableModelsToSummaries } from "../src/model-catalog.js";

describe("Pi model defaults", () => {
  it("keeps the configured model and thinking level instead of choosing the catalog's first model", () => {
    const models = mapAvailableModelsToSummaries(
      [
        { provider: "provider-a", id: "first", reasoning: true },
        { provider: "openai-codex", id: "gpt-6-luna", reasoning: true },
      ],
      {
        modelId: "openai-codex/gpt-6-luna",
        reasoningEffort: "low",
        thinkingLevels: ["low", "high", "max"],
      }
    );
    expect(models.map((model) => model.isDefault)).toEqual([false, true]);
    expect(models[1]?.defaultReasoningEffort).toBe("low");
    expect(models[1]?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)).toEqual([
      "low",
      "high",
      "max",
    ]);
  });

  it("maps native off to Codex none and preserves provider-qualified model ids", () => {
    const models = mapAvailableModelsToSummaries(
      [{ provider: "custom", id: "vendor/model", reasoning: true }],
      { modelId: "custom/vendor/model", reasoningEffort: "off", thinkingLevels: ["off", "low"] }
    );
    expect(models[0]).toMatchObject({
      model: "custom/vendor/model",
      isDefault: true,
      defaultReasoningEffort: "none",
    });
    expect(models[0]?.supportedReasoningEfforts[0]?.reasoningEffort).toBe("none");
  });
});
