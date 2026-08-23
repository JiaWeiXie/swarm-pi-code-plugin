---
name: swarm-pi-plan
description: Plan a decision-ready implementation, migration, or architecture change with a read-only Pi planner. Use when requirements and evidence are sufficient; route unresolved research to discover, diff findings to review, and code changes to implement.
compatibility: Requires Node.js 22.19+, local shell command execution, and first-run npm registry access with a writable plugin directory; mutation workflows also require Git.
---

# Plan With Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md).

1. Inspect enough repository context to write a concrete brief with scope,
   alternatives, constraints, observable acceptance criteria, and known user
   decisions. Evidence-poor requirements route to `discover`.
2. Run `$RUNNER plan --host "$HOST" --role planner --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`, adding `--discovery-from <job-id>` only for a verified final-gated DiscoveryResult.
3. Continue every non-terminal result through the control loop. Active Host
   review is limited to eligible public read-only context inside the immutable
   snapshot.
4. Complete only when each proposed step names its repository surface,
   observable verification, dependencies, risk or rollback, and any assumption
   still requiring a user decision.

Preserve citations and unknowns from Host evidence. Implementation is a new
routed request.
