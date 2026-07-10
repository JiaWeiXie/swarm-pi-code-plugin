# swarm-pi-code Architecture and Rewrite Plan

## Decision

Rebuild swarm-code around the embedded Pi coding-agent SDK. Do not spawn the Pi
CLI and do not retain an OpenCode fallback. The embedded SDK gives the project
ownership of tool exposure, session lifetime, result shape, and testability.

The repository and marketplace package are named `swarm-pi-code-plugin` and
`swarm-pi-code`; the user-facing product name is **swarm-pi-code**.

## Runtime Boundaries

```text
Claude Code / Codex
        |
        v
host adapter and routing policy
        |
        v
shared Pi runner
        |
        +-- readonly session: read, grep, find, ls
        |
        +-- implementation session: readonly tools, write, edit
        |
        v
Git diff capture and host-owned verification
```

- One in-memory Pi session is created per delegated job. Coding sessions are not
  resumed across worktrees or branches.
- `.swarm-pi-code/` stores host-neutral configuration, job metadata, prompts,
  output, diff summaries, and verification results. It never stores credentials.
- Pi `AuthStorage` and `ModelRegistry` use Pi's supported credential and model
  configuration. No OpenCode credentials are read or migrated.
- The implementation profile has no generic bash tool. Build, test, lint, and
  formatting commands are executed by the host from an explicit workspace
  verification profile.

## Public Interfaces

The shared runner will expose:

```text
node scripts/pi-runner.mjs init --host <claude|codex> --json
node scripts/pi-runner.mjs models --json
node scripts/pi-runner.mjs ask --host <host> --prompt-file <file> --json
node scripts/pi-runner.mjs review --host <host> [--base <ref>] --json
node scripts/pi-runner.mjs plan --host <host> --prompt-file <file> --json
node scripts/pi-runner.mjs implement --host <host> --prompt-file <file> --json
node scripts/pi-runner.mjs orchestrate --host <host> --prompt-file <file> --json
```

Every execution result will include `kind`, `status`, `success`, `model`,
`output`, `changedFiles`, `diffStat`, and structured verification results.

Claude Code will expose `/swarm-pi-code:init`, a read-only Pi worker, and a Pi
builder agent. Agent descriptions will contain concrete trigger examples.
Codex will expose configure, ask, review, plan, implement, and orchestrate skills.
The implementation skill only triggers for explicit user mutation intent.

## Mutation Policy

- `ask`, `review`, `plan`, and decomposition are always read-only.
- `implement` requires explicit user intent to add, fix, change, or refactor code.
- Automatic implementation requires a clean worktree. A dirty worktree returns a
  structured preflight failure; there is no implicit override.
- Pi may edit only inside the current worktree. External paths, commits, pushes,
  branch changes, dependency publication, and destructive Git operations are not
  available as tools.
- The host inspects the resulting diff, runs configured verification commands,
  and remains responsible for any commit or push.

## State and Migration

Use the Git common directory to resolve one shared `.swarm-pi-code/` state root
for linked worktrees. `SWARM_PI_CODE_DATA_DIR` remains an explicit override.

On first run, state migration may copy project goal, directory scope, delegated
task types, and recognized `provider/model` preferences from `.swarm-code/`.
OpenCode caches, sessions, jobs, logs, and provider-specific settings are not
migrated. Unrecognized models force model reconfiguration.

## Implementation Milestones

1. **SDK gate**: prove the pinned Pi SDK loads, tool profiles are enforced, model
   discovery works, and sessions can run with mocked model transport.
2. **Core runner**: implement state, model selection, prompt loading, job
   artifacts, retries, stable JSON results, and worktree-aware diff capture.
3. **Safe implementation**: enforce clean-worktree preflight, run Pi with edit
   tools only, capture changed files, and hand verification back to the host.
4. **Host adapters**: build Claude commands/agents and Codex skills with explicit
   positive and negative trigger examples.
5. **Orchestration**: create bounded parallel in-memory sessions, cap concurrency,
   synthesize results in the host, and never allow parallel mutating workers in
   the same worktree.
6. **Migration and release**: add one-time state migration, installation docs,
   marketplace tests, cachebuster flow, and end-to-end acceptance runs.
7. **OpenCode removal gate**: verify no tracked file, manifest, prompt, test, or
   documentation references OpenCode before the first stable release.

## Verification Strategy

- Unit tests cover tool profiles, state resolution, argument parsing, model
  selection, retry policy, trigger classification, and JSON schemas.
- Mocked Pi sessions cover read-only tool denial, allowed edits, failures,
  cancellation, token limits, and model fallback.
- Git integration tests cover clean/dirty preflight, linked worktrees, exact
  changed-file capture, and preservation of unrelated user changes.
- Manifest tests parse both plugin formats and both repo marketplaces.
- Manual acceptance runs configure and execute one ask, review, plan, and bounded
  implementation from both Claude Code and Codex.

## Release Gates

- Node.js is provided exclusively by the trusted `mise.toml` configuration.
- Dependencies are locked; Pi SDK upgrades require explicit compatibility tests.
- The plugin package must be self-contained for both host installers. The SDK
  bundling strategy must pass a clean-machine install test before release.
- No worker can commit, push, or modify files outside its assigned worktree.
- OpenCode is absent from runtime, manifests, installation requirements, and
  user-facing documentation.
