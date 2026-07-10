# swarm-pi-code-plugin Architecture

## Decision

Rebuild swarm-code around the embedded Pi coding-agent SDK. Do not spawn the Pi
CLI and do not retain a predecessor-runtime fallback. The embedded SDK gives the
project
ownership of tool exposure, session lifetime, result shape, and testability.

The repository, marketplace package, and user-facing product are all named
**swarm-pi-code-plugin**.

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
- `.swarm-pi-code-plugin/model.json` stores host-neutral provider and model
  configuration. `state.json` stores the project profile and job metadata;
  job directories hold prompts, output, diff summaries, and verification
  results. None of these project files stores credentials.
- Pi `AuthStorage` and `ModelRegistry` use Pi's supported credential and model
  configuration. No predecessor credentials are read or migrated.
- The implementation profile has no generic bash tool. Build, test, lint, and
  formatting commands are executed by the host from an explicit workspace
  verification profile.

## Public Interfaces

The shared runner exposes:

```text
node scripts/pi-runner.mjs init --host <claude|codex> --json
node scripts/pi-runner.mjs models --json
node scripts/pi-runner.mjs providers --json
node scripts/pi-runner.mjs configure --host <host> [--no-open]
node scripts/pi-runner.mjs ask --host <host> --prompt-file <file> --json
node scripts/pi-runner.mjs review --host <host> [--base <ref>] --json
node scripts/pi-runner.mjs plan --host <host> --prompt-file <file> --json
node scripts/pi-runner.mjs implement --host <host> --prompt-file <file> --json
node scripts/pi-runner.mjs orchestrate --host <host> --prompt-file <file> --json
```

Every execution result will include `kind`, `status`, `success`, `model`,
`output`, `changedFiles`, `diffStat`, and structured verification results.

Claude Code exposes `/swarm-pi-code-plugin:init`, a read-only Pi worker, and a Pi
builder agent. Agent descriptions will contain concrete trigger examples.
Codex exposes `$swarm-pi-code-plugin-configure`, ask, review, plan, implement,
and orchestrate skills under the same prefix.
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

Use the Git common directory to resolve one shared `.swarm-pi-code-plugin/`
data root for linked worktrees. `model.json` is canonical for providers and
model priority; `state.json` retains the project profile, jobs, and a temporary
compatibility priority mirror. `SWARM_PI_CODE_PLUGIN_DATA_DIR` remains an
explicit override.

On first run after the naming alignment, state migration preserves configuration
and Pi jobs from `.swarm-pi-code/`. It may also copy project goal, directory
scope, delegated task types, and recognized `provider/model` preferences from
the older `.swarm-code/` format. Predecessor caches, sessions, jobs, logs, and
provider-specific settings are not migrated from that older format.
When `model.json` is absent, the first read falls back to migrated
`state.config.modelPriority`; the next successful setup creates the canonical
file. Unrecognized models force model reconfiguration.

State writes use a same-directory temporary file followed by an atomic rename.
For linked worktrees, the state root is the parent of Git's absolute common
directory (normally the primary checkout), not the feature worktree. The
current worktree remains the Pi session `cwd`, so sharing configuration never
widens the mutation boundary.

## Implemented Core Boundary

The core runner now enforces these invariants before and after an implementation
session:

1. `git status --porcelain=v1 -z` must report a clean assigned worktree.
2. Pi receives read, grep, find, ls, write, and edit, but never bash.
3. SDK write/edit definitions are replaced with scoped operations that reject
   lexical path traversal and symlinks resolving outside the worktree.
4. The host captures tracked and untracked changed files and a diff summary
   after the session, including partial changes from a failed session.
5. Verification remains host-owned and is not yet enabled in this milestone.

## Implemented Runner Contract

The shared runner now implements all six task surfaces plus configuration:

- `configure` starts a loopback-only, token-protected browser session that reads
  and atomically updates `model.json`, writes credentials only through Pi
  `AuthStorage`, and exits after save, cancel, or timeout.
- `init` refreshes authenticated Pi models, atomically replaces model priority
  in canonical `model.json`, mirrors priority for older plugin releases, saves
  the project profile, and resets project configuration without deleting jobs
  or Pi credentials.
- `ask`, `plan`, and `review` run read-only sessions. Review supports working
  tree, branch, explicit base, auto scope, untracked files, and root commits.
- Read-only failures retry the configured fallback chain in order.
- `implement` uses the same fallback chain only while the worktree remains
  unchanged; once any edit exists, another model is never started.
- `orchestrate` runs three bounded read-only perspectives in parallel and
  returns labeled evidence for the host to synthesize.
- Every invocation persists request, prompt, result, and optional patch
  artifacts. State index updates use a lock plus atomic rename.

## Implemented Host Packaging

- Claude Code loads `/swarm-pi-code-plugin:init`, `pi-worker`, and `pi-builder` from the
  standard command/agent directories.
- Codex loads configure, ask, review, plan, implement, and orchestrate from the
  validated root `skills/` contract. Skills detect Claude versus Codex before
  invoking the shared runner. Claude and Codex launch the same browser setup
  implementation and never request API keys in host conversation text.
- The marketplace package contains compiled JavaScript and a plugin-local,
  locked production dependency graph. First use performs one concurrency-safe
  `npm ci --omit=dev --ignore-scripts`; subsequent calls reuse that cache.
- Host adapters write user prompts and configuration JSON to temporary files so
  user-controlled text is never interpolated into shell source.
- The configuration web server binds only to `127.0.0.1` on an ephemeral port,
  requires a random per-session token, rejects cross-origin writes, applies a
  restrictive CSP, and exposes no persisted credential value to the browser.

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
7. **Predecessor removal gate**: verify no tracked runtime, manifest, prompt, or
   user documentation depends on the previous worker engine.

## Verification Strategy

- Unit tests cover tool profiles, state resolution, `model.json` migration and
  validation, argument parsing, model selection, provider readiness, retry
  policy, trigger classification, and JSON schemas.
- Mocked Pi sessions cover read-only tool denial, allowed edits, failures,
  cancellation, token limits, and model fallback.
- Git integration tests cover clean/dirty preflight, linked worktrees, exact
  changed-file capture, and preservation of unrelated user changes.
- Manifest tests parse both plugin formats and both repo marketplaces.
- Browser E2E covers the true empty state, user-triggered endpoint discovery,
  automatic model metadata, first-run save, reconfiguration prefill,
  responsive layout, token enforcement, and credential non-disclosure. Manual
  acceptance then runs configure and one ask, review, plan, and bounded
  implementation from both Claude Code and Codex.

## Release Gates

- Node.js is provided exclusively by the trusted `mise.toml` configuration.
- Dependencies are locked; Pi SDK upgrades require explicit compatibility tests.
- The plugin package must be self-contained for both host installers. The SDK
  bundling strategy must pass a clean-machine install test before release.
- No worker can commit, push, or modify files outside its assigned worktree.
- The previous worker engine is absent from runtime, manifests, installation
  requirements, and user-facing documentation.
