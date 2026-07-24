---
name: swarm-pi-plan
description: Delegate a decision-ready implementation, migration, or architecture plan to a read-only Pi planner from Codex or Claude Code. Use when requirements and evidence are sufficiently known; route unresolved research or experiments to discover, diff findings to review, and code changes to implement.
---

# Plan With Pi

Read the [cross-host control protocol](../../references/host-protocol.md) and use its Skill Control Loop.

1. Inspect enough repository context to write a concrete brief with scope, alternatives, constraints, acceptance criteria, and known user decisions. Route evidence-poor requirements to `discover` first.
2. Run `$RUNNER plan --host "$HOST" --role planner --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--discovery-from <job-id>` only for a verified final-gated DiscoveryResult.
3. For every non-terminal result, use the control loop. An active Host may resolve only eligible public read-only context within the immutable snapshot; otherwise ask the user.
4. Check the proposal against current code and present decision-complete steps, verification, risks, and explicit assumptions.

Preserve citations and unknowns from Host-provided evidence. Do not invoke implementation from this workflow.
