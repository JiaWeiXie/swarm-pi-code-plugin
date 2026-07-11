---
name: swarm-pi-code-plugin-plan
description: Delegate an implementation, migration, or architecture plan to a read-only Pi worker from Codex or Claude Code. Use when the user wants a plan rather than code changes.
---

# Plan With Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Inspect enough repository context to write a concrete brief with scope, alternatives, constraints, and acceptance criteria.
2. Run `$RUNNER plan --host "$HOST" --role planner --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
3. For a background job, keep the watcher active with `$RUNNER jobs wait --job <id> --json`.
4. Check the proposal against current code, refine it, and present decision-ready steps.

Do not invoke implementation from this workflow.
