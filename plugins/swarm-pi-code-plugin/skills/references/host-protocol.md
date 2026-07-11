# Cross-Host Control Protocol

Read this reference before running any Swarm Pi workflow.

## Resolve The Host

- In a Codex skill, resolve the plugin root two directories above `SKILL.md`.
- In a Claude Code command or agent, use `${CLAUDE_PLUGIN_ROOT}`.
- Use host `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
- Invoke the shared runner as `node "$PLUGIN_ROOT/scripts/pi-runner.mjs"`. Use this as `$RUNNER` below.

## Start Safely

1. Run `$RUNNER status --json`; it is local and never calls a model.
2. Run `$RUNNER jobs list --pending-notifications --json` before a new delegation.
3. Present each pending approval or terminal notification before acknowledging it. Acknowledge only the notification that was shown.
4. Preserve the user's original task in a temporary file outside the repository. Never put credentials, tokens, or private host paths into that file.

If a task returns `setup-required`, retain the continuation ID and original request. Open `$RUNNER configure --host "$HOST" --continuation <id>`, then run `$RUNNER resume --continuation <id> --json` once after a successful save. Cancellation and timeout preserve the continuation; do not ask the user to restate the task.

## Select Execution

- Default to `--execution-mode supervised --approval-mode deny`.
- Use background execution or `--approval-mode wait` only when the host can keep a relay/watcher alive, present notifications, and run `jobs wait` until completion. Otherwise state the explicit supervised fallback.
- Exit code `3` means only the wait command timed out. Exit code `4` means approval is required. Exit code `5` means setup or a workspace decision is required.
- Never approve a capability lease, choose adoption, materialize an artifact, stash, discard, commit, merge, push, or deploy without the user's explicit decision.

## Finish Reliably

Validate Pi claims against the repository. For mutation workflows, inspect the actual diff and run host-owned verification. Delete temporary prompt/spec files after the runner has durably copied them. Report the model/fallback, verification evidence, changed files or artifact, and unresolved risk.
