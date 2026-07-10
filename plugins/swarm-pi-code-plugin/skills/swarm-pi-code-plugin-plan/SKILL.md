---
name: swarm-pi-code-plugin-plan
description: Delegate an implementation, migration, or architecture plan to an embedded read-only Pi worker from Codex or Claude Code. Use when the user wants planning rather than code changes.
---

# Plan With Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Inspect enough repository context to write a concrete planning brief, then save it to a temporary file outside the repository.
3. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" plan --host "$HOST" --prompt-file "$PROMPT_FILE" --json`.
4. Delete the prompt file, validate the proposal against current code, and refine it before presenting the plan.

Do not invoke `implement` from this skill.
