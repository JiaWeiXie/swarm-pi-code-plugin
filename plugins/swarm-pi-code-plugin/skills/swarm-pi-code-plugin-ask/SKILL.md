---
name: swarm-pi-code-plugin-ask
description: Delegate a focused repository question, explanation, or read-only analysis to Pi from Codex or Claude Code. Use for a second evidence-grounded analysis pass; do not use for edits, plans, or reviews.
---

# Ask Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Write one self-contained question with the repository scope and evidence required to answer it.
2. Run `$RUNNER ask --host "$HOST" --role scout --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
3. For a background job, keep the watcher active with `$RUNNER jobs wait --job <id> --json`.
4. Check the answer against repository evidence and report uncertainty or failure plainly.

This workflow is read-only.
