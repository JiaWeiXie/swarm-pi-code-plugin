---
name: swarm-pi-code-plugin-ask
description: Delegate a focused codebase question, explanation, or read-only analysis to an embedded Pi worker from Codex or Claude Code. Use when a second repository-grounded analysis pass is useful. Do not use for edits.
---

# Ask Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `jobs list --pending-notifications --json`. Present any pending terminal results and run `jobs acknowledge --job <id> --json` only after including each result in the response being prepared.
3. Write the exact question and necessary constraints to a temporary file outside the repository using a host file-writing tool.
4. Default to `--execution-mode supervised`. If the user explicitly requests background execution and the host can create a relay/watcher agent, use `background`; otherwise state that background supervision is unavailable and fall back to `supervised`.
5. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" ask --host "$HOST" --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --json`.
6. For an accepted background job, have the watcher run `jobs wait --job <id> --json`. For either mode, present the terminal result, then run `jobs acknowledge --job <id> --json`.
7. Delete the prompt file, validate the output against repository evidence, and answer in the host's normal voice. State clearly if Pi failed or no model is configured.

Pi is read-only for this workflow.
