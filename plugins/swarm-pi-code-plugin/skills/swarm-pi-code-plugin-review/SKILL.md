---
name: swarm-pi-code-plugin-review
description: Delegate a Git working-tree or branch review to an embedded read-only Pi worker from Codex or Claude Code. Use for bug, security, regression, and missing-test review. Do not use to modify files.
---

# Review With Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `jobs list --pending-notifications --json`. Present pending terminal results and acknowledge each only after adding it to the response being prepared.
3. Choose `--scope working-tree` for local changes, or `--scope branch --base <ref>` for branch review. Use `auto` only when the intent is unambiguous.
4. Default to `--execution-mode supervised`. Use `background` only when explicitly requested and a relay/watcher agent is available; otherwise explain the fallback to `supervised`.
5. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" review --host "$HOST" --scope "$SCOPE" --execution-mode "$EXECUTION_MODE" --json` and add `--base` when needed.
6. If accepted in background, have the watcher run `jobs wait --job <id> --json`. Present the terminal result and run `jobs acknowledge --job <id> --json`.
7. Verify every finding against the actual diff. Present confirmed findings first by severity with file and line references.

Never treat Pi output as authoritative without host validation.
