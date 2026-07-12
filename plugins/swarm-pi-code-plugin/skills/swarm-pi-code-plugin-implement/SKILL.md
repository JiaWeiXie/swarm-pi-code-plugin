---
name: swarm-pi-code-plugin-implement
description: Delegate an explicit scoped file change, fix, or refactor to Pi from Codex or Claude Code. Use only for approved mutation intent; route new projects to scaffold and project-local tooling to setup.
---

# Implement With Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Confirm explicit mutation intent. Do not hide, stash, discard, or commit user changes; route non-Git new-project work to scaffold.
2. Write task, scope, acceptance criteria, and prohibited actions to a temporary prompt file.
3. Run `$RUNNER implement --host "$HOST" --role executor --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`. With `--approval-mode wait`, the managed relay returns within 15 seconds instead of blocking the Host shell.
4. Retain the Job ID after `approval-required` or `wait-timed-out`, then poll with `jobs wait --wait-timeout-ms 15000 --job <job-id> --json` until terminal. Present the exact tool, action, risk, capabilities, reason, and expiry before asking for approve or deny. Never auto-approve; each decision acknowledges only its matching approval notification.
5. Use background only for an explicitly requested, project-enabled `mechanical-executor`; all other implementation stays supervised. Do not mutate the same worktree while Pi runs.
6. Inspect the actual diff, changed files, `runtimeSideEffects`, verification, and artifact before delivery. Safe-dirty generated files do not block. For exit code `5`, present `isolated-head` and `isolated-snapshot`: HEAD omits local changes; snapshot delivery remains isolated.
7. A `workspace-unborn-head` response is fail-fast: no model ran. Preserve its continuation, route an empty workspace to scaffold or existing content to adoption, then resume after the user-approved repair.
8. Safe-dirty `auto` execution uses a job-owned worktree. After verification, show the artifact diff and request explicit delivery approval before `$RUNNER jobs materialize --job <id> --json`; materialization applies changes without committing them.

Run host-owned verification. Never commit, merge, push, or integrate an artifact marked `deliverable: false`.
