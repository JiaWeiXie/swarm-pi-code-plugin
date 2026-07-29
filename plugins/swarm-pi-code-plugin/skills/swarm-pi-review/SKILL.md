---
name: swarm-pi-review
description: Review a Git working tree or branch with read-only Pi workers. Use standard for bugs, security, regressions, and missing tests; use lean for diff-bound simplification, deletion, reuse, YAGNI, or native replacements. Route one question to ask and broader risk analysis to orchestrate.
---

# Review With Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md).

1. Select `--scope working-tree` for local changes or `--scope branch --base <ref>` for a branch. Use `auto` only when the intended diff is unambiguous.
2. Set `$PROFILE=lean` for simplify, over-engineering, deletion, reuse, stdlib, native-platform, YAGNI, clarify, or shrink requests; otherwise set `$PROFILE=standard`.
3. Run `$RUNNER review --host "$HOST" --role reviewer --scope "$SCOPE" --review-profile "$PROFILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--base` when required.
4. For `lean`, require three candidate perspectives followed by independent
   validation of at most six candidates with at most three concurrent
   validators. Publish only `supported` simplifications; inconclusive validation
   cannot produce `Lean already. Ship.`.
5. Continue every non-terminal result through the control loop. Active Host
   review is limited to eligible public read-only context inside the immutable
   snapshot.
6. Complete only when every published finding is confirmed in the actual diff
   and includes impact, tight file and line evidence, the failure or complexity
   scenario, and the smallest safe fix or verification. State explicitly when
   no actionable finding remains.

Pi output is evidence to validate. The workflow remains read-only.
