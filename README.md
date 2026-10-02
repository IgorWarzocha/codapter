# Codapter

Use your installed [Pi coding agent](https://github.com/earendil-works/pi) through ChatGPT Desktop or another Codex app-server client. Codapter translates the protocol. Pi keeps its own tools, providers, prompts, skills, and extensions.

This is an experimental adapter, not a replacement for Pi or a complete implementation of every ChatGPT Desktop feature. The GUI is a client, not an extension manager.

![Codapter running inside Codex Desktop](docs/images/codex-desktop-example.png)

## Start

You need Node.js 24 LTS, an installed and configured `pi` command, and ChatGPT Desktop. Node 22.22.1+ and 26+ are also supported. Native Codex routing is optional and uses an installed `codex` command.

```sh
npm install
npm run build:dist
./scripts/codapter.sh
```

Quit an existing desktop instance before launching, so it cannot reuse its previous backend. On Linux the launcher uses `chatgpt` from PATH. On macOS it checks the ChatGPT and Codex application bundles. Set `CODAPTER_DESKTOP_COMMAND` to use another executable.

Select a **Pi** model in the desktop model picker. Pi model IDs look like `pi::openai-codex/gpt-6-luna`. Unprefixed model IDs route to native Codex, not Pi.

The launcher prints its traffic-log path. It does not change your Pi configuration, enable extra collaboration tools, clear your threads, or expose a debugging port. To compare against native Codex, quit the app and run `./scripts/codex.sh`.

To connect another client directly:

```sh
node dist/codapter.mjs app-server
```

For your own desktop launcher, set `CODEX_CLI_PATH` to the absolute path of `dist/codapter.mjs` and `CODEX_APP_SERVER_FORCE_CLI=1` before launching the app.

## Your Pi setup stays in Pi

The default subprocess is `pi --mode rpc`. PATH wrappers are respected, including custom skill loading. Codapter does not download another Pi package or inject `--no-extensions`. Pi reads its normal agent directory, provider authentication, project instructions, and installed extensions.

- Extension tools and hooks run inside the native Pi session.
- Model selection and reasoning effort are applied through Pi RPC.
- Pi select, confirm, input, and editor dialogs are translated to desktop user-input requests.
- Turns finish at Pi's `agent_settled` event, after extension follow-ups and recovery have finished.
- Native Pi sessions remain the source of conversation history.

Pi RPC cannot render custom terminal UI, keybindings, terminal widgets, or themes. Those features remain TUI-only. Desktop skill and plugin listings are not an inventory of your Pi extensions. An empty listing does not disable them.

Enabled local desktop plugins can supply skills and MCP tools to Pi. Desktop-provided tool calls return to the GUI, while MCP calls run through native Pi. ChatGPT apps reuse Pi's existing `openai-codex` sign-in. No second login or global Pi configuration copy is needed.

Codapter reads desktop plugin settings and applies GUI changes to its own settings file. It does not install remote plugins or replace Pi's extension manager. Unsupported permission policies disable the affected integration with a diagnostic rather than silently granting access. See [API mapping](docs/api-mapping.md#desktop-capabilities) for the supported boundaries.

Browser support uses Desktop's packaged browser host and sandbox, not a Codex app-server. Managed policies, macOS policy verification, and actions requiring Guardian auto-review are not supported and fail closed.

Codapter's optional `--collab` extension adds adapter-managed child threads. It is separate from any sub-agent extension you already use in Pi, and is off by default. Native Pi sub-agent tools remain native.

**Trust boundary:** Pi tools keep their existing host permissions. Desktop sandbox and approval labels do not create a sandbox around Pi. Adapter-native `command/exec` also runs on the host. Use only trusted local clients or an authenticated SSH tunnel.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `CODAPTER_PI_COMMAND` | Pi executable, including a configured wrapper | `pi` |
| `CODAPTER_PI_ARGS` | JSON array of launch arguments | `["--mode","rpc"]` |
| `CODAPTER_PI_DISABLE` | Disable Pi registration | `0` |
| `CODAPTER_PI_IDLE_TIMEOUT_MS` | Stop idle Pi processes, `0` disables | `300000` |
| `CODAPTER_CODEX_DISABLE` | Disable optional native Codex routing | `0` |
| `CODAPTER_CODEX_COMMAND` | Native Codex executable | `codex` |
| `CODAPTER_CODEX_ARGS` | JSON array of native Codex arguments | `["app-server"]` |
| `CODAPTER_STATE_DIR` | Thread registry and Pi session storage | `~/.local/share/codapter` |
| `CODAPTER_CONFIG_FILE` | Adapter settings file | `~/.config/codapter/config.toml` |
| `CODAPTER_LISTEN` | Comma-separated listener URIs | stdio |
| `CODAPTER_COLLAB` | Enable adapter-managed sub-agents | `0` |
| `CODAPTER_COLLAB_EXTENSION_PATH` | Override the bundled collaboration extension | bundled sibling |
| `CODAPTER_DEBUG_LOG_FILE` | Optional detailed JSONL trace | disabled |
| `CODAPTER_DESKTOP_COMMAND` | Desktop executable for launcher scripts | platform detection |
| `TAP_LOG` | Desktop traffic log | private runtime directory |

Pi authentication stays in Pi's agent directory. Codapter stores thread metadata and session files separately. Use one adapter process per state directory. Concurrent independent writers are not locked.

To select Luna 6 with low reasoning at process startup:

```sh
export CODAPTER_PI_ARGS='["--mode","rpc","--provider","openai-codex","--model","gpt-6-luna","--thinking","low"]'
./scripts/codapter.sh
```

The desktop can still override the model and effort for an individual thread or turn. For a Pi-only picker, also set `CODAPTER_CODEX_DISABLE=1`.

Older releases defaulted to downloading `@mariozechner/pi-coding-agent` with `npx`. Install current Pi and configure it before upgrading. Explicit command and argument overrides still work. Keep all four distribution files together when deploying: `dist/codapter.mjs`, `dist/collab-extension.mjs`, `dist/desktop-extension.mjs`, and `dist/desktop-mcp-proxy.mjs`.

## Remote clients

```sh
node dist/codapter.mjs app-server --listen ws://127.0.0.1:9234
node dist/codapter.mjs app-server --listen unix:///tmp/codapter.sock
```

Listeners use the root `/` WebSocket endpoint and expose `/healthz` and `/readyz`. Multiple `--listen` flags are supported. Connections with an Origin header are rejected, but there is no authentication layer. Do not bind an unauthenticated listener to a public interface.

See [integration](docs/integration.md) for SSH forwarding, debugging, and supported flags.

## Development and verification

```sh
npm run check        # Build the distributable, lint, run deterministic tests
npm run test:smoke   # Local protocol and subprocess integration fixtures
npm run test:live    # Installed Pi, real Luna 6, low reasoning
```

The ordinary suite makes no inference calls. The opt-in live test uses your installed Pi configuration and authentication. It reads a random token through an extension tool, checks streaming completion, forks a thread, and resumes it after restarting the adapter. It isolates Codapter state without replacing HOME. It fails rather than choosing another model if Luna 6 is unavailable.

[Architecture](docs/architecture.md) identifies code owners. [API mapping](docs/api-mapping.md) describes the protocol subset. Historical investigation documents under `docs/bootstrap`, `docs/design`, and `docs/implementation` are not current compatibility guarantees.

## Troubleshooting and limits

- **Desktop does not connect:** quit the existing app, rebuild, then use the launcher. Current Desktop adds Codex config flags before `app-server`; old Codapter binaries reject them.
- **Pi startup fails:** run your configured `pi --version` and check the launcher's stderr. Keep your normal extensions enabled while diagnosing.
- **Wrong backend:** select a `pi::` model. Codex models use native unprefixed IDs.
- **Extension waits for input:** look for a desktop user-input request. Custom TUI screens cannot be forwarded through Pi RPC.
- **Separate test state:** set `CODAPTER_STATE_DIR` and `CODAPTER_CONFIG_FILE`. Do not delete your real thread registry to troubleshoot a fresh thread.
- **Browser unavailable in an older thread:** start a new thread. Legacy records lack the policy information needed to resume Browser safely.
- **Debugging:** pass `--remote-debugging-port=9233` to the launcher when needed. Logs contain prompts, file contents, and tool output. Do not publish them unredacted.

Native Codex WebSocket proxying, PTY command execution, desktop worktree management, remote plugin installation, and realtime voice are not implemented. Native Pi tools and extensions remain available independently of desktop plugins. See [API mapping](docs/api-mapping.md) for the supported surface.

## License

See [LICENSE](LICENSE).
