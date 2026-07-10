---
description: Configure or reconfigure swarm-pi-code-plugin providers, models, and project setup
argument-hint: '[--reconfigure] [--reset] [--json] [--no-open]'
allowed-tools: Bash, AskUserQuestion, Read, Write
---

# swarm-pi-code-plugin init

Raw arguments: `$ARGUMENTS`

1. When `$ARGUMENTS` contains `--reset`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --reset --json`, return the result, and stop. Never reset Pi's user credentials.
2. When `$ARGUMENTS` is exactly `--json`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --json`, return the status, and stop.
3. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" configure --host claude`. Add `--no-open` only when the user supplied that exact flag. Keep the command active while the user completes the local browser form, and relay its printed URL when the browser does not open automatically.
4. Stop when the browser result is cancelled or timed out. Never ask for or echo an API key in this conversation.
5. The browser guides the user through Provider, model, project goal, working directories, and delegated task types. Do not repeat those questions in this conversation.
6. After a successful save, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --reconfigure --json` and report provider, active primary, fallbacks, credential source, goal, directories, and tasks.

The browser always reads the existing model and project profile values, so `--reconfigure` edits current settings. Reconfiguration preserves job history and keeps API keys outside project files. Use `/swarm-pi-code-plugin:project` to reopen only the guided project setup.
