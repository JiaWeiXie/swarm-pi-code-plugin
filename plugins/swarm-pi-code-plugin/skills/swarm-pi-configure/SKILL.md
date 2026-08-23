---
name: swarm-pi-configure
description: Configure Pi providers, credentials, models, role routing, and shared project policy in the guided local setup. Use for first setup, recovery, provider or model changes, or full reconfiguration; use swarm-pi-project when provider connections must stay unchanged.
compatibility: Requires Node.js 22.19+, local shell command execution, and first-run npm registry access with a writable plugin directory; mutation workflows also require Git.
---

# Configure Swarm Pi Code Plugin

Follow the [Skill Control Loop](../../references/skill-control-loop.md) and read
the [Configuration Addendum](../../references/host-protocol-configuration.md).

Route arguments before opening the browser:

- For `--reset`, run `$RUNNER init --host "$HOST" --reset --json`, return the result, and stop. Never reset Pi user credentials.
- When the arguments are exactly `--json`, run `$RUNNER init --host "$HOST" --json`, return the storage status, and stop.
- Otherwise continue with guided setup. Pass `--no-open` only when supplied exactly; treat `--reconfigure` as editing current values without deleting Job history.

1. Run `$RUNNER status --json`. When `workspace.git` is false, offer only
   `git init` at the reported root. Approval requires no non-terminal Jobs; the
   result must be Git-backed, with project files, identity, index, and history
   unchanged. Migration conflict or an active-job block preserves both paths and
   stops setup.
2. Start `$RUNNER configure --host "$HOST"`, adding `--continuation <id>` only
   for recovery. A save-time `EPERM` under `.git/swarm-pi-code-plugin/` triggers
   the [State storage write boundary](../../references/host-protocol.md#state-storage-write-boundary):
   preserve the draft, obtain Host approval, relaunch outside the outer sandbox,
   and provide the new loopback URL.
3. Keep setup active through connections, protocol, subscription OAuth, model
   discovery and verification, roles, execution safety, Decision Mode, Host
   Assistance, Discovery gates, context budget, Advisor, doctrine metadata,
   per-task execution limits, probe recovery, testing preference, workspace,
   and review. Credentials stay inside the setup UI.
   ChatGPT Plus/Pro is the separate `openai-codex` connection.
4. After Save, run `$RUNNER doctor --smoke-test --json`,
   `$RUNNER roles list --json`, and `$RUNNER status --json`; resume a
   continuation exactly once when present.
5. Complete only when the smoke test and role routing are reported together with
   readiness, `providerState`, configuration directory, model file, state file,
   and migration status.
