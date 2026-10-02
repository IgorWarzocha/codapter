import type { JsonValue } from "./protocol.js";

export interface DesktopTool {
  readonly name: string;
  readonly namespace: string | null;
  readonly description: string;
  readonly inputSchema: JsonValue;
  readonly deferLoading: boolean;
}

export type DesktopBrowserConfig =
  | { readonly config: Readonly<Record<string, JsonValue>>; readonly error?: never }
  | { readonly error: string; readonly config?: never };

export interface DesktopSessionCapabilities {
  readonly tools: readonly DesktopTool[];
  /** Native Pi configs after Desktop policy translation. Reject unsupported restrictions upstream. */
  readonly mcpServers: Readonly<Record<string, JsonValue>>;
  readonly instructions: readonly string[];
  /** Associated-thread policy snapshot. Missing or error is unavailable, not default allow. */
  readonly browserConfig?: DesktopBrowserConfig;
}
