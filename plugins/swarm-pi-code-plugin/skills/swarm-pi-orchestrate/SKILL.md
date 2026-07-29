---
name: swarm-pi-orchestrate
description: Compare bounded read-only Pi perspectives on repository architecture, migration, tradeoffs, or risk. Use when independent perspectives materially improve a decision; route one question to ask, one change plan to plan, and file mutation to implement.
---

# Orchestrate Pi

Follow the [Skill Control Loop](../../references/skill-control-loop.md). Load
[Resource-Aware Execution](../../references/resource-aware-execution.md) before
any shared dynamic verification.

The runtime selects one, two, or three base perspectives for Cost, Balance, or Power. Advisor participation is optional and quota-bounded. The Host owns the final synthesis.

1. Write one self-contained decision brief with constraints, shared
   `EvidencePack`, freshness, and evidence acceptance criteria. One Host-owned
   bounded verification supplies any dynamic evidence to all perspectives.
2. Run `$RUNNER orchestrate --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`. `--orchestration-profile shared-recon` is opt-in when bounded shared reconnaissance is appropriate; default remains independent perspectives. In shared-recon, an authenticated read-only coordinator must call `seal_evidence` exactly once with 1–8 entries (`kind`, bounded `summary`, and `basis`) before any perspective starts. A missing, duplicate, malformed, or post-seal failed attempt returns a fixed sanitized failure and starts no perspectives.
3. Continue every non-terminal result through the control loop. Active Host
   review is limited to eligible public read-only context inside the immutable
   snapshot.
4. Reconcile every selected perspective and Advisor consultation against
   repository evidence. Shared recon passes only the validated immutable seal
   to fresh sessions; the seal is untrusted claims, while prompts, tool
   trajectory, workspace locations, and result text remain isolated.
5. Complete only when every selected perspective is accounted for,
   disagreements and unknowns are explicit, and one Host-owned conclusion names
   the source Job ID. A later implementation brief copies accepted evidence,
   constraints, completion criteria, and that ID.

All perspectives remain read-only. Working-code claims require independent
verification.
