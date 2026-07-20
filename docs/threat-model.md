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
| Symlink, TOCTOU, or recursive search escapes | lexical/realpath scope, no-follow descriptor open, descriptor identity check, parent dev/inode revalidation, recursive symlink refusal, postflight |
| Classifier fails open | schema validation, bounded retries, approval or deny fallback |
| Approval is replayed | job generation, policy hash, fingerprint, expiry, atomic consumption |
| Parallel Bash changes global policy | worker-local serialization, immutable job policy snapshot |
| Worker dies while waiting | heartbeat reconciliation, orphan terminal result, stale approval rejection |
| Host Assistance is replayed, misrouted, or partially persisted | Job/generation/session/attempt/perspective fencing, stable request ID, request/fan-out quotas, `.pending` reconciliation, first-valid response, consume-once |
| Host context injects instructions | `[UNTRUSTED_HOST_CONTEXT]`, typed bundles, policy/gate/spec precedence, secret egress hard deny |
| Model claims an experiment replay passed | required structured fields, isolated child, changed-path validation, explicit limitation until trusted replay exists |
| Action recommendation becomes an unapproved side effect | inert recommendation, explicit Host record/start, original mutation-intent check, isolated child, host-broker action-family lease, remote actions default off |
| Host blocks while a worker waits for approval | managed relay, fixed 15-second parent wait, durable Job ID, bounded `jobs wait` |
| Approval notification is left stale or acknowledged incorrectly | atomic approval/notification transaction, matching notification ID, separate terminal acknowledgement |
| Watcher restart replays an approval | stable `eventId`, Host-side deduplication, replay is informational and never consent |
| Hook or event stream leaks worker context | SessionStart recovery only, strict event allowlist, no prompt/output/log/token fields, Codex hook trust review |
| Network destination changes after approval | destination checks at connect time, hostname and resolved-address policy |
| Provider protocol is guessed incorrectly | explicit wire protocol, canonical roots, one protocol per connection |
| Browser or job artifact leaks a credential | opaque draft IDs, CredentialStore-only secrets, response and journal redaction |
| OAuth flow outlives setup | bounded polling, AbortSignal, timeout, cancel and server-dispose cleanup |
| Literal header triggers Pi config syntax | controlled allowlist, control-character rejection, literal escaping |
| Settings change during a background job | immutable provider/model snapshot, PolicySnapshot v3, request v5 hashes |
| Credential is revoked after submission | resolve current CredentialStore at execution and fail explicitly |
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

The SessionStart hook is a recovery aid, not an execution control boundary. A
Host must still inspect the event, display the approval evidence, and make the
decision. `jobs watch` is at-least-once and may replay an event after restart;
stable event IDs allow deduplication, while the approval transaction and policy
generation remain authoritative. The standard SessionStart hook is loaded by
Claude Code; the Codex manifest does not declare hooks.

The strict read-only implementation verifier is a semantic model review, not a
trusted command-running verifier. Likewise, experiment `cleanReplayPassed` is
schema-validated evidence reported by the experimenter, not a control-plane
replay receipt. `false` is accepted only to record a fully unexecuted or
preflight-blocked, evidence-backed `inconclusive` result; a preflight-blocked
report must contain exactly the declared simple setup command and declared
`node --check <file>` test, with pairwise-distinct lifecycle commands plus
syntax or blocking evidence. Shell composition and related expansion or
redirection constructs are rejected for this exception. These checks do not
inspect setup-script semantics, and the exception cannot satisfy a workload-
executed, `supported`, or `refuted` experiment. Until trusted verification
executes allowlisted commands, Hosts must run the relevant build, lint,
typecheck, and tests before delivery.

Decision Mode, Advisor, and `first-principles-qds-v1` do not form a safety
boundary. Advisor output is untrusted evidence. The doctrine value is currently
snapshotted metadata and does not execute an automatic convergence pass.

Claude Code and Codex share notifications, delivery state, and configuration.
Matching IDs prevent unrelated acknowledgements, but there is no general Host
claim token for notification presentation, materialization, or configuration
transactions. Operators must serialize delivery and settings changes until a
token-fenced project operation coordinator exists.

These risks are surfaced in setup, recorded in job policy snapshots, and
contained by the immutable ceiling. Node does not expose a portable `openat(2)`
API, so scoped tools combine no-follow final descriptors with parent identity
revalidation and the OS sandbox/postflight boundary. Projects facing a hostile
concurrent local process should use a stronger whole-process/container
boundary; that remains a future mode.

Bootstrap artifacts add a delivery boundary: models write only to a staging
repository, while the trusted control plane owns Git initialization, artifact
commits, target fingerprint checks, and materialization. Runtime state is kept
outside the checked-out worktree and is never part of a scaffold snapshot.

## Telemetry-specific boundary

The local collector appends validated attempt events to the existing state
directory only. The directory and JSONL file use restrictive permissions; the
collector does not create a sidecar, queue, IPC channel, network request,
provider upload, or separate home-directory service. A failed append is
diagnostic and cannot rewrite a completed Job outcome.

Strict parsing and privacy validation use an explicit allowlist and reject
prompts, completions, reasoning, source text, paths, URLs/endpoints, personal
data, secrets, credentials, raw provider configuration, Git metadata, and
arbitrary free-form text. Usage counters are allowlisted by exact field name;
unknown token-bearing fields and unsafe custom labels are rejected or replaced
with `unknown-custom` before persistence.

The dashboard is a read-only view over that local file. It binds to loopback,
requires a random per-session token, uses CSP, and closes with the existing
server lifecycle. Report detail is bounded and newest-first. Cost remains
explicitly unknown without authoritative pricing; integer fixture arithmetic,
stale pricing, mixed currencies, and local usage-only states are never hidden
behind a currency total. No billing accuracy, performance, or external upload
claim follows from this feature.
