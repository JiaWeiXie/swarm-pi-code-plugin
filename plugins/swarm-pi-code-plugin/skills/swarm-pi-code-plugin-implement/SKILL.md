---
name: swarm-pi-code-plugin-implement
description: Delegate an explicit scoped file change, fix, or refactor to Pi from Codex or Claude Code. Use only for approved mutation intent; route new projects to scaffold and project-local tooling to setup.
---

# Implement With Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Confirm explicit mutation intent. Do not hide, stash, discard, or commit user changes; route non-Git new-project work to scaffold.
2. Write task, scope, acceptance criteria, and prohibited actions to a temporary prompt file.
3. Run `$RUNNER implement --host "$HOST" --role executor --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`.
4. Use background only for an explicitly requested, project-enabled `mechanical-executor`; all other implementation stays supervised.
5. Do not mutate the same worktree while Pi runs. Inspect the actual diff, changed files, `runtimeSideEffects`, verification, and artifact before delivery.
6. Safe-dirty generated files do not block. For exit code `5`, present `isolated-head` and `isolated-snapshot`: HEAD omits local changes; snapshot delivery remains isolated.

Run host-owned verification. Never commit, merge, push, or integrate an artifact marked `deliverable: false`.
