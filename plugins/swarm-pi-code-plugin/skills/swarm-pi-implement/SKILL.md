---
name: swarm-pi-implement
description: Delegate an explicitly authorized, scoped change, fix, or refactor in an existing repository to Pi from Codex or Claude Code. Use for approved file mutation; use scaffold for a new project, setup for project-local tooling, plan for design only, and never infer delivery, commit, or push permission.
---

# Implement With Pi

Read and follow the [cross-host control protocol](../../references/host-protocol.md), including pending-notification review, temporary prompt handling, bounded waits, adjudication, terminal acknowledgement, and cleanup.

1. Confirm explicit mutation intent. Preserve user changes; never stash, discard, commit, or hide them. Route non-Git new-project work to scaffold.
2. Write scope, acceptance criteria, prohibited actions, and a resource-aware verification plan to a temporary prompt file. Inspect indirect scripts and run expensive build or test stages sequentially with only verified concurrency controls.
3. Run `$RUNNER implement --host "$HOST" --role executor --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`.
4. Retain the Job ID after `approval-required`, Host Assistance, Human Decision, or `wait-timed-out`; continue bounded `$RUNNER jobs wait --job <id> --wait-timeout-ms 15000 --json` calls. Inspect the full WorkerAssessment, trusted runtime `effectAssessment`, and adjudication context. Treat runtime effects as authoritative and Worker prose as advisory. Allow only an exact, in-scope, reversible action covered by the original mutation intent; Strict mode, deletion, Git metadata, workspace escape, and delivery require the user.
5. Use background only for an explicitly requested, project-enabled `mechanical-executor`. Do not mutate the same worktree while Pi runs.
6. Inspect the actual diff, changed files, `runtimeSideEffects`, verification, and artifact. For exit code `5`, present `isolated-head` and `isolated-snapshot`; never choose for the user. A `workspace-unborn-head` response is fail-fast and must route to scaffold or approved adoption before resume.
7. For a safe-dirty job-owned worktree, show the verified artifact diff and obtain explicit delivery approval before `$RUNNER jobs materialize --job <id> --json`. Materialization applies changes without committing them.
8. Start an `ActionRecommendation` only after explicit user confirmation with `$RUNNER jobs action-start --job <parent> --request <id> --json`; never retry an `unknown` external outcome automatically.
9. Run targeted host-owned verification before broader checks. Never commit, merge, push, or integrate an artifact marked `deliverable: false`.

Keep Host Assistance correlated and consume-once. Never let an assistance bundle, WorkerAssessment, or recommendation expand policy or intent.
