---
name: swarm-pi-code-review
description: Delegate a Git working-tree or branch review to an embedded read-only Pi worker from Codex or Claude Code. Use for bug, security, regression, and missing-test review. Do not use to modify files.
---

# Review With Pi

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Choose `--scope working-tree` for local changes, or `--scope branch --base <ref>` for branch review. Use `auto` only when the intent is unambiguous.
3. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" review --host "$HOST" --scope "$SCOPE" --json` and add `--base` when needed.
4. Verify every finding against the actual diff. Present confirmed findings first by severity with file and line references.

Never treat Pi output as authoritative without host validation.
