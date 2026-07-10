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

The first runtime slice establishes Pi SDK loading, explicit read-only and
implementation tool profiles, dual-host manifests, model discovery, and a
testable runner for read-only `ask` and `plan` jobs.

```bash
mise run build
node scripts/pi-runner.mjs models --json
node scripts/pi-runner.mjs ask --host codex --prompt-file /path/to/prompt.md --json
```

Mutating commands intentionally fail closed until clean-worktree preflight,
diff capture, and verification are implemented. Host commands, skills, state,
and those mutation controls remain tracked in [`docs/architecture.md`](docs/architecture.md).
