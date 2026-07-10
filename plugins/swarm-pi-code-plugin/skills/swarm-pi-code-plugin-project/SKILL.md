---
name: swarm-pi-code-plugin-project
description: Reopen the guided Swarm Pi project goal, working area, delegated task, and sandbox setup without changing Provider or model configuration.
---

# Configure Swarm Pi Project Setup

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" configure --host "$HOST" --section project`. Keep the command active while the user completes the local browser form. Relay its printed local URL when the browser does not open automatically.
3. Stop when the result is cancelled or timed out. Never ask for an API key or repeat the project setup questions in the host conversation.
4. After a successful save, run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" --json` and report the saved project goal, working directories, delegated task types, and sandbox mode.

This skill is safe to run repeatedly. It reads and updates only the shared project profile and sandbox mode in `.swarm-pi-code-plugin/state.json`; it does not change Provider, model priority, credentials, or job history. Lenient mode enables OS-sandboxed Bash and outbound network access for newly submitted jobs only.
