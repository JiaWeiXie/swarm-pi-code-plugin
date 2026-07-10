---
name: swarm-pi-code-plugin-configure
description: Open the local swarm-pi-code-plugin setup page to configure Pi providers and models, then update the shared project delegation profile.
---

# Configure Swarm Pi Code Plugin

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" configure --host "$HOST"`. Keep the command active while the user completes the local browser form. Relay the printed local URL when the browser does not open automatically.
3. Stop when the result is cancelled or timed out. Never ask the user to paste an API key into the host conversation.
4. After a successful browser save, run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" --reconfigure --json` and show the current project goal, scoped directories, and delegated task types.
5. Ask for a replacement project goal, scoped directories, and delegated task types. Write the complete profile object to a temporary JSON file outside the repository, preserving user text exactly.
6. Run:

```bash
node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" \
  --save-profile-file "$PROFILE_FILE" \
  --json
```

7. Delete the temporary file and report provider, primary model, fallbacks, credential source, goal, directories, and tasks.

The browser reads `.swarm-pi-code-plugin/model.json` on every launch, so reconfiguration edits the existing values. API keys go directly to Pi's user credential store and must never be included in temporary files, output, or project state. Use `init --reset --json` only when the user explicitly asks to clear project configuration; reset does not remove Pi credentials.
