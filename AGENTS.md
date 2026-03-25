# Agent Onboarding (Codapter)

Keep this file short. Put details in `docs/*.md`.

## Read First

- `README.md` for project purpose and CLI usage.
- `docs/architecture.md` and `docs/api-mapping.md` for internals.
- `docs/agent-workflow.md` for repo-specific workflow, local setup, changelog, and release notes.

## Repo Basics

- TypeScript, ESM, NodeNext.
- Workspaces: `packages/core`, `packages/cli`, `packages/backend-pi`, `packages/backend-codex`.
- Formatting/linting: Biome (`biome.json`).
- Keep edits ASCII-only unless a file already uses Unicode.

## Working Style

- Prefer small, focused changes.
- Keep changed LoC to an absolute minimum for easier upstream review and merging.
- Avoid unrelated cleanup in the same patch.
- Match existing file layout and naming.

## Validation

- Run `npm test` for functional changes.
- Run `npm run build` if you touch CLI, exports, or public API signatures.
- Run `npm run lint` before finishing.
- If practical, run `npm run check`.
- If you cannot run a check, say so explicitly.
