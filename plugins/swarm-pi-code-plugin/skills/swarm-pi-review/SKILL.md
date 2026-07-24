---
name: swarm-pi-review
description: Delegate a read-only Git working-tree or branch review to Pi from Codex or Claude Code. Use for actionable bug, security, regression, and missing-test findings tied to a diff; use ask for a focused question, orchestrate for broader risk analysis, and never modify files in review.
---

# Review With Pi

Read the [cross-host control protocol](../../references/host-protocol.md) and use its Skill Control Loop.

1. Select `--scope working-tree` for local changes or `--scope branch --base <ref>` for a branch. Use `auto` only when the intended diff is unambiguous.
2. Run `$RUNNER review --host "$HOST" --role reviewer --scope "$SCOPE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--base` when required.
3. For every non-terminal result, use the control loop. An active Host may resolve only eligible public read-only context within the immutable snapshot; otherwise ask the user.
4. Verify every finding against the actual diff. Present only confirmed findings, ordered by severity, with tight file and line references; state when no actionable finding remains.

Treat Pi output as evidence to validate, not as authoritative review. Keep the workflow read-only.
