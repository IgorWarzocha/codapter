# Desktop integration checks

Use these checks to distinguish adapter failures from model choices and desktop-only features. Never patch the installed app or disable native Pi extensions to make a scenario pass.

## Automated checks

`npm run check` builds the distribution, checks lint, and runs deterministic protocol and lifecycle tests. The subprocess fixtures are controlled test doubles, not proof of installed-provider compatibility.

`npm run test:live` runs the built CLI against installed Pi, using **Luna 6 with low reasoning**. It reads a fresh token through a native execution tool, checks turn completion, forks, and resumes after a process restart. The test isolates adapter storage while preserving HOME, Pi authentication, wrappers, extensions, and prompts.

Do not use Pi's default model or reasoning level for model-backed tests. For native Codex comparison tests, also select `gpt-6-luna` and low reasoning explicitly. If that model is unavailable, stop rather than substitute another.

## Isolated desktop run

Build before launching, and quit an existing desktop instance before switching backends. Do not kill unrelated desktop processes or delete the user's registry.

```sh
npm run build:dist
export CODAPTER_STATE_DIR="$(mktemp -d /tmp/codapter-gui.XXXXXX)"
export CODAPTER_CONFIG_FILE="$CODAPTER_STATE_DIR/config.toml"
export TAP_LOG="$CODAPTER_STATE_DIR/stdio.log"
export CODAPTER_DEBUG_LOG_FILE="$CODAPTER_STATE_DIR/debug.jsonl"
export CODAPTER_CODEX_DISABLE=1
export CODAPTER_PI_ARGS='["--mode","rpc","--provider","openai-codex","--model","gpt-6-luna","--thinking","low"]'
printf 'model = "pi::openai-codex/gpt-6-luna"\nmodel_reasoning_effort = "low"\n' > "$CODAPTER_CONFIG_FILE"
./scripts/codapter.sh --remote-debugging-port=9233
```

Choose **pi / GPT-6 Luna** and **Light** in the installed desktop picker. Confirm the wire request says `pi::openai-codex/gpt-6-luna` with `low`; UI labels alone are not proof.

The launcher accepts desktop flags unchanged. If the local graphics stack requires an Ozone platform flag, pass it to this invocation rather than changing the adapter protocol.

DevTools lists targets at `http://127.0.0.1:9233/json/list`. Inspect the main `app://-/index.html` page, not the hidden avatar-overlay target or a sandbox webview. Close the test app when done. Keep raw logs private because they contain prompts, tool data, and possibly credentials.

## Scenarios

| Scenario | Decisive evidence |
| --- | --- |
| Boot and model selection | Successful `initialize` with `codexHome`, a populated model picker, and the intended Pi model selected |
| Native execution | Ask Pi to read a random token file. A command item appears and the final answer contains the token, which was not included in the prompt |
| Installed `pi-ask` | Ask one multiple-choice question through the installed tool. Answer its choice and optional comment in the GUI. Pi must receive both answers before completing |
| Follow-up | A second prompt stays in the same thread and does not fail with stale active-turn state |
| Resume | Quit and relaunch with the same isolated state directory. Reopening the thread restores one copy of each input and result |
| Fork | A new thread preserves history without changing the original. Pi cloning covers the active branch, not an arbitrary desktop message anchor |
| Interrupt | Interrupt a running tool turn. Pi stops and the thread accepts a subsequent turn |
| File changes | In a disposable workspace, change one line and compare the real file with the rendered change item. Code-mode tools may report nested effects differently from direct Pi edit tools |

The 2026-10-01 compatibility check used Pi 0.99.2, native Codex CLI 0.159.3, and ChatGPT Desktop 26.928.31416 on Linux. The built-CLI live test passed. The desktop test completed native execution, both `pi-ask` dialogs, and a final Luna 6 response at low reasoning. Native Codex inference was not part of that check.

Custom terminal UI, themes, widgets, and keybindings are not representable in Pi RPC. Do not treat their absence as an adapter regression or claim that GUI skills/plugin inventories manage Pi extensions.

## Native comparison

`scripts/codex.sh` uses the same stdio tap with native Codex. For a routed Codex run, enable the Codex backend and select the unprefixed Luna 6 model. Keep each run's logs in a separate directory. Match the prompt, model, reasoning effort, workspace, and tool-call choices before attributing differences to Codapter.

Adapter-managed collaboration is opt-in through `CODAPTER_COLLAB=1`. Test it separately from native Pi sub-agent extensions. For child-thread comparisons, record the chosen model, effort, fork-context choice, agent type, child prompt, and completion status. Explicitly constrain every child to Luna 6 low. Do not start an unconstrained model-selected child during a test.

Useful child scenarios include opening a child while it is active, reopening after completion, sending follow-up input, and ensuring the parent does not duplicate the child's answer. Pi-to-Codex collaboration is supported by the adapter extension. The reverse direction is not.

## Evidence and comparison

Capture the selected model and effort, exact prompt, desktop version, matching stdio lines, relevant native session path, and a screenshot when rendering differs. `thread/read` provides the thread's native session path; inspect that file rather than scanning all sessions.

```sh
npm run gui:audit:collect -- \
  --scenario routed-pi \
  --artifact-dir /tmp/codapter-gui-audit \
  --stdio-log "$TAP_LOG" \
  --debug-log "$CODAPTER_DEBUG_LOG_FILE"

npm run gui:audit:compare -- \
  --baseline /path/to/native/summary.json \
  --candidate /path/to/routed/summary.json
```

The collector writes normalized `summary.json`, input `metadata.json`, and copied logs under `raw/`. `summary.json.visible` is a focused parent/child digest. `--session-log /exact/path.jsonl` adds native Codex transcript summaries and can be repeated for parent and child.

Compare the normalized summaries first, then raw protocol messages, native session events, and the visible UI. A fixture derived from a failure protects the adapter's translation, but only a real integration check establishes compatibility with the installed provider.
