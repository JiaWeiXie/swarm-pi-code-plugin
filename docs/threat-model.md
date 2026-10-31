# Delegated Worker Threat Model

## Trust Boundaries

The active host—Claude Code, Codex, or another Agent Plugins-compatible
client—and the shared runner control plane are trusted.
Model output, repository content, delegated prompts, Pi tool arguments, shell
commands, network responses, and project-local extensions are untrusted.
Classifier output is a policy signal, not an enforcement boundary.

The OS sandbox, scoped tools, canonical path checks, immutable hard-deny rules,
state generation fencing, and postflight validation form the enforcement
boundary. A failure in one control must not expose unrestricted host access.

`strict` exposes scoped filesystem tools without a Bash runner. `adaptive`,
`lenient`, and `autopilot` use an OS-sandboxed shell when Bash is exposed.
`full-access` retains the lenient OS sandbox for read-only workers; mutation
workers use an unsandboxed shell. See [Full-access mode](#full-access-mode).

## Immutable Denials

Scoped filesystem tools enforce their assigned read/write roots. Shell reads
use the runtime's deny-then-allow model instead: known credential paths, plugin
state, job artifacts, Git metadata and unrelated home content are denied, with
explicit read exceptions for executable/runtime paths, configured shell roots
and optional Git reads. System files outside those denies remain readable.
Shell reads are not a workspace-only allowlist. The sandbox write configuration
allows the assigned shell/workspace roots and isolated temporary root as
appropriate for the worker mode, with explicit control/Git-path write denies.
Sandboxed shells also receive a sanitized environment rather than the host's
credential-bearing environment.

The sandbox configuration disables local binding, Unix sockets and weaker
nested/network isolation. On Linux, the required Unix-socket filter uses the
runtime's seccomp helper. If the pinned runtime reports that helper unavailable,
the plugin reports the sandbox unavailable and refuses to create the runner,
before starting a worker shell. This applies whenever an OS-sandboxed shell is
requested, including full-access read-only workers. Other runtime warnings
remain advisory; this check is not an attestation of every kernel capability.

The policy engine denies recognized privilege escalation, protected-path and
Git delivery/deployment actions before classifier or approval processing.
The explicit `autoGitWrites` and `autoDelivery` opt-ins (Autopilot and
`full-access`) turn matching Git delivery and deployment commands into a human
approval gate. Workers do not load project/user Pi extensions. Full-access
mutation shells do not have the OS filesystem/environment/socket restrictions;
their policy checks are guardrails as described below.

### Network policy by mode

The shell runner defaults to `lenient` when its caller omits the mode; new
project state defaults to `adaptive`. Autopilot and full-access read-only
workers use the lenient shell configuration.

Adaptive applies the plugin's public-target and policy checks plus explicit
resolved-address denials for loopback, link-local, private-use, carrier-grade
NAT and IPv6 unique-local ranges. The runtime resolves permitted hostnames once
and dials a checked address. Lenient and Autopilot permit outbound traffic and
do not add Adaptive's private-range deny list. The runtime's default hostname
address checks still apply, but they are not a blanket private-network ban:
IP literals, localhost names and resolution at a parent proxy follow the
runtime's distinct rules. Full-access mutation shells have no plugin OS network
isolation. These mode differences are unchanged by the 0.27.1 helper check.

## Full-access mode

`full-access` is an explicit opt-in Sandbox mode. It is never a default and
normalization never selects it implicitly. Mutation workers remove the plugin's
own OS sandbox: their shell runs with the operator's user rights and the operator's
environment (minus the plugin's own injected variables), so its reach is
whatever that account and the host's own sandbox allow. The plugin cannot
detect or control the host's sandbox.

Read-only workers that expose Bash retain the lenient OS sandbox, sanitized
environment and read-only workspace restrictions. They require an available backend,
including the Linux Unix-socket filter helper.

In this mode the policy engine still evaluates each proposed command, and its
checks for privilege escalation, Git delivery and deployment, host package
provisioning, and protected paths still apply. Those checks read the text of
the proposed command. They help catch mistakes and ordinary commands, and they
are a guardrail, not an enforcement boundary: they must not be relied on to
contain a worker that is following hostile instructions. Anything the
operator's account can reach should be treated as reachable by the worker.

Use `full-access` only where that exposure is acceptable, for example in a
disposable or otherwise isolated environment, and prefer one of the sandboxed
modes otherwise. Discovery experiment children downgrade `full-access` and
`autopilot` to `lenient` and keep the OS sandbox. Host Action execution has been
removed; its retained policy fields and records are legacy audit data.

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
| Shared-recon seal is forged, replayed, or treated as authority | authenticated runtime controller capability, exact-once 1–8 schema gate, defensive seed validation, immutable in-memory clone, custom-message-only propagation, explicit untrusted-claims instruction, fixed sanitized failure, no seal telemetry/result fields |
| Model claims an experiment replay passed | required structured fields, isolated child, changed-path validation, explicit limitation until trusted replay exists |
| Legacy Host Action is started | action-start returns `host-actions-removed`; retained configuration is disabled and recommendation records are inert |
| Host blocks while a worker waits for approval | managed relay, fixed 15-second parent wait, durable Job ID, bounded `jobs wait` |
| Approval notification is left stale or acknowledged incorrectly | atomic approval/notification transaction, matching notification ID, separate terminal acknowledgement |
| Watcher restart replays an approval | stable `eventId`, Host-side deduplication, replay is informational and never consent |
| Hook or event stream leaks worker context | SessionStart recovery only, strict event allowlist, no prompt/output/log/token fields, Codex hook trust review |
| Network destination changes after approval | destination checks at connect time, hostname and resolved-address policy |
| Provider protocol is guessed incorrectly | explicit wire protocol, canonical roots, one protocol per connection |
| Browser or job artifact leaks a credential | opaque draft IDs, CredentialStore-only secrets, response and journal redaction |
| OAuth flow outlives setup | bounded polling, AbortSignal, timeout, cancel and server-dispose cleanup |
| Literal header triggers Pi config syntax | controlled allowlist, control-character rejection, literal escaping |
| Settings change during a background job | immutable provider/model snapshot, global registry revision, PolicySnapshot v3, request v6 hashes |
| Stale setup tab restores a removed provider or model route | project and provider-registry revision conflicts, server-side reference reconciliation, explicit reload |
| Global provider edit races another project | shared cross-process transaction lock, fixed credential/registry/project lock order, optimistic revision, atomic rename, rollback journal |
| Historical endpoint is mistaken for the active provider | current routing is authoritative, stale cache count is diagnostic only, Job snapshots are explicitly excluded |
| Provider deletion leaves a reusable credential | final Save deletes the custom provider definition and credential in one rollback-protected transaction |
| Legacy conflict rebinds a credential to another endpoint | use-global resolution revokes the provider-ID credential and blocks the profile; canonical import rekeys metadata without copying credential data |
| Credential is revoked after submission | resolve current CredentialStore at execution and fail explicitly |
| Background mutation conflicts with host | job-owned worktree and branch, no automatic integration |
| Logs expose source or secrets | redacted summaries by default, mode 0600 artifacts, bounded diagnostics |

## Residual Risks

Full-access mutation workers have no plugin OS sandbox by design; read-only
workers retain lenient OS isolation. See [Full-access mode](#full-access-mode).

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

Shared-recon's lexical privacy filter is explicitly best-effort. It rejects
C0/C1/DEL controls, backticks, the exact URL forms `http(s)://`, `ftp://`,
`file://`, and `www.`, Unix absolute paths, Windows drive/UNC paths, and
32/40/64/96/128-character hex runs. It intentionally does not reject every
slash, so relative names remain possible. These checks cannot prove that a
natural-language summary is free of sensitive information. The coordinator's
raw messages, prompts, trajectory, locations, and result text never cross into
perspectives; malformed or missing seals, and failures after sealing, fail with
a fixed sanitized message and release nothing. No entries, counts, paths,
hashes, prompts, or raw tool text are added to telemetry or results.

Claude Code, Codex, and other Agent Plugins-compatible clients share
notifications, delivery state, and configuration for the same project.
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
