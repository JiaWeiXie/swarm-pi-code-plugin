---
name: swarm-pi-code-plugin-configure
description: Open the guided local setup page to configure Pi providers, models, and the shared project delegation profile.
---

# Configure Swarm Pi Code Plugin

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" configure --host "$HOST"`. Keep the command active while the user completes the local browser form. Relay the printed local URL when the browser does not open automatically.
3. Stop when the result is cancelled or timed out. Never ask the user to paste an API key into the host conversation.
4. The browser guides the user through Provider, model, project goal, working directories, and delegated task types. Do not repeat those questions in the host conversation.
5. After a successful browser save, run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" --reconfigure --json` and report provider, primary model, fallbacks, credential source, goal, directories, and tasks.

The browser reads the current model and project profile settings on every launch. Model selections remain in `.swarm-pi-code-plugin/model.json`; the project profile remains in shared state. API keys go directly to Pi's user credential store and must never be included in temporary files, output, or project state. Use `$swarm-pi-code-plugin-project` to reopen only the guided project setup. Use `init --reset --json` only when the user explicitly asks to clear project configuration; reset does not remove Pi credentials.
