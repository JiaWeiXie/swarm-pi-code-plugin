---
name: swarm-pi-configure
description: Open the guided local setup for Pi providers, models, role routing, and shared project delegation settings from Codex or Claude Code. Use for first setup, recovery, or provider reconfiguration.
---

# Configure Swarm Pi Code Plugin

Read the [cross-host control protocol](../../references/host-protocol.md).

When the request arguments contain `--reset`, run `$RUNNER init --host "$HOST" --reset --json`, return the result, and stop. Never reset Pi's user credentials. When the arguments are exactly `--json`, run `$RUNNER init --host "$HOST" --json`, return the status, and stop. Otherwise open the guided setup below; pass `--no-open` only when the user supplied that exact flag, and treat `--reconfigure` as editing the current model and project profile values (reconfiguration preserves job history and keeps credentials outside project files and browser storage).

1. Run `$RUNNER status --json`. If `workspace.git` is false, ask in the Host conversation: “目前 workspace 尚未初始化 Git。是否要在 `<workspace.root>` 執行 `git init`？” On acceptance, verify there are no non-terminal Jobs, run only `git init` with the exact reported workspace root as cwd, then run status again and require `git-unborn` or another Git-backed result. Never add, commit, configure identity, or modify project files. On decline, continue without Git mutation. If status reports a migration conflict or active-job block, preserve both paths and stop for recovery guidance.
2. For `--reset` and exact `--json`, keep the flow non-interactive: never ask or auto-run `git init`; return the storage information in the JSON result.
3. Start `$RUNNER configure --host "$HOST"` with `--continuation <id>` when recovering a saved request.
4. Let the browser render provider-specific fields, fixed protocol badges, custom protocol selection, subscription OAuth, models, roles, sandbox/approval policy, Decision Mode, Host Assistance review path and automatic scope, Discovery gate review, context budget, Advisor, doctrine metadata, Host Actions, workspace, and review choices. Never request an API key or OAuth code in the host conversation.
5. Treat ChatGPT Plus/Pro as the separate `openai-codex` subscription connection; keep setup active while OAuth is pending. Cancellation and timeout are normal terminal outcomes.
6. Model discovery and **Verify API** are separate. Do not describe a connection as verified merely because a model list loaded.
7. After save, run `$RUNNER doctor --smoke-test --json`, `$RUNNER roles list --json`, and `$RUNNER status --json`; report readiness, the actual `configurationStorage.directory`, `modelConfigurationFile`, `stateFile`, and migration status, then resume the continuation once. Git-init decisions belong to this Host flow; do not add a Git decision control to the Web UI.

The browser restores only non-sensitive drafts. Secrets first enter the setup server's in-memory credential vault and are committed to Pi AuthStorage only after candidate verification succeeds. `model.json` and runtime state stay outside the checked-out worktree.

New configurations start in Adaptive mode with Host-first, Reversible, and Discovery gate auto-review. The selected primary becomes the initial classifier when none was chosen. Existing saved Sandbox modes remain unchanged, and legacy Host Assistance policies missing the new fields remain User-only until the user saves them; do not describe reconfiguration as silently expanding an active or legacy Job.
