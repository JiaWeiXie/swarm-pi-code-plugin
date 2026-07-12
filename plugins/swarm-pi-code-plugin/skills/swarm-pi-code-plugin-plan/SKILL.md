---
name: swarm-pi-code-plugin-plan
description: Delegate an implementation, migration, or architecture plan to a read-only Pi worker from Codex or Claude Code. Use when the user wants a plan rather than code changes.
---

# Plan With Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Inspect enough repository context to write a concrete brief with scope, alternatives, constraints, and acceptance criteria.
2. Run `$RUNNER plan --host "$HOST" --role planner --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`. With `supervised + wait`, the managed relay returns within 15 seconds with a terminal result, `approval-required`, or `wait-timed-out`.
3. Retain the Job ID after `approval-required` or `wait-timed-out`, then keep the relay alive with bounded `$RUNNER jobs wait --job <id> --wait-timeout-ms 15000 --json` calls. Present approvals before asking for approve or deny; never auto-approve. The decision acknowledges only its matching approval notification.
4. Check the proposal against current code, refine it, and present decision-ready steps.

Do not invoke implementation from this workflow.
