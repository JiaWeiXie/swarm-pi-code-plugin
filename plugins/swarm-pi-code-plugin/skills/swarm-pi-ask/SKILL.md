---
name: swarm-pi-ask
description: Delegate one focused repository question, explanation, or evidence check to a read-only Pi scout from Codex or Claude Code. Use for a second grounded analysis pass; use review for diff findings, plan for change design, orchestrate for multiple perspectives, and never use ask for edits.
---

# Ask Pi

Read the [cross-host control protocol](../../references/host-protocol.md) and use its Skill Control Loop.

1. Write one self-contained question with repository scope, required evidence, freshness constraints, and the uncertainty to resolve.
2. Run `$RUNNER ask --host "$HOST" --role scout --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
3. For every non-terminal result, use the control loop. An active Host may resolve only eligible public read-only context within the immutable snapshot; otherwise ask the user.
4. Validate the answer against repository evidence, identify unsupported claims, and report uncertainty or failure plainly.

Keep this workflow read-only. Do not turn the answer into a plan, review, or file change without routing to the matching workflow.
