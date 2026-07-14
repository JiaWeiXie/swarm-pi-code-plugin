---
name: swarm-pi-review
description: Delegate a read-only Git working-tree or branch review to Pi from Codex or Claude Code. Use for actionable bug, security, regression, and missing-test findings tied to a diff; use ask for a focused question, orchestrate for broader risk analysis, and never modify files in review.
---

# Review With Pi

Read and follow the [cross-host control protocol](../../references/host-protocol.md), including pending-notification review, bounded waits, adjudication context, terminal acknowledgement, and cleanup.

1. Select `--scope working-tree` for local changes or `--scope branch --base <ref>` for a branch. Use `auto` only when the intended diff is unambiguous.
2. Run `$RUNNER review --host "$HOST" --role reviewer --scope "$SCOPE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--base` when required.
3. Retain the Job ID after `approval-required`, Host Assistance, or `wait-timed-out`; continue bounded `$RUNNER jobs wait --job <id> --wait-timeout-ms 15000 --json` calls. Inspect the full WorkerAssessment, trusted runtime `effectAssessment`, and adjudication context. Treat runtime effects as authoritative and Worker prose as advisory. An active Host may resolve only eligible public read-only context within the immutable snapshot; otherwise ask the user.
4. Verify every finding against the actual diff. Present only confirmed findings, ordered by severity, with tight file and line references; state when no actionable finding remains.

Treat Pi output as evidence to validate, not as authoritative review. Keep the workflow read-only.
