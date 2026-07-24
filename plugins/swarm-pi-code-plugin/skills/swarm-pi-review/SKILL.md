---
name: swarm-pi-review
description: Delegate a read-only Git working-tree or branch review to Pi from Codex or Claude Code. Use standard review for actionable bug, security, regression, and missing-test findings; use lean review for simplification, over-engineering, reusable capability, stdlib/native replacement, or deletable code tied to a diff. Use ask for a focused question, orchestrate for broader risk analysis, and never modify files in review.
---

# Review With Pi

Read the [cross-host control protocol](../../references/host-protocol.md) and use its Skill Control Loop.

1. Select `--scope working-tree` for local changes or `--scope branch --base <ref>` for a branch. Use `auto` only when the intended diff is unambiguous.
2. Set `$PROFILE=lean` for simplify, over-engineering, deletion, reuse, stdlib, native-platform, YAGNI, clarify, or shrink requests; otherwise set `$PROFILE=standard`.
3. Run `$RUNNER review --host "$HOST" --role reviewer --scope "$SCOPE" --review-profile "$PROFILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--base` when required.
4. For `lean`, expect three concurrent candidate perspectives followed by independent validators (at most six candidates and three concurrent validators). Report only `supported` simplifications; do not claim `Lean already. Ship.` while validation is inconclusive.
5. For every non-terminal result, use the control loop. An active Host may resolve only eligible public read-only context within the immutable snapshot; otherwise ask the user.
6. Verify every finding against the actual diff. Present only confirmed findings, ordered by severity, with tight file and line references; state when no actionable finding remains.

Treat Pi output as evidence to validate, not as authoritative review. Keep the workflow read-only.
