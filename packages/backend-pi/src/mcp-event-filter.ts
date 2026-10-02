import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BackendEvent } from "@codapter/core";
import type { DesktopMcpCallEvent } from "./chatgpt-apps-relay.js";

type ToolEvent = Extract<BackendEvent, { type: "tool_start" | "tool_update" | "tool_end" }>;
type ToolStart = Extract<ToolEvent, { type: "tool_start" }>;
type ToolUpdate = Extract<ToolEvent, { type: "tool_update" }>;
interface HeldCall {
  readonly server: string;
  readonly start: ToolStart;
  update?: ToolUpdate;
}

function nativeMcpIdentity(value: unknown): { server: string; tool: string } | null {
  if (value === null || typeof value !== "object" || !("details" in value)) return null;
  const details = value.details;
  if (
    details === null ||
    typeof details !== "object" ||
    !("server" in details) ||
    !("tool" in details)
  )
    return null;
  return typeof details.server === "string" && typeof details.tool === "string"
    ? { server: details.server, tool: details.tool }
    : null;
}

function nativePrefix(server: string): string {
  return `mcp__${server}__`.replace(/[^A-Za-z0-9_]/g, "_");
}

function matchesNativeName(server: string, tool: string, nativeName: string): boolean {
  // Pi's createMcpToolName sanitizes names, then hashes long or colliding names.
  // This matches native rendering only. Connector identity never comes from a name.
  const plain = `${nativePrefix(server)}${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return (
    (plain.length <= 64 && nativeName === plain) || nativeName === `${plain.slice(0, 55)}_${hash}`
  );
}

/** Suppress a native direct-call bubble only after its raw transport call is observed. */
export class McpEventFilter {
  private readonly held = new Map<string, HeldCall>();
  private readonly rawStarts: DesktopMcpCallEvent[] = [];

  constructor(
    private readonly instrumentedServers: () => readonly string[],
    private readonly emit: (event: ToolEvent) => void
  ) {}

  observeRaw(event: DesktopMcpCallEvent): void {
    if (event.phase === "started") this.rawStarts.push(event);
  }

  handle(event: ToolEvent): void {
    if (event.type === "tool_start") {
      const servers = this.instrumentedServers().filter((server) =>
        event.toolName.startsWith(nativePrefix(server))
      );
      const server = servers[0];
      if (servers.length === 1 && server !== undefined) {
        this.held.set(event.toolCallId, { server, start: event });
        return;
      }
    }
    const held = this.held.get(event.toolCallId);
    if (!held) {
      this.emit(event);
      return;
    }
    if (event.type === "tool_update") {
      // Pi updates are cumulative. Retain only the last update while awaiting proof.
      held.update = event;
      return;
    }
    if (event.type === "tool_end") {
      this.held.delete(event.toolCallId);
      if (this.consumeRaw(held, event.output)) return;
      // Native auth, permission or registration failures may never reach the transport.
      // Without raw-start evidence, keep the original native failure visible.
      this.release(held);
      this.emit(event);
    }
  }

  flush(): void {
    for (const held of this.held.values()) {
      if (!this.consumeRaw(held)) this.release(held);
    }
    this.held.clear();
    this.rawStarts.length = 0;
  }

  private consumeRaw(held: HeldCall, output?: unknown): boolean {
    // Pi's native convertMcpResult/progress records exact server and upstream tool.
    // Prefer that identity when hooks or schema defaults changed the initial arguments.
    const identity = nativeMcpIdentity(output) ?? nativeMcpIdentity(held.update?.output);
    const index = this.rawStarts.findIndex(
      (raw) =>
        raw.turnId === held.start.turnId &&
        raw.server === held.server &&
        matchesNativeName(raw.server, raw.tool, held.start.toolName) &&
        ((identity?.server === raw.server && identity.tool === raw.tool) ||
          isDeepStrictEqual(raw.arguments, held.start.input ?? {}))
    );
    if (index === -1) return false;
    this.rawStarts.splice(index, 1);
    return true;
  }

  private release(held: HeldCall): void {
    this.emit(held.start);
    if (held.update) this.emit(held.update);
  }
}
