---
name: swarm-pi-code-plugin-orchestrate
description: Run three bounded read-only Pi perspectives for complex repository analysis, architecture, migration, or risk assessment from Codex or Claude Code. Do not use for file modification.
---

# Orchestrate Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Decide whether the task depends on external facts. If it does, have the Host gather one cited EvidencePack first; include URLs, retrieval date, verified claims, unknowns, and version constraints.
2. Write one self-contained brief that names the decision, constraints, shared EvidencePack, and evidence required. The persisted job result is the durable handoff.
3. Run `$RUNNER orchestrate --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
4. For a background job, poll with bounded `jobs wait` calls and report the durable job phase; do not leave one opaque shell command running.
5. Reconcile all three perspectives against repository evidence, identify disagreements, and present one coherent conclusion with the source job ID.
6. If implementation is the accepted next step, copy the accepted evidence, constraints, done criteria, and source job ID into the implementation brief. Do not ask the user to choose an internal role.

All perspectives are read-only. Start implementation only after explicit mutation intent. Do not describe long inline code as working code unless the Host validates it with the relevant parser, typecheck, or test.
