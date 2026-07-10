---
name: swarm-pi-code-plugin-configure
description: Open the guided local setup page to configure Pi providers, models, and the shared project delegation profile.
---

# Configure Swarm Pi Code Plugin

1. Resolve the plugin root two directories above this `SKILL.md`. Set host to `claude` when `CLAUDE_PLUGIN_ROOT` is present; otherwise use `codex`.
2. Run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" configure --host "$HOST"`. Keep the command active while the user completes the local browser form. Relay the printed local URL when the browser does not open automatically.
3. Stop when the result is cancelled or timed out. Never ask the user to paste an API key into the host conversation.
4. The browser guides the user through Provider, model, project goal, working directories, delegated task types, and strict or lenient sandbox mode. Do not repeat those questions in the host conversation.
5. After a successful browser save, run `node "$PLUGIN_ROOT/scripts/pi-runner.mjs" init --host "$HOST" --reconfigure --json` and report provider, primary model, fallbacks, credential source, goal, directories, tasks, and sandbox mode.

The browser reads the current model and project settings on every launch. Model selections remain in `.swarm-pi-code-plugin/model.json`; the project profile and sandbox mode remain in shared state. Lenient mode permits sandboxed shell commands and outbound network access, so preserve the browser's source-exposure warning. API keys go directly to Pi's user credential store and must never be included in temporary files, output, or project state. Use `$swarm-pi-code-plugin-project` to reopen only the guided project setup. Use `init --reset --json` only when the user explicitly asks to clear project configuration; reset does not remove Pi credentials.
