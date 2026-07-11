---
description: Configure or reconfigure Swarm Pi providers, models, roles, safety, and project setup
argument-hint: '[--reconfigure] [--reset] [--json] [--no-open]'
allowed-tools: Bash, AskUserQuestion, Read, Write
---

# swarm-pi-code-plugin init

Raw arguments: `$ARGUMENTS`

1. When `$ARGUMENTS` contains `--reset`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --reset --json`, return the result, and stop. Never reset Pi's user credentials.
2. When `$ARGUMENTS` is exactly `--json`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --json`, return the status, and stop.
3. Otherwise use the bundled `swarm-pi-code-plugin-configure` skill. Pass `--no-open` only when the user supplied that exact flag.
4. Stop when the browser result is cancelled or timed out. Never ask for or echo an API key, OAuth code, or device code in this conversation; relay only the loopback setup URL when browser launch fails.
5. Resume a saved continuation only after successful configuration, without asking the user to repeat the task.

The browser always reads the existing model and project profile values, so `--reconfigure` edits current settings. Reconfiguration preserves job history and keeps credentials outside project files and browser storage. Use `/swarm-pi-code-plugin:project` to reopen only the guided project setup.
