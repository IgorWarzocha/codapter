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
| `config/read` | `InMemoryConfigStore.read()` via `AppServerConnection` | Returns the typed `{ config, origins, layers }` shape. All writes are persisted to `~/.config/codapter/config.toml`. |
| `config/value/write` | `InMemoryConfigStore.writeValue()` | Returns typed `ConfigWriteResponse`. |
| `config/batchWrite` | `InMemoryConfigStore.writeBatch()` | Returns typed `ConfigWriteResponse`. |
| `configRequirements/read` | `AppServerConnection.handleConfigRequirementsRead()` | Returns `{ requirements: null }`. |
| `account/read` | `AccountSession.read()` in `packages/core/src/account-session.ts` | Uses adapter identity and backend auth state. |
| `getAuthStatus` | `AccountSession.authStatus()` | Supported for compatibility. |
| `skills/list` | `AppServerConnection.handleSkillsList()` | Empty GUI inventory. Native Pi skill loading is unchanged. |
| `plugin/list` | `AppServerConnection.handlePluginList()` | Empty GUI inventory with current marketplace error and featured-plugin fields. Pi extension loading is unchanged. |
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
| `UserInput.type: "skill"` | Passed to the backend | Pi rejects the desktop attachment variant. Native Pi skills still load normally. |
| `UserInput.type: "mention"` | Passed to the backend | Pi rejects the desktop attachment variant. Native prompt and extension handling remains unchanged. |
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

## Unsupported Or Partially Implemented Areas

| Codex concept | Current state | Notes |
| --- | --- | --- |
| Worktree RPCs (`create-worktree`, `delete-worktree`, `resolve-worktree-for-thread`, `worktree-cleanup-inputs`) | Not implemented | They currently return `Method not found`. |
| Elicitation server requests (`item/tool/requestUserInput`, `mcpServer/elicitation/request`) | Pi-backed elicitation implemented | `item/tool/requestUserInput` is wired as a server-request round-trip; MCP server elicitation is unsupported. |
| GUI-provided `dynamicTools` and `item/tool/call` | Not bridged into Pi | Plugin prompt text can arrive as ordinary input, but plugin tool declarations and call results do not become Pi tools. |
| Codex websocket transport | Deferred | Explicit deterministic rejection path is implemented. |
| Legacy `codex/event/*` compatibility | Not implemented as a public surface | The current implementation targets the typed app-server surface instead. |
| Remote deployment flow | Supported only through the CLI listener transport | There is no separate remote orchestration layer in codapter. |

## Current Gaps

The implementation is usable for routed Pi/Codex thread operations, turns, and standalone commands. The main remaining gaps are:

1. Worktree RPCs are still unsupported.
2. Codex websocket transport is deferred.
3. Remote tunnel orchestration is still external to codapter.
4. Desktop plugin tools are not exposed to Pi through a dynamic-tool bridge.
