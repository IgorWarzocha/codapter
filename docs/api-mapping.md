# Codex API Mapping

This document maps Codex app-server concepts to the current codapter implementation.

Scope:
- `packages/core`
- `packages/backend-pi`
- `packages/backend-codex`
- `packages/cli`

Status:
- `turn/start`, `turn/interrupt`, thread lifecycle RPCs, and adapter-native `command/exec` are implemented.
- Routed model selection across multiple backends is implemented through `BackendRouter`.
- Pi and Codex backends are both wired behind the shared `IBackend` contract.
- Pi-backed elicitation is implemented through app-server server-request round-trips.
- Worktree RPCs are not implemented and currently fall through to `Method not found`.

## Transport And Handshake

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `initialize` request | `AppServerConnection.handleMessage()` in `packages/core/src/app-server.ts` | Accepts `clientInfo` and `capabilities`, validates client identity, and returns `userAgent`, `platformFamily`, `platformOs`, and absolute `codexHome`. |
| `initialized` notification | `AppServerConnection.handleMessage()` notification path | Marks the connection as initialized. |
| `optOutNotificationMethods` | `AppServerConnection.publish()` | Exact-match filtering for outgoing notifications. |
| stdio transport | `packages/cli/src/stdio.ts` | Default when `app-server` runs without `--listen`. |
| WebSocket transport | `packages/cli/src/listeners.ts` and `websocket.ts` | Supports `ws://` and `unix://` listener targets. |
| `/healthz` and `/readyz` | CLI listener HTTP endpoints | Exposed on the WebSocket listener port. |

## Config And Identity

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `config/read` | Shared `DesktopPluginCatalog.readConfig()` and adapter settings | Returns `{ config, origins, layers }`. Desktop tables combine native settings, CLI overrides, and adapter settings without importing native model defaults. Writes go only to `~/.config/codapter/config.toml`. |
| `config/value/write` | `InMemoryConfigStore.writeValue()` | Returns typed `ConfigWriteResponse`. |
| `config/batchWrite` | `InMemoryConfigStore.writeBatch()` | Returns typed `ConfigWriteResponse`. |
| `configRequirements/read` | `AppServerConnection.handleConfigRequirementsRead()` | Returns `{ requirements: null }`. |
| `account/read` | `AccountSession.read()` in `packages/core/src/account-session.ts` | Uses adapter identity and backend auth state. |
| `getAuthStatus` | `AccountSession.authStatus()` | Supported for compatibility. |
| `skills/list` | `DesktopPluginCatalog.skills()` | Local plugin skills and their enablement. Native Pi skill loading is independent. |
| `plugin/list`, `plugin/installed`, `plugin/read` | Shared `DesktopPluginCatalog` | Configured local marketplaces and materialized packages, with explicit load errors. No remote installer or authentication store is recreated. |
| Adapter identity | `packages/core/src/app-server-identity.ts` | Derived from env/TOML override or `codapter/<ADAPTER_VERSION>` from `version.ts`, with platform detection. |

## Threads

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `thread/start` | `ThreadSessions.start()` + `BackendRouter.resolveModelSelection()` | Resolves backend ownership from the selected model and creates a backend thread handle. |
| `thread/resume` | `ThreadSessions.resume()` | Reattaches using the registry's `{ backendType, backendSessionId }`. |
| `thread/fork` | `ThreadSessions.fork()` | Forks through the owning backend and creates a new registry thread entry. |
| `thread/read` | `ThreadSessions.read()` | Delegates to backend-owned `threadRead()`. |
| `thread/turns/list` | `ThreadHistory.listTurns()` | Stable turn-ID cursors, ascending/descending pages, and `notLoaded`, `summary`, or `full` item views. |
| `thread/items/list` | `ThreadHistory.listItems()` | Pages normalized items across a thread or within one turn. Supports exclusive item anchors and inclusive backwards cursors. |
| `thread/list` | `ThreadCatalog.list()` | Registry is authoritative. Entries retain backend ownership metadata. |
| `thread/loaded/list` | `ThreadSessions.listLoaded()` | Returns currently loaded thread ids only. |
| `thread/name/set` | `ThreadCatalog.setName()` | Updates backend thread name and registry metadata. |
| `thread/archive` / `thread/unarchive` | Registry metadata updates | Archive state lives in the adapter registry. |
| `thread/metadata/update` | Registry metadata updates | Used for cwd and git info. |
| `thread/unsubscribe` | Connection-local notification filter | Stops notifications for the thread on that connection. |
| `thread/status/changed` | Published from `ThreadSessions` and `ThreadRuntime` | Reflects thread state transitions such as `idle`, `active`, and `notLoaded`. |
| `thread/tokenUsage/updated` | Published from backend token stats | Emitted from Pi session stats on turn completion or update. |

## Turns And Items

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `turn/start` | `ThreadTurns.start()` | Validates thread runtime, normalizes `UserInput[]`, and calls backend `turnStart()`. |
| `turn/interrupt` | `ThreadTurns.interrupt()` | Calls backend `turnInterrupt()` and finalizes active turn state. |
| Backend notifications | `BackendAppServerEvent.kind === "notification"` | Relayed as app-server notifications (`thread/*`, `turn/*`, `item/*`). |
| Backend server requests | `BackendServerRequests` | Relayed to GUI with adapter-owned request ids, resolved back via `resolveServerRequest()`. |
| Backend errors/disconnects | `BackendAppServerEvent.kind` is `error` or `disconnect` | Published as explicit `backend/error` and `backend/disconnect`. |

## Input Mapping

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `UserInput.type: "text"` | Concatenated into prompt text | Text inputs are joined in order. |
| `UserInput.type: "image"` | Passed through as backend image input | `url` is mapped to the backend image input contract. |
| `UserInput.type: "localImage"` | Passed through as backend image input | `path` is mapped to the backend image input contract. |
| `UserInput.type: "skill"` | Known enabled plugin skill expanded by the catalog | Only catalog-owned skill paths are loaded. Native Pi skills remain independent. |
| `UserInput.type: "mention"` | Known enabled plugin mention expanded by the catalog | Selected plugin guidance becomes prompt input. Unknown attachment variants remain explicit backend errors. |
| `UserInput.type: "audio"` or `"localAudio"` | Backend-owned support | Pi rejects unsupported audio explicitly. |
| Image containing only a Codex `fileId` | Backend-owned support | Pi requires image data or a local path and rejects file-ID-only input. |

## Model And Backend

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `model/list` | `BackendRouter.listModels()` via `AppServerConnection` | Aggregated across healthy backends with backend-prefixed ids. |
| `turn/start` model selection | `BackendRouter.resolveModelSelection()` + backend `turnStart()` | Routed ids resolve to backend ownership and raw backend model id. |
| `BackendRouter` default model | Router-owned arbitration | At most one aggregated `isDefault: true` is exposed. |
| Backend request/response relay | `BackendServerRequests` + backend `resolveServerRequest()` | Supports backend-originated server requests independently of backend type. |

## `command/exec`

`command/exec` is adapter-native in codapter and is not routed through Pi or Codex backends.

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `command/exec` | `CommandExecManager.execute()` in `packages/core/src/command-exec.ts` | Uses `child_process.spawn` for buffered and streamed pipe mode. |
| `command/exec/write` | `CommandExecManager.write()` | Writes stdin to the tracked process. |
| `command/exec/resize` | `CommandExecManager.resize()` | Returns an unsupported error because PTY mode is not implemented. |
| `command/exec/terminate` | `CommandExecManager.terminate()` | Terminates the tracked process. |
| `command/exec/outputDelta` | Published by `CommandExecManager` | Base64 chunks are emitted per stream and process. |

Behavior notes:
- Buffered execution returns a final `{ exitCode, stdout, stderr }`.
- Streaming execution returns the final response after the process exits, while output deltas are published during execution.
- `processId` is required for streaming modes.
- `tty: true` is rejected.

## Pi Backend

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `IBackend` | `packages/core/src/backend.ts` | Codapter’s backend contract is the adapter-facing abstraction. |
| `PiBackend` | `packages/backend-pi/src/index.ts` | Real subprocess-backed backend implementation. |
| Thread handle identity | Opaque backend `threadHandle` values | Stored in registry as internal metadata. |
| `thread/read` | Backend-owned hydration in `PiBackend.threadRead()` | Returns backend-neutral `Turn[]`. |
| Event stream | Pi notifications mapped to `BackendAppServerEvent` | Routed through `AppServerConnection` publish path. |
| Turn completion | Pi `agent_settled` | Message and low-level agent endings are not completion. Handled extension commands may start no run. |
| User input | `packages/backend-pi/src/extension-ui.ts` | Translates native select, confirm, input, and editor requests into Codex questions and decodes the answers map. |
| Reasoning effort | Pi `set_thinking_level` RPC | Applied after model selection. |

## Codex Backend

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `CodexBackend` | `packages/backend-codex/src/index.ts` | Proxies upstream `codex app-server` over stdio. |
| Model id rewrite | Routed `<backend>::<raw>` ids | Rewrites inbound/outbound model ids between adapter and upstream Codex. |
| Server-request relay | Upstream JSON-RPC request/response mapping | Request ids are tracked and resolved through adapter relay. |
| WebSocket transport | Explicit unsupported error | Only the native backend proxy lacks WebSocket support, not client listeners. |

## Desktop capabilities

The CLI shares one local plugin catalog and adapter config store across connections. Native desktop settings are the base. CLI overrides, adapter settings, and thread overrides take precedence in that order. Only desktop capability tables enter Pi launch configuration. Quoted TOML keys and native dotted thread overrides retain their original meaning.

- `thread/start.dynamicTools` registers session-local Pi tools. Calls use the original namespace and tool name in `item/tool/call`, with connection-local response correlation, cancellation, and rich results.
- Enabled local plugin skills are listed by path. Selecting a known plugin or skill expands its guidance. Definitions and enablement survive resume without persisting MCP credentials.
- Ordinary MCP servers use native Pi registration. Exact tool filters are translated to Pi exposure rules. Unsupported approval, environment, or remote-execution policies fail closed with diagnostics.
- ChatGPT apps use native Pi provider authentication and a loopback relay to the fixed ChatGPT MCP endpoint. Connector and tool denials are enforced against the upstream catalog, not guessed name prefixes. Authentication is not copied into adapter files.
- The packaged Browser host receives the real GUI thread and turn IDs. Its stop and interrupt hooks run at the corresponding native Pi lifecycle boundaries. Ordinary Browser consent requests reach `mcpServer/elicitation/request`, not automatic approval. Requests requiring strict Guardian auto-review are rejected because manual consent is not a substitute for that review.
- Raw MCP result metadata reaches live `mcpToolCall` items for desktop rendering. Current-runtime history retains those items. Cold native Pi history can lose rich widget metadata. Tool-catalog widget resources and complete MCP app UI hosting are not implemented, so raw metadata preservation does not guarantee every app widget renders.

Plugin installation, remote marketplace synchronization, and the desktop MCP management UI are not implemented. Desktop sandbox labels still do not restrict arbitrary native Pi tools.

Browser authentication and policy reads use a private helper bound to the Pi session. The helper reads current authentication through Pi's provider API. It does not start a native Codex app-server, log tokens, or expose arbitrary host RPCs. The shipped Codex binary is still used for Desktop's native JavaScript sandbox, with its original policy.

Browser policy checks currently support known account plans that do not require cloud-managed Codex policy. Device-managed requirements, macOS MDM verification, unknown account plans, and Browser policies in unsupported system, project, or profile layers fail closed. The helper reports no managed requirements only after verifying that supported sources are absent. User and thread `browser_use` and `application` settings are preserved. This is not an enterprise policy loader.

Sanitized thread Browser restrictions survive cold resume. Native base settings are read again rather than saved as stale defaults. Older thread records without that policy information cannot use Browser until a client explicitly resupplies the complete Browser policy or starts a new thread. Other thread-only MCP configuration and credentials are not persisted and must be supplied again when needed.

## Unsupported Or Partially Implemented Areas

| Codex concept | Current state | Notes |
| --- | --- | --- |
| Worktree RPCs (`create-worktree`, `delete-worktree`, `resolve-worktree-for-thread`, `worktree-cleanup-inputs`) | Not implemented | They currently return `Method not found`. |
| Elicitation server requests (`item/tool/requestUserInput`, `mcpServer/elicitation/request`) | GUI round-trips | Native Pi dialogs and bridged MCP permission requests preserve answers, errors, and cancellation. Custom TUI screens remain unsupported. |
| GUI-provided `dynamicTools` and `item/tool/call` | Session-local Pi registration and GUI call relay | No native Pi configuration file is modified. |
| Codex websocket transport | Deferred | Explicit deterministic rejection path is implemented. |
| Legacy `codex/event/*` compatibility | Not implemented as a public surface | The current implementation targets the typed app-server surface instead. |
| Remote deployment flow | Supported only through the CLI listener transport | There is no separate remote orchestration layer in codapter. |

## Current Gaps

The implementation is usable for routed Pi/Codex thread operations, turns, and standalone commands. The main remaining gaps are:

1. Worktree RPCs are still unsupported.
2. Codex websocket transport is deferred.
3. Remote tunnel orchestration is still external to codapter.
4. Remote plugin installation and complete desktop MCP management remain unsupported.
