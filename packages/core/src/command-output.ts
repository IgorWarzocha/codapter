function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type ParsedCommandOutput = {
  output: string;
  processId: string | null;
  exitCode: number | null;
};

export function parseFormattedExecTranscript(text: string): ParsedCommandOutput | null {
  const marker = "\nOutput:\n";
  const markerIndex = text.indexOf(marker);
  if (
    markerIndex === -1 ||
    !/(^|\n)(Command: |Chunk ID: |Wall time: |Process exited with code |Process running with session ID )/u.test(
      text
    )
  ) {
    return null;
  }

  const sessionMatch = text.match(/Process running with session ID (-?\d+)/u);
  const exitCodeMatch = text.match(/Process exited with code (-?\d+)/u);
  return {
    output: text.slice(markerIndex + marker.length),
    processId: sessionMatch ? sessionMatch[1] : null,
    exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
  };
}

export function parseCommandToolOutput(output: unknown): ParsedCommandOutput | null {
  if (!isRecord(output)) {
    return null;
  }

  const details = isRecord(output.details) ? output.details : null;
  if (details) {
    const looksLikeExecDetails =
      typeof details.output === "string" &&
      (typeof details.exit_code === "number" ||
        typeof details.session_id === "number" ||
        typeof details.wall_time_seconds === "number" ||
        typeof details.chunk_id === "string");
    if (looksLikeExecDetails) {
      return {
        output: details.output as string,
        processId:
          typeof details.session_id === "number" || typeof details.session_id === "string"
            ? String(details.session_id)
            : null,
        exitCode: typeof details.exit_code === "number" ? details.exit_code : null,
      };
    }
  }

  if (!Array.isArray(output.content)) {
    return null;
  }

  const text = output.content
    .map((entry) => {
      if (!isRecord(entry)) {
        return textFromUnknown(entry);
      }
      return entry.type === "text" && typeof entry.text === "string"
        ? entry.text
        : textFromUnknown(entry);
    })
    .join("");

  return parseFormattedExecTranscript(text);
}
