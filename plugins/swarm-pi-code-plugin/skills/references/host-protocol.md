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

Treat readiness as task-specific. `capabilities.readonly` governs research and planning; `capabilities.mutation` governs file changes; `capabilities.delivery` governs materialization. Never describe the workspace as fully ready when the requested capability is degraded or blocked. A `git-unborn` workspace can be researched but must be scaffolded or adopted before implementation.

If a task returns `setup-required`, retain the continuation ID and original request. Open `$RUNNER configure --host "$HOST" --continuation <id>`, then run `$RUNNER resume --continuation <id> --json` once after a successful save. Cancellation and timeout preserve the continuation; do not ask the user to restate the task.

## Select Execution

- Default to `--execution-mode supervised --approval-mode deny`.
- Use background execution or `--approval-mode wait` only when the host can keep a relay/watcher alive, present notifications, and run `jobs wait` until completion. Otherwise state the explicit supervised fallback.
- Exit code `3` means only the wait command timed out. Exit code `4` means approval is required. Exit code `5` means setup or a workspace decision is required.
- Never approve a capability lease, choose adoption, materialize an artifact, stash, discard, commit, merge, push, or deploy without the user's explicit decision.

Do not ask the user to choose between internal roles, Pi, or direct Host execution. Route the stated intent to the narrowest matching workflow and ask only for a decision that changes files, grants a capability, adopts content, or delivers an artifact. Use the canonical short Claude command names such as `/swarm-pi-code-plugin:orchestrate`; never expose duplicated internal skill names.

When external facts are required, gather a cited EvidencePack once through the Host before delegation. Include source URLs, retrieval date, verified claims, unknowns, and version constraints in the Pi prompt so every perspective uses the same evidence. If evidence cannot be obtained, return `evidence-required` instead of presenting speculation as verified research.

For long-running work, distinguish Pi `executionMode` from the Host relay process. Poll `jobs wait --wait-timeout-ms 15000` and `jobs status` instead of leaving one opaque shell wait. Surface the current `phase`, elapsed time, last progress time, and cancel command at least once per minute.

## Finish Reliably

Validate Pi claims against the repository. For mutation workflows, inspect the actual diff and run host-owned verification. Delete temporary prompt/spec files after the runner has durably copied them. Report the model/fallback, verification evidence, changed files or artifact, and unresolved risk.

Keep the loop durable. Reference the research or plan job ID in the next implementation brief, copy accepted evidence and constraints into that brief, and preserve the returned continuation ID whenever workspace repair is required. After repair, use `resume --continuation <id>` instead of asking the user to restate the task.

Do not present a large inline code sample as working code unless it has passed the relevant parser, typecheck, or test. Prefer a concise explanation plus a verified artifact. For an isolated implementation artifact, present its diff and verifier result, obtain explicit delivery approval, then run `jobs materialize --job <id>`; this applies the patch without committing it.
