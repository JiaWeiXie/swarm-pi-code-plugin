# swarm-pi-code-plugin

Dual-host plugin project for Claude Code and Codex. The host agent owns intent,
approvals, validation, and delivery; an embedded Pi coding-agent session performs
bounded read-only or implementation work.

This repository is a clean rewrite of `swarm-code-plugin`. Pi is the only
delegated worker engine.

The original plugin concept and host workflow were informed by
[apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin). This
rewrite replaces its delegated worker runtime with the embedded Pi SDK and uses
an independent implementation.

## Development

The project pins Node.js through mise:

```bash
mise install
mise run install
mise run check
```

Runtime baseline:

- Node.js 24.15.0
- `@earendil-works/pi-coding-agent` 0.80.6
- TypeScript strict mode

Installed plugins require Node.js 22.19.0 or newer, matching the pinned Pi SDK.
The repository itself develops and verifies with the mise-pinned Node 24.15.0.

## Install

### Claude Code

Add the GitHub repository as a marketplace, then install the named plugin:

```bash
claude plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
claude plugin install swarm-pi-code-plugin@swarm-pi-code-plugin
```

Restart Claude Code or run `/reload`, then configure the project:

```text
/swarm-pi-code-plugin:init
/swarm-pi-code-plugin:init --reconfigure
```

For local development:

```bash
claude --plugin-dir /absolute/path/to/swarm-pi-code-plugin/plugins/swarm-pi-code-plugin
```

### Codex

This repository contains a non-default local marketplace. Add its repository
root once, then install by plugin and marketplace name:

```bash
codex plugin marketplace add /absolute/path/to/swarm-pi-code-plugin
codex plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local
```

Start a new Codex task so skills are reloaded. Available skills are:

```text
$swarm-pi-code-plugin-configure
$swarm-pi-code-plugin-ask
$swarm-pi-code-plugin-review
$swarm-pi-code-plugin-plan
$swarm-pi-code-plugin-implement
$swarm-pi-code-plugin-orchestrate
```

The first runner invocation installs the exact plugin-local production
dependencies from `package-lock.json`. Credential discovery uses Pi's supported
auth storage and provider environment variables; project files never store
credentials. Confirm authenticated models with:

```bash
node plugins/swarm-pi-code-plugin/scripts/pi-runner.mjs models --json
```

## Configure Providers and Models

Both host entry points launch the same temporary local setup page:

```text
/swarm-pi-code-plugin:init --reconfigure
$swarm-pi-code-plugin-configure
```

The runner binds only to `127.0.0.1` on a random port, opens the browser, and
prints a one-time URL as a fallback. Setup follows three familiar steps:
**Connections**, **Models**, and **Routing**. The Connections page contains only
services that are already usable, detected from Pi-supported credentials, or
saved by the user. A new project with no usable service starts with an empty
list instead of a catalog of unfinished providers.

Known Pi OAuth subscriptions and documented provider environment variables are
detected without exposing their secret values. Users can also explicitly scan
for a running Ollama or LM Studio instance, connect a known cloud provider, or
enter a custom HTTP(S) endpoint. Custom setup initially asks only for the URL
and optional API key; **Test and find models** detects supported OpenAI,
Anthropic, Gemini, Ollama, and LM Studio model-list APIs. Context-window and
maximum-output values are filled from endpoint metadata or Pi's model catalog
when known. Unknown values remain **Automatic**, with manual overrides kept in
an Advanced section.

The setup server shuts down after save, cancel, or ten minutes of inactivity.

Provider and model choices are saved atomically to the shared, gitignored
`.swarm-pi-code-plugin/model.json`. Reconfiguration reads this file and
pre-populates connections, models, and routing. An API key entered in the page
goes directly to Pi's user credential store (`~/.pi/agent/auth.json` by
default); it is never written to `model.json`, state, job artifacts, logs,
URLs, or browser responses. A blank key field preserves the existing
credential.

For a terminal without automatic browser launch:

```bash
node scripts/pi-runner.mjs configure --host codex --no-open
```

Provider inventory is also available to automation:

```bash
node scripts/pi-runner.mjs providers --json
node scripts/pi-runner.mjs models --provider anthropic --all --json
```

## Status

The runtime currently provides Pi SDK loading, explicit read-only and
implementation tool profiles, dual-host manifests, model discovery, shared
worktree-aware state, and a testable runner for `ask`, `plan`, and guarded
`implement` jobs.

```bash
mise run build
node scripts/pi-runner.mjs models --json
node scripts/pi-runner.mjs providers --json
node scripts/pi-runner.mjs configure --host codex --no-open
node scripts/pi-runner.mjs init --json
node scripts/pi-runner.mjs ask --host codex --prompt-file /path/to/prompt.md --json
node scripts/pi-runner.mjs review --host codex --scope working-tree --json
node scripts/pi-runner.mjs plan --host codex --prompt-file /path/to/plan.md --json
node scripts/pi-runner.mjs implement --host codex --prompt-file /path/to/task.md --json
node scripts/pi-runner.mjs orchestrate --host codex --prompt-file /path/to/task.md --json
```

`implement` requires a clean Git worktree, exposes no shell tool to Pi, confines
all writes and edits to the assigned worktree (including symlink checks), and
returns the exact changed-file list plus a diff summary. Verification remains a
host responsibility, so the Pi result reports verification as `not-run`.

Provider and model configuration is stored in
`.swarm-pi-code-plugin/model.json`; job history and the project profile remain
in `.swarm-pi-code-plugin/state.json`. Linked worktrees resolve the main
repository through Git's common directory and share both files. Set
`SWARM_PI_CODE_PLUGIN_DATA_DIR` for an explicit override. A first read fully
migrates existing `.swarm-pi-code/` config and Pi jobs. It can also migrate the
older project profile and model preference from `.swarm-code/`; predecessor job
history and provider data are deliberately excluded from that older format.

The runner stores each request, raw prompt, result, and implementation patch in
`.swarm-pi-code-plugin/jobs/<job-id>/`. State updates use an inter-process lock and an
atomic rename, so concurrent read-only jobs do not overwrite job history.

The browser is the recommended setup path. Automation may still configure a
complete primary/fallback chain atomically:

```bash
node scripts/pi-runner.mjs init \
  --set-model-priority '["provider/primary","provider/fallback"]' \
  --save-profile '{"goal":"Ship the migration","dirs":["src"],"tasks":["Implementation"]}' \
  --json
```

`--reset` clears `model.json`, model inventory, priority, and project profile
while preserving Pi credentials, job history, and artifacts. The plugin package includes the compiled runner,
Claude command/agents, and six shared host-aware skills. Architecture and safety
details are documented in [`docs/architecture.md`](docs/architecture.md).
