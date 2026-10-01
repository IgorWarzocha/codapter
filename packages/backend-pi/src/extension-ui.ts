import type { ToolRequestUserInputParams } from "@codapter/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mapExtensionDialog(
  requestId: string,
  payload: unknown,
  threadId: string,
  turnId: string
): ToolRequestUserInputParams {
  if (!isRecord(payload)) throw new Error("Invalid Pi extension dialog");
  const method = payload.method;
  if (!["select", "confirm", "input", "editor"].includes(String(method))) {
    throw new Error(`Unsupported Pi extension dialog: ${String(method)}`);
  }
  const options =
    method === "confirm"
      ? ["Yes", "No"]
      : method === "select" && Array.isArray(payload.options)
        ? payload.options.filter((option): option is string => typeof option === "string")
        : null;
  const title = typeof payload.title === "string" ? payload.title : "Pi extension";
  const question = [
    title,
    payload.message,
    payload.placeholder,
    typeof payload.prefill === "string" ? `Current text:\n${payload.prefill}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
  return {
    threadId,
    turnId,
    itemId: `pi_ui_${requestId}`,
    questions: [
      {
        id: requestId,
        header: title,
        question,
        isOther: method === "input" || method === "editor",
        isSecret: false,
        options: options?.map((label) => ({ label, description: "" })) ?? null,
      },
    ],
  };
}

export function mapExtensionDialogResponse(
  requestId: string,
  payload: unknown,
  response: unknown
): unknown {
  if (!isRecord(response) || "error" in response) return { cancelled: true };
  const result = "result" in response ? response.result : response;
  // Direct native responses remain supported for programmatic clients.
  if (!isRecord(result) || !isRecord(result.answers)) return result;
  const answer = result.answers[requestId];
  if (!isRecord(answer) || !Array.isArray(answer.answers) || answer.answers.length === 0) {
    return { cancelled: true };
  }
  if (answer.answers.length !== 1 || typeof answer.answers[0] !== "string") {
    throw new Error("Pi extension dialogs require one string answer");
  }
  const value = answer.answers[0];
  if (isRecord(payload) && payload.method === "confirm") {
    if (value !== "Yes" && value !== "No") throw new Error("Invalid Pi confirmation answer");
    return { confirmed: value === "Yes" };
  }
  if (
    isRecord(payload) &&
    payload.method === "select" &&
    Array.isArray(payload.options) &&
    !payload.options.includes(value)
  ) {
    throw new Error("Invalid Pi selection answer");
  }
  return { value };
}
