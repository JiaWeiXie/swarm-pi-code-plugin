---
name: swarm-pi-code-plugin-orchestrate
description: Run three bounded read-only Pi perspectives for complex repository analysis, architecture, migration, or risk assessment from Codex or Claude Code. Do not use for file modification.
---

# Orchestrate Pi

Read the [cross-host control protocol](../references/host-protocol.md).

1. Write one self-contained brief that names the decision, constraints, and evidence required.
2. Run `$RUNNER orchestrate --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`.
3. For a background job, keep the watcher active with `$RUNNER jobs wait --job <id> --json`.
4. Reconcile all three perspectives against repository evidence, identify disagreements, and present one coherent conclusion.

All perspectives are read-only. Start implementation only through an explicit implementation workflow.
