---
name: swarm-pi-configure
description: Open the guided local setup for Pi providers, models, role routing, and shared project delegation settings from Codex or Claude Code. Use for first setup, recovery, or provider reconfiguration.
---

# Configure Swarm Pi Code Plugin

Read the [cross-host control protocol](../../references/host-protocol.md).

When the request arguments contain `--reset`, run `$RUNNER init --host "$HOST" --reset --json`, return the result, and stop. Never reset Pi's user credentials. When the arguments are exactly `--json`, run `$RUNNER init --host "$HOST" --json`, return the status, and stop. Otherwise open the guided setup below; pass `--no-open` only when the user supplied that exact flag, and treat `--reconfigure` as editing the current model and project profile values (reconfiguration preserves job history and keeps credentials outside project files and browser storage).

1. Run `$RUNNER status --json`, then start `$RUNNER configure --host "$HOST"` with `--continuation <id>` when recovering a saved request.
2. Keep the command active and relay its loopback URL when the browser does not open. Stop cleanly on cancellation or timeout.
3. Let the browser render provider-specific fields, fixed protocol badges, custom protocol selection, subscription OAuth, models, roles, sandbox/approval policy, Decision Mode, Host Assistance review path and automatic scope, Discovery gate review, context budget, Advisor, doctrine metadata, Host Actions, workspace, and review choices. Never request an API key or OAuth code in the host conversation.
4. Treat ChatGPT Plus/Pro as the separate `openai-codex` subscription connection. Keep the setup process active while browser/device-code OAuth is pending; cancellation and timeout are normal terminal outcomes.
5. Model discovery and **Verify API** are separate. Do not describe a connection as verified merely because a model list loaded.
6. After save, run `$RUNNER doctor --smoke-test --json`, `$RUNNER roles list --json`, and `$RUNNER status --json`; report readiness and resume the continuation once.

The browser restores only non-sensitive drafts. Secrets first enter the setup server's in-memory credential vault and are committed to Pi AuthStorage only after candidate verification succeeds. `model.json` and runtime state stay outside the checked-out worktree.

New configurations start in Adaptive mode with Host-first, Reversible, and Discovery gate auto-review. The selected primary becomes the initial classifier when none was chosen. Existing saved Sandbox modes remain unchanged, and legacy Host Assistance policies missing the new fields remain User-only until the user saves them; do not describe reconfiguration as silently expanding an active or legacy Job.
