# Bootstrap, Onboarding, and Workspace Hygiene

This document defines the runtime contract for first-use guidance, project
bootstrap, recoverable configuration, and worktree hygiene. Host adapters hide
role selection during normal use and preserve the user's original request while
configuration or workspace intervention is required.

## Readiness

`status` performs local inspection and reports `ready`, `degraded`, or
`blocked`, plus separate `readonly`, `mutation`, and `delivery` capabilities.
An available model does not imply that the current workspace can accept an
implementation. `doctor` adds active checks and may run an explicitly requested
model smoke test. Issues identify their setup stage, severity, preserved state,
and executable next actions; credentials and stack traces never appear in the
public result.

When a delegated request cannot start because configuration is incomplete, the
control plane stores a host- and workspace-bound continuation for 24 hours.
Configuration cancellation or timeout leaves it pending. A successful setup
and readiness check may resume it exactly once.

Workspace remediation continuations use a repair fence: they remain bound to
the same host, workspace path, request, and 24-hour expiry, but allow the
workspace fingerprint to change. Resume always repeats the complete preflight;
no previous readiness decision is reused.

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
- `git-unborn`: Git metadata exists but there is no initial commit or `HEAD`.

Untracked `.DS_Store`, `__pycache__`, `.pyc`, and `.pyo` files are preserved but
excluded from worker changes and delivery. The same paths are blocking when
tracked, staged, conflicted, or unsafe. Secrets and unknown hidden files are
never classified as disposable.

Safe-dirty mutation automatically runs in a job-owned worktree based on HEAD,
without copying the generated artifacts. Their preflight digest is checked
again during materialization. User-dirty work requires an explicit isolated
HEAD or isolated snapshot strategy. Unsafe work fails closed. An unborn Git
repository is available for research, but mutation fails before model startup
and offers scaffold or inspect/adopt actions.

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

Verified implementation artifacts use the same explicit `jobs materialize`
boundary. The control plane confirms the original HEAD, obtains the worktree
lease, checks preserved paths, applies the binary patch without creating a
commit, and reverses the patch if post-apply validation fails.

Package lifecycle scripts are disabled by default. Native builds, postinstall
scripts, and unknown network sources require adaptive approval within the
existing immutable capability ceiling.

## Failure Communication

Every recoverable failure answers four questions: where it failed, why it
failed, what was preserved, and which action is recommended next. Browser-open
failure falls back to the loopback URL. Cancellation and idle timeout are not
system errors. Partial configuration rollback creates a redacted recovery
journal and blocks delegation until `doctor` confirms repair.

Running jobs expose a durable phase (`queued`, `preflight`, `delegating`,
`postflight`, `checkpointing`, or `verifying`) and last-progress timestamp so a
host relay can report useful progress without conflating its own detached shell
with Pi background execution.
