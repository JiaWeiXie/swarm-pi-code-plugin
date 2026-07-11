# Bootstrap, Onboarding, and Workspace Hygiene

This document defines the runtime contract for first-use guidance, project
bootstrap, recoverable configuration, and worktree hygiene. Host adapters hide
role selection during normal use and preserve the user's original request while
configuration or workspace intervention is required.

## Readiness

`status` performs local inspection and reports `ready`, `degraded`, or
`blocked`. `doctor` adds active checks and may run an explicitly requested
model smoke test. Issues identify their setup stage, severity, preserved state,
and executable next actions; credentials and stack traces never appear in the
public result.

When a delegated request cannot start because configuration is incomplete, the
control plane stores a host- and workspace-bound continuation for 24 hours.
Configuration cancellation or timeout leaves it pending. A successful setup
and readiness check may resume it exactly once.

The guided flow is Connect, Models, Roles, Execution & Safety, Workspace, and
Review & Test. A missing Git repository is workspace context, not a provider
configuration failure.

## Runtime State

Runtime state does not live in the checked-out worktree. Git repositories use
the common Git directory so linked worktrees share jobs and configuration.
Non-Git directories use an OS user-state namespace keyed by the canonical
workspace path. `SWARM_PI_CODE_PLUGIN_DATA_DIR` remains an explicit override.

Legacy `.swarm-pi-code-plugin` state is migrated under a state lock after the
destination is verified. If both locations contain state, the runtime preserves
both, reports a migration conflict, and never guesses how to merge them.

## Workspace Assessment

All preflight, baseline, diff, verification, and artifact code uses one
assessment:

- `clean`: no relevant changes;
- `safe-dirty`: only untracked runtime or recognized generated artifacts;
- `user-dirty`: tracked, staged, or unknown untracked user content;
- `unsafe`: conflicts, unsafe links, special files, or invalid Git state.

Untracked `.DS_Store`, `__pycache__`, `.pyc`, and `.pyo` files are preserved but
excluded from worker changes and delivery. The same paths are blocking when
tracked, staged, conflicted, or unsafe. Secrets and unknown hidden files are
never classified as disposable.

Safe-dirty work proceeds without editing `.gitignore`, deleting files,
stashing, or committing. User-dirty work requires an explicit isolated HEAD or
isolated snapshot strategy. Unsafe work fails closed.

## Bootstrap Roles and Delivery

`project-architect` produces a reviewed scaffold specification without file
mutation. `scaffolder` writes only a job-owned staging repository.
`environment-engineer` configures project-local dependencies and tools under
supervision. Global installation, host configuration, deployment, and Git
delivery remain outside worker authority.

The trusted control plane initializes staging Git metadata, records provenance,
runs deterministic validation and a fresh verifier, and creates an artifact
commit. A successful job is not delivered automatically. `jobs materialize`
revalidates the target fingerprint and moves the verified artifact only after
host approval. Collisions or target changes preserve the artifact and stop.

Package lifecycle scripts are disabled by default. Native builds, postinstall
scripts, and unknown network sources require adaptive approval within the
existing immutable capability ceiling.

## Failure Communication

Every recoverable failure answers four questions: where it failed, why it
failed, what was preserved, and which action is recommended next. Browser-open
failure falls back to the loopback URL. Cancellation and idle timeout are not
system errors. Partial configuration rollback creates a redacted recovery
journal and blocks delegation until `doctor` confirms repair.
