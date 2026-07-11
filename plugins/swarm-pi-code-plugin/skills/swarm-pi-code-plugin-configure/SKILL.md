---
name: swarm-pi-code-plugin-configure
description: Open the guided local setup for Pi providers, models, role routing, and shared project delegation settings from Codex or Claude Code. Use for first setup, recovery, or provider reconfiguration.
---

# Configure Swarm Pi Code Plugin

Read the [cross-host control protocol](../references/host-protocol.md).

1. Run `$RUNNER status --json`, then start `$RUNNER configure --host "$HOST"` with `--continuation <id>` when recovering a saved request.
2. Keep the command active and relay its loopback URL when the browser does not open. Stop cleanly on cancellation or timeout.
3. Let the browser collect connections, models, roles, safety, workspace, and review choices. Never request an API key in the host conversation.
4. After save, run `$RUNNER doctor --smoke-test --json`, `$RUNNER roles list --json`, and `$RUNNER status --json`; report readiness and resume the continuation once.

The browser restores only non-sensitive drafts. Credentials go directly to Pi's user credential store; `model.json` and runtime state stay outside the checked-out worktree.
