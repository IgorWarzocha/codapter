# Codapter Architecture

Codapter is a protocol adapter. It exposes the Codex app-server JSON-RPC surface on the client side and routes requests to one or more backend implementations.

## Runtime Layout

- `packages/cli` owns startup, transport listeners, and backend registration.
- `packages/core` owns JSON-RPC dispatch, backend routing, thread registry state, and turn/event orchestration.
- `packages/backend-pi` owns Pi process integration.
- `packages/backend-codex` owns Codex app-server proxying over stdio.
- `packages/collab-extension` is an opt-in Pi extension for adapter-managed child threads. It does not replace the user's installed sub-agent extensions.

Within those packages, ownership follows the runtime boundary:

| Owner | Responsibility |
| --- | --- |
| CLI `config.ts`, `bootstrap.ts` | Arguments, environment validation, backend construction, shutdown |
| CLI `stdio.ts`, `listeners.ts`, `websocket.ts` | Framing, listener lifetime, connection cleanup |
| Core `app-server.ts` | Connection handshake, dispatch, capability responses, and composition |
| Core `thread-sessions.ts`, `thread-runtime.ts` | Thread lifecycle, backend subscriptions, readiness, and per-thread event queues |
| Core `thread-turns.ts`, `thread-execution.ts` | Turn submission and interruption, execution-setting snapshots |
| Core `thread-history.ts` | Stable turn/item pagination and summary projection over backend-owned history |
| Core `thread-catalog.ts`, `backend-thread-mirror.ts` | Registry queries and mutations, native child-thread identity translation |
| Core `backend-server-requests.ts` | Backend request IDs and GUI answer correlation |
| Core `desktop-plugins.ts`, `desktop-plugin-files.ts`, `desktop-plugin-mcp.ts` | Local plugin inventory, enabled skills, and desktop-to-Pi MCP configuration policy |
| Core `desktop-browser-policy.ts` | Effective Browser policy snapshots and rejection of unsupported native config layers |
| Core `thread-desktop.ts`, `thread-mcp.ts` | Thread capability snapshots, dynamic tool validation, and rich MCP item lifecycle |
| Core `config-toml.ts`, `config-store.ts` | TOML boundaries and transactional adapter setting writes |
| Core `collab-manager.ts`, `collab-agent-session.ts`, `collab-wait-queue.ts` | Child-agent orchestration, subscribed child lifetime, and pending waits |
| Core `account-session.ts`, `native-session.ts` | Account state and native Codex transcript parsing |
| Core `thread-protocol.ts` | Thread serialization and input previews |
| Core `app-server-identity.ts`, `app-server-log.ts` | Identity and diagnostic effects |
| Core `version.ts` | Shared CLI and handshake version |
| Pi `rpc-transport.ts` | Child process, request correlation, failures, orderly EOF shutdown |
| Pi `pi-process.ts`, `turn-stream.ts` | Native RPC commands and run association through settlement |
| Pi `session-runtime.ts`, `model-discovery.ts` | Process activation, probes, idle disposal, persistence, and cached discovery |
| Pi `thread-controller.ts` | Thread reservations, serialized app-server events, and dialog pairing |
| Pi `extension-ui.ts` | Pi dialogs and Codex user-input response translation |
| Pi `desktop-bridge.ts`, `desktop-extension/` | Private session transport, native capability registration, GUI tool calls and permission requests |
| Pi `desktop-mcp-proxy.ts`, `chatgpt-apps-relay.ts` | Native browser metadata and cleanup, fixed-target authenticated apps transport, and tool-policy enforcement |
| Pi `desktop-auth.ts`, `desktop-host-services.ts`, `desktop-browser-policy.ts` | On-demand native Pi authentication, narrow browser host RPCs, and managed-policy support checks |
| Pi `mcp-event-filter.ts` | Suppression of duplicate direct Pi tool items only after observing the corresponding raw MCP call |
| Pi `session-history.ts` | Pi session history normalization |
| Pi `index.ts` | Public backend composition and thread operations |
| Codex `rpc-transport.ts`, `index.ts` | Native child and pending RPC lifetime, backend thread routing |
| Collaboration `collab-client.ts`, `tool-definitions.ts`, `index.ts` | Per-call socket lifetime, native tool schemas, and registration |

## Request Flow

1. The client connects over stdio, WebSocket/TCP, or WebSocket/UDS.
2. The client sends `initialize`, then `initialized`.
3. `AppServerConnection` handles config/auth/model/thread/turn RPC methods.
4. `BackendRouter` aggregates `model/list` and resolves backend-prefixed model ids (`<backendType>::<rawModelId>`).
5. Thread methods (`thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/archive`, `thread/name/set`) route to the owning backend through `IBackend`. `thread/turns/list` and `thread/items/list` page the same normalized history with stable ID anchors.
6. Turn methods (`turn/start`, `turn/interrupt`) run on the owning backend thread handle.
7. Backend-originated notifications/server-requests/errors/disconnects are published as Codex app-server notifications.
8. `command/exec` remains adapter-native and does not route through backends.

## Core Contracts

### `IBackend`

Defined in `packages/core/src/backend.ts`.

- Lifecycle: `initialize()`, `dispose()`, `isAlive()`.
- Models: `listModels()`, `parseModelSelection()`.
- Thread lifecycle: `threadStart()`, `threadResume()`, `threadFork()`, `threadRead()`, `threadArchive()`, `threadSetName()`.
- Turn lifecycle: `turnStart()`, `turnInterrupt()`.
- Server-request responses: `resolveServerRequest()`.
- Event stream: `onEvent(threadHandle, listener)` emits `BackendAppServerEvent`.

### `BackendRouter`

Defined in `packages/core/src/backend-router.ts`.

- Registers backends by `backendType`.
- Aggregates healthy backend model lists into one picker surface.
- Enforces one aggregated default model.
- Resolves routed model ids to `{ backendType, rawModelId }` + backend instance.

### Thread Registry

Thread metadata is adapter-owned and persisted by `packages/core/src/thread-registry.ts`.

- Stores thread metadata (`name`, `cwd`, preview, archive, model fields).
- Stores backend ownership metadata (`backendType`, opaque `backendSessionId` thread handle).
- `thread/list` reads registry state; it does not scan backend history.
- `CODAPTER_STATE_DIR` selects the shared registry and Pi session root. One adapter process owns a state directory. This JSON store does not coordinate independent writers.

### Event Buffering

`BackendThreadEventBuffer` (in `backend.ts`) buffers backend events per thread handle until a runtime listener is attached, preventing early event loss during start/resume/fork races.

## Backends

### Pi Backend (`packages/backend-pi`)

- Spawns and communicates with Pi over JSONL stdio.
- Uses the installed `pi` command, preserving PATH wrappers and native configuration. No package is downloaded at startup.
- Converts Pi stream data to backend-neutral app-server events.
- Implements backend-owned `thread/read` hydration for Pi threads.
- Applies reasoning through `set_thinking_level`. Turn completion waits for `agent_settled`, not the end of an individual assistant message or low-level agent run.
- Routes native extension dialogs through `item/tool/requestUserInput`. Custom terminal UI has no Pi RPC representation.
- Registers desktop capabilities through supported Pi extension APIs. Native Pi MCP definitions win name conflicts. Desktop MCP configs and credentials are not persisted in thread metadata.
- Keeps raw MCP arguments, results, and widget metadata opaque when translating GUI thread IDs. Rich MCP items are retained by the current runtime, not a second transcript store.

### Codex Backend (`packages/backend-codex`)

- Spawns `codex app-server` over stdio.
- Relays JSON-RPC requests/responses/notifications and server requests.
- Rewrites model ids between routed (`codex::...`) and upstream raw model ids.
- Emits backend error/disconnect events for proxy failures.
- WebSocket transport is unsupported and rejected explicitly.

## Collaboration Routing

With collaboration enabled, `CollabManager` routes child-agent operations (`spawn`, `sendInput`, `wait`, `resume`, `close`) through each child thread's owning backend. This enables Pi parent threads to spawn and operate Codex child threads.

## Current Limitations

- Codex WebSocket transport is unsupported.
- Pi-backed threads can spawn Codex sub-agents, but Codex-backed threads cannot spawn Pi sub-agents.
- `command/exec` PTY mode is not implemented (`tty: true` rejected).
- Remote plugin installation and native desktop management RPCs are not a complete plugin manager.
- Cold Pi history does not retain every live MCP widget metadata field. Native Pi remains the history owner.
- Desktop sandbox labels do not sandbox native Pi tools. Pi retains its installed permissions and extension behavior.
