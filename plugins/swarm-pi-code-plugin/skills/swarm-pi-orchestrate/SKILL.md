---
name: swarm-pi-orchestrate
description: Run a bounded read-only Pi panel for complex repository architecture, migration, tradeoff, or risk analysis from Codex or Claude Code. Use when multiple independent perspectives materially improve a decision; use ask for one focused question, plan for one change plan, and never use orchestrate for file modification.
---

# Orchestrate Pi

Read and follow the [cross-host control protocol](../../references/host-protocol.md), including pending-notification review, temporary evidence handling, bounded waits, adjudication context, terminal acknowledgement, and cleanup.

The runtime selects one, two, or three base perspectives for Cost, Balance, or Power. Advisor participation is optional and quota-bounded. The Host owns the final synthesis.

1. Write one self-contained decision brief with constraints, a shared EvidencePack, freshness requirements, and evidence acceptance criteria. Perspectives must not independently repeat expensive full builds or test suites; when dynamic evidence is needed, have the Host run one resource-aware bounded verification and share it.
2. Run `$RUNNER orchestrate --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
3. Retain the Job ID after `approval-required`, Host Assistance, or `wait-timed-out`; continue bounded `$RUNNER jobs wait --job <id> --wait-timeout-ms 15000 --json` calls. Inspect the full WorkerAssessment and adjudication context. An active Host may resolve only eligible public read-only context within the immutable snapshot; otherwise ask the user.
4. Reconcile every selected perspective and Advisor consultation against repository evidence. Identify disagreements, failures, and unknowns; present one Host-owned conclusion with the source job ID.
5. If the user later authorizes implementation, copy accepted evidence, constraints, done criteria, and the source job ID into a new implementation brief.

Keep all perspectives read-only. Do not describe unvalidated inline code as working code.
