---
description: Configure or reconfigure swarm-pi-code models and project task profile
argument-hint: '[--reconfigure] [--reset] [--json]'
allowed-tools: Bash, AskUserQuestion, Read, Write
---

# swarm-pi-code init

Raw arguments: `$ARGUMENTS`

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude --json $ARGUMENTS`.
2. For `--reset` or an explicitly requested `--json`, return the runner result and stop.
3. Show the current primary model, fallback order, goal, directories, and task types.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" models --json` and ask for one primary model plus optional ordered fallbacks. An empty list means configure later.
5. Ask for project goal, scoped directories, and delegated task types.
6. Write the model array and profile object as JSON files outside the repository. Preserve user text exactly; do not interpolate it into shell source.
7. Persist both files atomically:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-runner.mjs" init --host claude \
  --set-model-priority-file "$MODEL_FILE" \
  --save-profile-file "$PROFILE_FILE" \
  --json
```

8. Delete the temporary files and report active primary, fallbacks, goal, directories, and tasks.

Reconfiguration replaces model priority and profile but preserves job history.
