---
name: swarm-pi-code-plugin-implement
description: Delegate an explicit scoped request to add, fix, change, or refactor files to an embedded Pi worker from Codex or Claude Code. Use only for clear mutation intent and a clean worktree. Do not use for questions, planning, review, commits, or pushes.
---

# Implement With Pi

1. Confirm explicit mutation intent and inspect `git status`. Do not hide, stash, or discard user changes.
2. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
3. Run `jobs list --pending-notifications --json`. Present pending terminal results and acknowledge each only after adding it to the response being prepared.
4. Write the exact task, scope, acceptance criteria, and prohibited actions to a temporary file outside the repository.
5. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" implement --host "$HOST" --prompt-file "$PROMPT_FILE" --execution-mode supervised --json`. Background implementation is prohibited.
6. While Pi is running, do not mutate the same worktree from the main session. Delete the prompt file, inspect every changed file, the actual Git diff, and any `runtimeSideEffects` entries.
7. Run repository verification from the host. Lenient mode may let Pi run sandboxed commands, but the host still owns verification and the result remains `not-run` until the host verifies it.
8. On failure, timeout, or cancellation, assume partial worktree changes may remain; inspect them instead of rolling them back automatically. Present the terminal result, run `jobs acknowledge --job <id> --json`, then report model/fallback, changed files, side effects, checks, and risks.

Never commit, push, switch branches, or start another mutating worker on a dirty worktree.
