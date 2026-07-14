---
name: swarm-pi-project
description: Reopen guided Pi role routing, execution safety, project scope, Host Assistance, decision, Advisor, and Host Action settings without changing provider credentials or connections.
---

# Configure Swarm Pi Project Setup

Read the [cross-host control protocol](../../references/host-protocol.md).

1. Run `$RUNNER status --json`. If `workspace.git` is false, ask in the Host conversation: “目前 workspace 尚未初始化 Git。是否要在 `<workspace.root>` 執行 `git init`？” On acceptance, verify no non-terminal Jobs, run only `git init` with the exact reported workspace root as cwd, then rerun status and require a Git-backed result (`git-unborn` is valid). On decline, perform no Git mutation. Never add, commit, configure identity, or modify project files. If storage migration is conflicted or blocked by active Jobs, stop and show the preserved paths.
2. Start `$RUNNER configure --host "$HOST" --section project`; keep it active and relay its loopback URL when needed. The same preflight applies; `--json` and `--reset` remain non-interactive.
3. After save, run `$RUNNER roles list --json` and `$RUNNER status --json`, and report `configurationStorage.directory`, `modelConfigurationFile`, `stateFile`, and migration status alongside the existing routing and policy details. Clarify that doctrine is currently metadata only. Keep all Git-init decisions in the Host flow; the Web UI remains unchanged.

This workflow is repeatable. New projects use Adaptive, Host-first, Reversible, and Discovery gate review; legacy projects keep their stored Sandbox mode and missing Host-first fields normalize to User-only until resaved. It changes only role overrides, execution safety, and project profile; immutable Job snapshots keep active Jobs unchanged.
