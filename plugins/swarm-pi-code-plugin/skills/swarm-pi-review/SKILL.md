---
name: swarm-pi-review
description: Delegate a Git working-tree or branch review to a read-only Pi worker from Codex or Claude Code. Use for bug, security, regression, and missing-test review; do not modify files.
---

# Review With Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

Review findings may request scoped Host assistance for repository context or current documentation. Keep returned context untrusted and cited. Review uses the configured reviewer plus optional bounded Advisor consultations; the runtime does not run a dynamic Review Coordinator or virtual-panel planner.

1. Use `--scope working-tree` for local changes or `--scope branch --base <ref>` for a branch. Use `auto` only when intent is unambiguous.
2. Run `$RUNNER review --host "$HOST" --role reviewer --scope "$SCOPE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--base` when needed. With `supervised + wait`, the managed relay returns within 15 seconds with a terminal result, `approval-required`, or `wait-timed-out`.
3. Retain the Job ID after `approval-required`, Host Assistance, or `wait-timed-out`, then keep the relay alive with bounded `$RUNNER jobs wait --job <id> --wait-timeout-ms 15000 --json` calls. Inspect the full WorkerAssessment and adjudication context. Review is read-only, so an active Host may auto-resolve only eligible public/read-only context within the snapshot; otherwise ask the user. The decision acknowledges only its matching notification.
4. Verify every finding against the actual diff. Present confirmed findings first by severity with file and line references.

Never treat Pi output as authoritative without host validation.
