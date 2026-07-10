---
name: swarm-pi-code-configure
description: Configure or fully reconfigure shared swarm-pi-code Pi model priority, project goal, directory scope, and delegated task types for the current repository.
---

# Configure Swarm Pi Code

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" --reconfigure --json` and show current settings.
3. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" models --json`.
4. Ask for one primary model, ordered optional fallbacks, project goal, scoped directories, and delegated task types. An empty model array means configure later.
5. Write the complete model array and profile object to temporary JSON files outside the repository. Preserve user text exactly.
6. Run:

```bash
node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" \
  --set-model-priority-file "$MODEL_FILE" \
  --save-profile-file "$PROFILE_FILE" \
  --json
```

7. Delete temporary files and report primary, fallbacks, goal, directories, and tasks.

Reconfiguration replaces all setup fields while preserving job history. Use `init --reset --json` only when the user explicitly asks to clear configuration.
