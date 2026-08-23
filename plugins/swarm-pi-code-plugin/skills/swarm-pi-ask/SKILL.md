---
name: swarm-pi-ask
description: Answer one focused repository question with a read-only Pi scout. Use for a grounded second analysis pass; route diff findings to review, change design to plan, multiple perspectives to orchestrate, and edits to implement.
compatibility: Requires Node.js 22.19+, local shell command execution, and first-run npm registry access with a writable plugin directory; mutation workflows also require Git.
---

# Ask Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md).

1. Frame one self-contained question with repository scope, required evidence,
   freshness, and the exact uncertainty to resolve.
2. Run `$RUNNER ask --host "$HOST" --role scout --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
3. Continue every non-terminal result through the control loop. Active Host
   review is limited to eligible public read-only context inside the immutable
   snapshot.
4. Complete only when every material claim is tied to repository evidence or
   marked unsupported, unknown, or failed.

This workflow is read-only. A later plan, review, or edit is a new routed
request.
