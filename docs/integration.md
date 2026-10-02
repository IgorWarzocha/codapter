# Integration Guide

This document covers how to run codapter locally, how the main transport options work, and what is currently supported.

## Prerequisites

- Node.js 24 LTS recommended. Supported alternatives are Node 22.22.1+ and 26+.
- `npm` workspaces enabled.
- The repo checked out with the `packages/*` workspace layout intact for development. Deployment needs all four `.mjs` files produced in `dist/`, retaining executable permissions on the CLI and desktop MCP proxy.
- An installed `pi` command with configured authentication and extensions.

## Build And Test

- `npm run build` compiles all TypeScript projects.
- `npm run lint` checks formatting and static quality with Biome.
- `npm run test` runs the Vitest suite.
- `npm run check` builds packages and distribution bundles, then runs lint and deterministic tests.
- `npm run test:live` exercises installed Pi with Luna 6 and low reasoning. It uses real authentication and inference. No other test command makes model calls.

## CLI Entry Point

The main command is:

```bash
codapter app-server
```

Without `--listen`, codapter serves the app-server protocol over stdio.

### Listener Flags

- `--listen ws://host:port` starts a WebSocket listener over TCP.
- `--listen unix:///path/to/socket` starts a WebSocket listener over a Unix domain socket.
- Multiple `--listen` flags are supported.
- `CODAPTER_LISTEN` can provide a comma-separated fallback list of listeners.

### Other Flags

- `--collab` enables adapter-managed sub-agent collaboration through an additional Pi extension and an internal UDS listener. Also available via `CODAPTER_COLLAB=1`. Native Pi sub-agent extensions do not require this flag.
- `--analytics-default-enabled` is accepted and ignored.
- `--version` prints the package version.
- `--help` prints usage.
- Native `-c key=value`, `--config key=value`, and `--config=key=value` overrides are accepted before or after `app-server` for Desktop compatibility, including quoted plugin keys. They are forwarded intact to Codex. Desktop capability settings feed Pi's session-local bridge. Other native settings are ignored for Pi, with only their keys logged. Pi's own model defaults, extensions, and authentication remain authoritative.

## Desktop Integration

Use `scripts/codapter.sh` for ChatGPT Desktop, or `scripts/codex.sh` for a native Codex comparison. Both respect `CODAPTER_DESKTOP_COMMAND` and pass their arguments to the desktop executable.

Typical flow:

1. Run `npm run build:dist`.
2. Quit an existing desktop instance before switching its backend.
3. Run `./scripts/codapter.sh`.
4. Select a Pi model in the desktop model picker.

For custom launchers, set `CODEX_CLI_PATH` to the absolute `dist/codapter.mjs` path and `CODEX_APP_SERVER_FORCE_CLI=1`.

Debugging is opt-in: `./scripts/codapter.sh --remote-debugging-port=9233`. The launcher prints the stdio traffic-log path. It appends to a private runtime directory rather than deleting prior evidence. Logs contain conversation and tool data.

The current code supports the GUI-facing handshake, config reads/writes, model listing, thread lifecycle RPCs, turn streaming, and standalone command execution.

## Configuration

codapter reads `codapter.toml` from the current working directory when present.

Supported current override:

- `emulateCodexIdentity = "..."` sets the reported user agent identity.

Environment override:

- `CODAPTER_EMULATE_CODEX_IDENTITY` takes precedence over the TOML value.
- `CODAPTER_STATE_DIR` changes the registry and Pi session root.
- `CODAPTER_CONFIG_FILE` changes the persistent adapter config path. It does not change Pi settings or authentication.

Use those two storage overrides for isolated repros while retaining your installed Pi environment. Do not replace HOME or delete your real registry to make a smoke test pass.

## Transport Notes

- Stdio uses NDJSON line framing.
- WebSocket transport serves the same JSON-RPC surface on the root `/` endpoint.
- WebSocket listeners also expose `/healthz` and `/readyz`.
- Unix domain socket listeners create parent directories as needed and remove stale sockets on startup.
- Incoming WebSocket connections with an `Origin` header are rejected.
- WebSocket clients are otherwise unauthenticated and can execute host commands. Bind to loopback and tunnel over SSH, not a public interface.

```sh
# Adapter host
node dist/codapter.mjs app-server --listen ws://127.0.0.1:9234
# Client host
ssh -N -L 9234:127.0.0.1:9234 user@adapter-host
```

Connect a WebSocket-capable client to `ws://127.0.0.1:9234/`. For the installed desktop, `CODEX_APP_SERVER_WS_URL` can select that endpoint instead of stdio. Do not set `CODEX_APP_SERVER_FORCE_CLI=1` in that mode.

## Backend Notes

Codapter routes thread and turn operations through `BackendRouter` into registered `IBackend` implementations.

- Model ids in picker responses are backend-routed: Pi entries are prefixed (`pi::...`), while Codex entries use raw native ids like `gpt-5.4`.
- Thread ownership is persisted in the registry as `{ backendType, backendSessionId }`.
- Pi session state is persisted under `~/.local/share/codapter/backend-pi/` by default.
- Pi subprocesses are spawned on demand and shut down with the adapter.
- Pi is enabled by default and a Pi startup failure is fatal. `CODAPTER_PI_DISABLE=1` explicitly disables it. Native Codex registration is optional and can be disabled with `CODAPTER_CODEX_DISABLE=1`.
- `turn/start` streams backend events into Codex notifications.
- `command/exec` runs locally in the adapter, not through Pi or Codex backends.

## Current Limitations

- Pi dialogs use `item/tool/requestUserInput`. Bridged desktop MCP elicitations use `mcpServer/elicitation/request` and retain the GUI's actual decision.
- Remote tunnel orchestration is not automated by codapter. Use your own SSH or port-forward setup if you want to connect to a WebSocket listener remotely.
- Native Codex backend WebSocket transport is unsupported. Client-facing WebSocket listeners are independent and supported.
- Pi-backed threads can spawn Codex sub-agents, but Codex-backed threads cannot spawn Pi sub-agents.
- Pi RPC supports extension tools and standard dialogs, but not custom TUI rendering or terminal keybindings. GUI skills/plugin management does not manage native Pi extensions.
- Desktop sandbox and approval controls do not restrict Pi host permissions.
