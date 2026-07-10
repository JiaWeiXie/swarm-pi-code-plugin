---
description: Reopen the guided Swarm Pi project goal, working area, delegated task, and sandbox setup
argument-hint: '[--no-open]'
allowed-tools: Bash
---

# swarm-pi-code-plugin project setup

Raw arguments: `$ARGUMENTS`

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" configure --host claude --section project`. Add `--no-open` only when the user supplied that exact flag.
2. Keep the command active while the user completes the local browser form. Relay its printed local URL when the browser does not open automatically.
3. Stop when the browser result is cancelled or timed out. Never ask for an API key or repeat the project setup questions in this conversation.
4. After a successful save, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --json` and report the saved project goal, working directories, delegated task types, and sandbox mode.

This command is safe to run repeatedly. It reads and updates only the shared project profile and sandbox mode in `.swarm-pi-code-plugin/state.json`; it does not change Provider, model priority, credentials, or job history.
