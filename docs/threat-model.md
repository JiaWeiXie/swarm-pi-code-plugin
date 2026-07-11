# Delegated Worker Threat Model

## Trust Boundaries

The Claude Code or Codex host and the shared runner control plane are trusted.
Model output, repository content, delegated prompts, Pi tool arguments, shell
commands, network responses, and project-local extensions are untrusted.
Classifier output is a policy signal, not an enforcement boundary.

The OS sandbox, scoped tools, canonical path checks, immutable hard-deny rules,
state generation fencing, and postflight validation form the enforcement
boundary. A failure in one control must not expose unrestricted host access.

## Immutable Denials

Delegated workers cannot receive:

- unsandboxed shell or arbitrary host process execution;
- reads or writes outside the assigned workspace and isolated temporary root;
- credential stores, model tokens, SSH agent sockets, host environment secrets,
  plugin state, job control artifacts, or unrelated home-directory content;
- Git metadata writes, commit, branch mutation, merge, push, or deployment;
- local listening sockets, Unix sockets, cloud metadata, loopback, private
  network access, devices, or weaker nested sandboxes;
- the ability to load project or user Pi extensions in the delegated process.

These denials cannot be changed by role configuration, classifier output,
repository instructions, or a supervisor approval.

## Principal Failure Cases

| Failure | Required controls |
| --- | --- |
| Prompt injection requests broader access | immutable ceiling, untrusted-context labeling, structured classifier output |
| Tool hook is bypassed | enforcement inside scoped tools and Bash adapter, postflight validation |
| Symlink or path traversal escapes | realpath and parent checks before every read/write, deny special files |
| Classifier fails open | schema validation, bounded retries, approval or deny fallback |
| Approval is replayed | job generation, policy hash, fingerprint, expiry, atomic consumption |
| Parallel Bash changes global policy | worker-local serialization, immutable job policy snapshot |
| Worker dies while waiting | heartbeat reconciliation, orphan terminal result, stale approval rejection |
| Network destination changes after approval | destination checks at connect time, hostname and resolved-address policy |
| Provider protocol is guessed incorrectly | explicit wire protocol, canonical roots, one protocol per connection |
| Browser or job artifact leaks a credential | opaque draft IDs, AuthStorage-only secrets, response and journal redaction |
| OAuth flow outlives setup | bounded polling, AbortSignal, timeout, cancel and server-dispose cleanup |
| Literal header triggers Pi config syntax | controlled allowlist, control-character rejection, literal escaping |
| Settings change during a background job | immutable version-3 provider snapshot and integrity hash |
| Credential is revoked after submission | resolve current AuthStorage at execution and fail explicitly |
| Background mutation conflicts with host | job-owned worktree and branch, no automatic integration |
| Logs expose source or secrets | redacted summaries by default, mode 0600 artifacts, bounded diagnostics |

## Residual Risks

Lenient mode intentionally permits outbound traffic and therefore permits
source exfiltration visible to the worker. Adaptive classification can make a
wrong bounded decision. The sandbox backend may have platform defects. Model
providers receive the limited classifier context configured by the user.
Custom `API key + secret header` connections send the same credential through
the protocol-standard auth mechanism and the selected additional header to the
configured origin. Use this only when that upstream explicitly requires both.

These risks are surfaced in setup, recorded in job policy snapshots, and
contained by the immutable ceiling. Whole-process container isolation remains
a future mode for projects requiring a stronger kernel and credential boundary.

Bootstrap artifacts add a delivery boundary: models write only to a staging
repository, while the trusted control plane owns Git initialization, artifact
commits, target fingerprint checks, and materialization. Runtime state is kept
outside the checked-out worktree and is never part of a scaffold snapshot.
