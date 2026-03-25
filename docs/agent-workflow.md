# Agent Workflow Notes

This file holds repo-specific details that do not belong in the top-level `AGENTS.md`.

## Testing Expectations

- Run `npm install` to install dependencies.
- Run `npm test` for functional changes.
- Run `npm run build` if you touch the CLI, exports, or public API signatures.
- Run `npm run lint` to check formatting and lint rules.
- Run `npm run check` to run build + lint + test together.

## GUI Debugging

- Checked-in launcher scripts live at `scripts/codapter.sh` and `scripts/codex.sh`.
- `scripts/codapter.sh` launches Codex Desktop against `dist/codapter.mjs`, enables collab, preserves the JSONL debug log, and writes stdio traffic to `/tmp/codapter-stdio.log`.
- `scripts/codex.sh` launches the native Codex backend through the same stdio tap and writes traffic to `/tmp/codapter-codex-stdio.log`.
- Both launchers enable Electron remote debugging on port `9222`.
- Before Pi GUI repros, clear persisted thread state with `rm -f ~/.local/share/codapter/threads.json` when old threads are polluting the sidebar.
- When reproducing Pi sub-agent flows in the GUI, switch the model picker to `Claude Opus 4.6` before sending the prompt. `Claude Haiku 3.5` has produced misleading failures in this setup.
- Compare `/tmp/codapter-stdio.log` against `/tmp/codapter-codex-stdio.log` first when native Codex and Pi diverge. Use `/tmp/codapter.jsonl` for app-server-level debug events from Codapter.
- Stop the GUI between backend switches so the next run binds cleanly to the remote debugging port and starts with fresh logs.

## Local `Codex - Pi` Setup

- Local desktop launcher: `/home/igorw/.local/bin/codex-desktop-pi`.
- That launcher is intentionally Pi-only for this machine:
  - `CODAPTER_CODEX_DISABLE=1`
  - `CODAPTER_PI_MODEL_ALLOWLIST="openai-codex/*,zai/glm-*"`
- Debug logging is disabled by default. Enable it only when needed, for example:

  ```bash
  CODAPTER_DEBUG_LOG_FILE=/tmp/codapter-pi.jsonl /home/igorw/.local/bin/codex-desktop-pi
  ```

- Pi auth currently comes from `~/.pi/agent/auth.json`.
- Local model visibility was trimmed to keep `openai-codex` and `zai`; `opencode` was removed to avoid extra model families in the picker.
- Codapter was locally patched so the Pi backend honors `CODAPTER_PI_MODEL_ALLOWLIST` during `model/list`, while still exposing stored ChatGPT auth state to keep the Codex Desktop model picker enabled even with the native Codex backend disabled.

## Changelog Rules

Location: `CHANGELOG.md`.

Under `## [Unreleased]`, use:
- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

Rules:
- New entries always go under `## [Unreleased]`.
- Append to existing subsections; do not create duplicates.
- Never modify released sections.
- Use inline PR links: `([#123](<pr-url>))`.

Attribution:
- Internal: `Fixed foo bar ([#123](<pr-url>))`
- External: `Added feature X ([#456](<pr-url>) by [@user](https://github.com/user))`

## Release Notes

### During Development

Open the PR first, then update `CHANGELOG.md` under `## [Unreleased]` with that PR number and push a follow-up commit.

### When Ready to Release

1. `git checkout main && git pull`
2. Verify `## [Unreleased]` includes all changes.
3. Run one of:

   ```bash
   node scripts/release.mjs patch
   node scripts/release.mjs minor
   node scripts/release.mjs major
   ```

Notes:
- Requires the `gh` CLI and an authenticated GitHub session.
- Script expects a clean working tree, bumps version files, updates `CHANGELOG.md`, tags `vX.Y.Z`, pushes, and creates a prerelease.
