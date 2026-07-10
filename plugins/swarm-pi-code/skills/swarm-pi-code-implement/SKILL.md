---
name: swarm-pi-code-implement
description: Delegate an explicit scoped request to add, fix, change, or refactor files to an embedded Pi worker from Codex or Claude Code. Use only for clear mutation intent and a clean worktree. Do not use for questions, planning, review, commits, or pushes.
---

# Implement With Pi

1. Confirm explicit mutation intent and inspect `git status`. Do not hide, stash, or discard user changes.
2. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
3. Write the exact task, scope, acceptance criteria, and prohibited actions to a temporary file outside the repository.
4. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" implement --host "$HOST" --prompt-file "$PROMPT_FILE" --json`.
5. Delete the prompt file. Inspect every changed file and the actual Git diff.
6. Run repository verification from the host, because Pi has no shell tool and reports verification as `not-run`.
7. Fix any issues and report model/fallback, changed files, checks, and risks.

Never commit, push, switch branches, or start another mutating worker on a dirty worktree.
