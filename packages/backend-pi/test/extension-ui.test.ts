import { describe, expect, it } from "vitest";
import { mapExtensionDialog, mapExtensionDialogResponse } from "../src/extension-ui.js";

describe("Pi extension dialogs over Codex user-input requests", () => {
  it("maps native options to questions and decodes the keyed answer", () => {
    const payload = { method: "select", title: "Choose", options: ["Keep", "Replace"] };
    const params = mapExtensionDialog("select-1", payload, "thread-1", "turn-1");
    expect(params).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "pi_ui_select-1",
      questions: [
        {
          id: "select-1",
          header: "Choose",
          question: "Choose",
          isOther: false,
          options: [
            { label: "Keep", description: "" },
            { label: "Replace", description: "" },
          ],
        },
      ],
    });
    expect(
      mapExtensionDialogResponse("select-1", payload, {
        result: {
          answers: {
            "select-1": { answers: ["Replace"] },
          },
        },
      })
    ).toEqual({ value: "Replace" });
    expect(() =>
      mapExtensionDialogResponse("select-1", payload, {
        result: {
          answers: {
            "select-1": { answers: ["Bogus"] },
          },
        },
      })
    ).toThrow("Invalid Pi selection");
  });

  it("distinguishes a negative confirmation from cancellation", () => {
    const payload = { method: "confirm", title: "Proceed?" };
    expect(
      mapExtensionDialog("confirm-1", payload, "thread", "turn").questions[0]?.options
    ).toEqual([
      { label: "Yes", description: "" },
      { label: "No", description: "" },
    ]);
    expect(
      mapExtensionDialogResponse("confirm-1", payload, {
        result: {
          answers: {
            "confirm-1": { answers: ["No"] },
          },
        },
      })
    ).toEqual({ confirmed: false });
    expect(mapExtensionDialogResponse("confirm-1", payload, { result: { answers: {} } })).toEqual({
      cancelled: true,
    });
    expect(
      mapExtensionDialogResponse("confirm-1", payload, { error: { message: "Cancelled" } })
    ).toEqual({ cancelled: true });
  });

  it("keeps input/editor text including empty values and multiline editor context", () => {
    const payload = { method: "editor", title: "Edit", prefill: "first\nsecond" };
    expect(mapExtensionDialog("editor", payload, "thread", "turn").questions[0]).toMatchObject({
      isOther: true,
      options: null,
      question: "Edit\n\nCurrent text:\nfirst\nsecond",
    });
    expect(
      mapExtensionDialogResponse("editor", payload, {
        result: {
          answers: {
            editor: { answers: [""] },
          },
        },
      })
    ).toEqual({ value: "" });
    expect(
      mapExtensionDialogResponse("editor", payload, { result: { value: "first\nthird" } })
    ).toEqual({ value: "first\nthird" });
  });
});
