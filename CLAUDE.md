# Repository instructions for AI coding agents

This repository treats documentation as part of the product change. Preserve unrelated dirty worktree changes and do not reset, stash, discard, commit, push, or install external tooling without explicit scope.

After changing functional code, run `mise run docs-check`. A failure means the work is incomplete: update both `README.md` and `README.zh-TW.md`, then update the focused reference required by the report.

For Configuration changes, inspect the Web implementation and `docs/configuration.md` together. Changes to `src/web/ui.ts` require updating one of the six current setup screenshots, unless a deliberate `Screenshot-Impact: reviewed-current` declaration with a meaningful reason is recorded.

Before delivery, stage only the intended files and run `mise run docs-check-staged`. In the final summary, report the checker command and result, documentation files changed, screenshot files changed or reviewed-current, and the relevant targeted verification.

Before and after any release version bump, use `mise run version-check-installed`. Run releases through `mise run version-bump -- <patch|minor|major|X.Y.Z>`; it reinstalls the local Codex plugin before and after synchronization so the installed manifest receives the new version value. Keep both Claude and Codex manifests free of a `hooks` field because Claude Code automatically loads `hooks/hooks.json`.

The repository pre-commit hook is advisory for humans. Treat its documentation-impact failure report as required work even though the hook exits successfully.

Use the Conventional Commits format for every commit. Start messages with a valid type such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:`, or `revert:`; add a scope when useful (for example, `docs(configuration): ...`). Keep the subject imperative and concise, and use a breaking-change marker (`!` or a `BREAKING CHANGE:` footer) when applicable.

When a command may build, compile, run a full test suite, launch a browser, or recurse through a task runner, inspect its scripts first and run the smallest relevant verification sequentially. Do not invent concurrency flags.
