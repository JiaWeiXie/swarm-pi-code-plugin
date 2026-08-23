---
name: swarm-pi-project
description: Configure Pi project routing, execution safety, scope, Host Assistance, Decision Mode, Advisor, timing, and testing defaults while preserving provider connections. Use for project-policy changes; use swarm-pi-configure for provider or authentication changes.
compatibility: Requires Node.js 22.19+, local shell command execution, and first-run npm registry access with a writable plugin directory; mutation workflows also require Git.
---

# Configure Swarm Pi Project Setup

Follow the [Skill Control Loop](../../references/skill-control-loop.md).

1. Run `$RUNNER status --json`. When `workspace.git` is false, offer only
   `git init` at the reported root. Approval requires no non-terminal Jobs; the
   result must be Git-backed, with project files, identity, index, and history
   unchanged. Migration conflict or block preserves both paths and stops setup.
2. Start `$RUNNER configure --host "$HOST" --section project` and keep its
   loopback session active. A save-time storage `EPERM` triggers the
   [State storage write boundary](../../references/host-protocol.md#state-storage-write-boundary):
   preserve the draft and relaunch with Host approval.
3. After Save, run `$RUNNER roles list --json` and `$RUNNER status --json`.
4. Complete only when storage directory, model file, state file, migration,
   routing, and policy are reported. Doctrine is identified as metadata, and
   Git-init remains a Host decision outside the Web UI.

This repeatable workflow changes only project routing, safety, and profile
settings. New projects default to Adaptive, Host-first, Reversible, and
Discovery gate review; `full-access` and Autopilot remain opt-in. Existing
Sandbox modes persist, legacy missing Host-first fields remain User-only until
resaved, provider connections stay unchanged, and active Job snapshots remain
immutable.
