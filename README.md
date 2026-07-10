# swarm-pi-code-plugin

Dual-host plugin project for Claude Code and Codex. The host agent owns intent,
approvals, validation, and delivery; an embedded Pi coding-agent session performs
bounded read-only or implementation work.

This repository is a clean rewrite of `swarm-code-plugin`. It does not contain
an OpenCode compatibility runtime.

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

## Status

The runtime currently provides Pi SDK loading, explicit read-only and
implementation tool profiles, dual-host manifests, model discovery, shared
worktree-aware state, and a testable runner for `ask`, `plan`, and guarded
`implement` jobs.

```bash
mise run build
node scripts/pi-runner.mjs models --json
node scripts/pi-runner.mjs ask --host codex --prompt-file /path/to/prompt.md --json
node scripts/pi-runner.mjs implement --host codex --prompt-file /path/to/task.md --json
```

`implement` requires a clean Git worktree, exposes no shell tool to Pi, confines
all writes and edits to the assigned worktree (including symlink checks), and
returns the exact changed-file list plus a diff summary. Host verification is
still pending, so the result reports verification as `not-run`.

State is stored in `.swarm-pi-code/state.json`. Linked worktrees resolve the
main repository through Git's common directory and share this state. Set
`SWARM_PI_CODE_DATA_DIR` for an explicit override. A first read can migrate the
old project profile and model preference from `.swarm-code/`; OpenCode jobs and
provider data are deliberately excluded.

`review`, `orchestrate`, host commands/skills, and the distributable plugin
runtime remain tracked in [`docs/architecture.md`](docs/architecture.md).
