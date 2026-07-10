---
description: Configure or reconfigure swarm-pi-code-plugin models and project task profile
argument-hint: '[--reconfigure] [--reset] [--json] [--no-open]'
allowed-tools: Bash, AskUserQuestion, Read, Write
---

# swarm-pi-code-plugin init

Raw arguments: `$ARGUMENTS`

1. When `$ARGUMENTS` contains `--reset`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --reset --json`, return the result, and stop. Never reset Pi's user credentials.
2. When `$ARGUMENTS` is exactly `--json`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --json`, return the status, and stop.
3. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" configure --host claude`. Add `--no-open` only when the user supplied that exact flag. Keep the command active while the user completes the local browser form, and relay its printed URL when the browser does not open automatically.
4. Stop when the browser result is cancelled or timed out. Never ask for or echo an API key in this conversation.
5. After a successful save, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --reconfigure --json` and show the current project goal, directories, and task types.
6. Ask for replacement project goal, scoped directories, and delegated task types.
7. Write only the profile object as a temporary JSON file outside the repository. Preserve user text exactly; do not interpolate it into shell source.
8. Persist the profile:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude \
  --save-profile-file "$PROFILE_FILE" \
  --json
```

9. Delete the temporary file and report provider, active primary, fallbacks, credential source, goal, directories, and tasks.

The browser always reads the existing `.swarm-pi-code-plugin/model.json`, so `--reconfigure` edits current Provider and model values. Reconfiguration preserves job history and keeps API keys outside project files.
