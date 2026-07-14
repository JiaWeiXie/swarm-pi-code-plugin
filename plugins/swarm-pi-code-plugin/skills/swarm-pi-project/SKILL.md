---
name: swarm-pi-project
description: Reopen only Pi's project role routing, execution safety, scope, Host Assistance, Decision Mode, Advisor, doctrine, and Host Action settings from Codex or Claude Code. Use for project-policy changes that must not alter provider credentials, connections, or model authentication; use swarm-pi-configure for full setup.
---

# Configure Swarm Pi Project Setup

Read and follow the [cross-host control protocol](../../references/host-protocol.md).

1. Run `$RUNNER status --json`. If `workspace.git` is false, ask whether to run only `git init` at the exact reported root. On approval, verify no non-terminal Jobs, run only that command, and require a Git-backed status; never add, commit, configure identity, or modify project files. On decline, make no Git change. Stop and preserve both paths when storage migration is conflicted or blocked.
2. Start `$RUNNER configure --host "$HOST" --section project`; keep it active and relay its loopback URL when needed. Keep exact `--json` and `--reset` non-interactive.
3. After save, run `$RUNNER roles list --json` and `$RUNNER status --json`. Report `configurationStorage.directory`, `modelConfigurationFile`, `stateFile`, migration status, routing, and policy details. Clarify that doctrine is metadata only and keep Git-init decisions out of the Web UI.

This workflow is repeatable. New projects use Adaptive, Host-first, Reversible, and Discovery gate review; legacy projects preserve their saved Sandbox mode and remain User-only for missing Host-first fields until resaved. Change only project routing, safety, and profile settings. Never alter provider credentials or the immutable snapshots of active Jobs.
