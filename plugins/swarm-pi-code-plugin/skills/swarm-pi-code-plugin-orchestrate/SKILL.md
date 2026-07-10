---
name: swarm-pi-code-plugin-orchestrate
description: Run three bounded read-only Pi perspectives from Codex or Claude Code for complex repository analysis, architecture, migration, or risk assessment. Do not use for parallel file modification.
---

# Orchestrate Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Write one self-contained task brief to a temporary file outside the repository.
3. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" orchestrate --host "$HOST" --prompt-file "$PROMPT_FILE" --json`.
4. Delete the prompt file.
5. Reconcile the correctness, architecture/security, and testing/user-experience sections against repository evidence. Present one coherent conclusion and identify disagreements.

All three workers are read-only. Use `$swarm-pi-code-plugin-implement` separately only after an explicit implementation request.
