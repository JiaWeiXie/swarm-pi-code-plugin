---
name: swarm-pi-configure
description: Open the full guided local setup for Pi providers, credentials, models, role routing, and shared project delegation policy from Codex or Claude Code. Use for first setup, recovery, provider or model changes, and full reconfiguration; use swarm-pi-project when provider connections must remain untouched.
---

# Configure Swarm Pi Code Plugin

Read and follow the [cross-host control protocol](../../references/host-protocol.md).

Route arguments before opening the browser:

- For `--reset`, run `$RUNNER init --host "$HOST" --reset --json`, return the result, and stop. Never reset Pi user credentials.
- When the arguments are exactly `--json`, run `$RUNNER init --host "$HOST" --json`, return the storage status, and stop.
- Otherwise continue with guided setup. Pass `--no-open` only when supplied exactly; treat `--reconfigure` as editing current values without deleting Job history.

1. Run `$RUNNER status --json`. If `workspace.git` is false, ask whether to run only `git init` at the exact reported root. On approval, verify no non-terminal Jobs, run only that command, and require a Git-backed status; never add, commit, configure identity, or modify project files. Keep `--reset` and exact `--json` non-interactive. Stop and preserve both paths on migration conflict or active-job block.
2. Start `$RUNNER configure --host "$HOST"`, adding `--continuation <id>` only when recovering a saved request.
3. Keep setup active through provider fields, protocol selection, subscription OAuth, models, roles, Sandbox and approval policy, Decision Mode, Host Assistance, Discovery gates, context budget, Advisor, doctrine metadata, Host Actions, workspace, and review. Never request an API key or OAuth code in the Host conversation.
4. Treat ChatGPT Plus/Pro as the separate `openai-codex` subscription connection. Treat model discovery and **Verify API** as distinct; a loaded model list is not proof of verification.
5. After save, run `$RUNNER doctor --smoke-test --json`, `$RUNNER roles list --json`, and `$RUNNER status --json`. Report readiness, `configurationStorage.directory`, `modelConfigurationFile`, `stateFile`, and migration status; resume a continuation once.

The browser restores only non-sensitive drafts. Secrets enter the setup server's in-memory vault and reach Pi AuthStorage only after verification; `model.json` and runtime state remain outside the checked-out worktree.

New configurations use Adaptive, Host-first, Reversible, and Discovery gate review. Preserve existing saved Sandbox modes. Keep legacy Host Assistance policies User-only until the user resaves them; never imply that reconfiguration changes an active Job's immutable snapshot.
