---
name: swarm-pi-code-plugin-orchestrate
description: Run three bounded read-only Pi perspectives from Codex or Claude Code for complex repository analysis, architecture, migration, or risk assessment. Do not use for parallel file modification.
---

# Orchestrate Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `jobs list --pending-notifications --json`. Present pending terminal results and acknowledge each only after adding it to the response being prepared.
3. Write one self-contained task brief to a temporary file outside the repository.
4. Default to `--execution-mode supervised`. Use `background` only when explicitly requested and a relay/watcher agent is available; otherwise explain the fallback to `supervised`.
5. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" orchestrate --host "$HOST" --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --json`.
6. If accepted in background, have the watcher run `jobs wait --job <id> --json`. Present the terminal result and run `jobs acknowledge --job <id> --json`.
7. Delete the prompt file and reconcile all three perspectives against repository evidence. Present one coherent conclusion and identify disagreements.

All three workers are read-only. Use `$swarm-pi-code-plugin-implement` separately only after an explicit implementation request.
