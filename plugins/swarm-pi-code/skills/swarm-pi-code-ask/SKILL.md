---
name: swarm-pi-code-ask
description: Delegate a focused codebase question, explanation, or read-only analysis to an embedded Pi worker from Codex or Claude Code. Use when a second repository-grounded analysis pass is useful. Do not use for edits.
---

# Ask Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Write the exact question and necessary constraints to a temporary file outside the repository using a host file-writing tool.
3. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" ask --host "$HOST" --prompt-file "$PROMPT_FILE" --json`.
4. Delete the prompt file.
5. Validate the output against repository evidence and answer in the host's normal voice. State clearly if Pi failed or no model is configured.

Pi is read-only for this workflow.
