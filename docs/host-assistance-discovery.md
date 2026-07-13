# Host Assistance, Discovery, and Host Actions

This reference defines the worker-to-Host assistance loop, the fixed
Discovery workflow, and isolated Host Actions. These features share the normal
Job, policy, approval, event, and artifact control plane; they do not create a
second relay or permission system.

## Host Assistance

Host Assistance is available to supported research, planning, review,
implementation, setup, Discovery, and Advisor sessions. The Pi worker receives
one custom tool, `request_host_assistance`. It describes what is missing; it
does not select or invoke Web search, Context7, a paper database, a connector,
an installed skill, or a shell command.

### Request kinds

`HostContextRequest` asks for one context class:

- `workspace`: bounded repository or local-file search;
- `web`: current public Web information;
- `docs`: official SDK/API documentation, including Context7-style retrieval;
- `paper`: papers or primary research;
- `connector`: an authenticated/private integration;
- `skill`: an installed Host skill.

The request includes the question, unknowns, acceptance criteria,
freshness/version constraints, data classification, egress permission, a
numeric budget, and a complete `WorkerAssessment`:

- purpose, blocking condition, expected result, and fallback;
- minimum access and exact path, command, service, or data targets;
- side effects, data-exposure range, failure modes, and mitigations;
- `read-only`, `reversible`, `partially-reversible`, or `irreversible`;
- rollback, post-action verification, and proposed risk.

The Worker assessment is untrusted advice. The runner checks the snapshotted
class allowlist and context budget before exposing the request to the Host.
Persisted legacy requests may omit the assessment, but they cannot receive an
automatic allow.

`HumanDecisionRequest` asks the user to choose or clarify scope. It does not
create a capability lease.

`ActionRecommendation` records a proposed side effect. Recording it does not
execute anything; see [Host Actions](#host-actions).

### Dedicated admission, routing, and policy

`request_host_assistance` bypasses only the generic tool-call classifier and
enters dedicated typed admission for request kind, classification, quotas,
session uniqueness, fan-out, and expiry. Bash, filesystem, and network tools
still use the generic policy engine. The Host chooses the narrowest available
mechanism and returns a typed result. This routing happens in the active Host
adapter/session, not inside the Worker or a watcher.

- Workspace context stays subject to the effective project roots and protected
  paths.
- Public Web, docs, and paper requests do not require a private-data approval.
- Connector requests and non-public external egress enter the existing
  approval path. A workspace may deny connectors completely.
- Secret or credential egress is hard denied.
- Unknown skills or skills with undeclared/transitive side effects must be
  declined by the Host.

New projects default to `reviewMode: host-first`,
`autoApprovalScope: reversible`, and Discovery gate auto-review. Legacy policy
objects missing those fields stay User-only/Context-only with gate review off
until resaved. Every Job uses its immutable snapshot.

The active Codex or Claude model reads the full record and
`adjudicationContext`, including the original intent and policy snapshot. It
independently checks role ceiling, project roots and denies, Sandbox mode,
fingerprint, policy hash, risk, reversibility, rollback, and verification. It
writes a `HostAdjudicationReceipt` with principal, Host/model identity,
decision, assessed risk, rationale, constraints, intent match, exact
fingerprint/policy hash, auto-resolution flag, and timestamp.

- `allow` is limited to low/medium-risk public/read-only context or one exact,
  fully reversible, in-scope action already authorized by the original task.
- `ask-user` persists the receipt and keeps the request pending.
- `hard-deny` resolves the matching request without a capability lease.

An approval carrying `shell.execute` is not read-only by declaration. Before
persisting the request, the trusted runner evaluates the complete Bash command
against a deliberately small inspection grammar. Only commands without shell
expansion, redirection, backgrounding, alternate branches, path escape, or
write/exec flags receive `trustedReadOnly: true`; composed commands are accepted
only when every `&&` or pipeline segment is independently allowlisted. Bounded
`sha256sum`/`shasum` inspection commands, `rustc`/`cargo` version probes, and
two-file `cmp`/`diff` comparisons are included for fixture and dependency
reproducibility evidence. Compilation, test execution, comparison output files,
traversal, workspace-external absolute paths, redirection, expansion, command
substitution, and mixed mutation statements remain excluded. The Host must
still verify the visible command, original intent, roots, and exact fingerprint.
Missing classification and unknown syntax always fall back to the normal
mutation ceiling or the user.

Strict cannot gain a capability through a receipt. Secrets, private connectors,
Git metadata, protected/out-of-workspace targets, deletion, partial or
irreversible changes, action recommendations, role escalation, adoption,
materialization, commit/push/merge, publishing, deployment, messages,
transactions, and uncertain live-service operations are never auto-allowed.

A `HostContextBundle` contains an answer, claims, evidence IDs, citations,
retrieval/version metadata, conflicts, unknowns, provenance, redactions, and a
hash. A decision result contains the selected decision, optional rationale,
time, and hash. Decline, expiry, cancellation, quota, or policy rejection
returns a typed unavailable result rather than invented context.

All returned context is labeled `[UNTRUSTED_HOST_CONTEXT]`. Provenance makes it
auditable, not authoritative. It cannot change system or project policy, user
intent, an ExperimentSpec, or a user gate.

### Correlation and durability

Every request is bound to:

```text
Job ID + generation + session ID + attempt + optional perspective + request ID
```

One session may have only one active logical request. Policy limits the number
of requests per Job and concurrent perspective fan-out. The first valid
response wins and can be consumed once. Duplicate, stale, wrong-generation, or
misrouted responses are rejected.

Requests, safe events, responses, hashes, delivery, and consumption state are
durable. A `.pending` record is reconciled after a crash. The worker keeps its
heartbeat while waiting and continues the same live session after a valid
response. If the process crashes, the Job becomes orphaned: a saved bundle may
be reused by a new Job, but the unfinished call stack is not resumed.

### Host commands and events

```bash
mise exec -- node scripts/pi-runner.mjs jobs host-requests --job <job-id> --json
mise exec -- node scripts/pi-runner.mjs jobs host-respond --job <job-id> --request <request-id> --response-file <bundle.json> --json
mise exec -- node scripts/pi-runner.mjs jobs host-decline --job <job-id> --request <request-id> --reason <reason> --json
mise exec -- node scripts/pi-runner.mjs jobs decisions --job <job-id> --json
mise exec -- node scripts/pi-runner.mjs jobs decide --job <job-id> --request <request-id> --response-file <decision.json> --json
```

An active Host model adds `--adjudication-file <receipt.json>` to
`jobs approve`, `jobs host-respond`, or `jobs decide`. Without that option the
commands keep manual user-principal semantics. The runtime validates the exact
pending record and automatic ceiling again; rejected receipts fall back to the
user and must not be weakened. `ask-user` and `hard-deny` may use an empty JSON
response file because the runtime either preserves pending state or creates the
typed denial itself.

Live Jobs use `awaiting-host` or `awaiting-decision`. The event stream adds
`host-assistance-required`, `host-assistance-resolved`,
`human-decision-required`, and `human-decision-resolved`. Events contain a safe
summary and correlation identifiers, not raw questions, prompts,
WorkerAssessments, secrets, or private payloads. Resolved events add only the
safe principal, assessed risk, and auto-resolution flag. Replay, SessionStart,
timeout, and background watchers are informational and never create a receipt,
decision, response, lease, or acknowledgement.

Static Host-prefetched context remains available through
`--host-context-file`. Use it when the needed sources are known before the Pi
session starts; use live assistance when the unknown emerges during work.

## Discovery

`discover` is one fixed, linear parent workflow. It is for uncertainty that
prevents a defensible feature definition, not for ordinary implementation.

### 1. Research

The analyst returns an `EvidencePlan` and `EvidencePack`. The schema requires
unknowns, source classes, acceptance criteria, budget, claims, citations,
conflicts, and remaining unknowns. Its read-only Sandbox is disposed before the
gate. The active Host may auto-approve a complete bounded gate only when the
snapshotted gate option is enabled; otherwise it obtains the user's decision.

### 2. Experiment micro-SDLC

The parent creates a durable isolated `experimenter` child. It inherits the
parent's Sandbox mode, roots, network policy, and immutable policy lineage,
creates its own stage Sandbox in the job-owned worktree, and uses the shared
Adaptive network authorizer. The child capability view has a distinct stage
hash because its role and Advisor controls differ; its canonical v3 snapshot
includes the exact parent hash as `parentPolicyHash`. Host receipts bind to the
stage hash, while audit can verify the parent binding without pretending two
different policy documents are identical. Success, failure, cancellation, and
timeout dispose in `finally`; failed worktrees and logs remain for explicit
investigation.

The stage Sandbox may read the linked worktree `.git` file, its per-worktree
administrative directory, and the repository common directory solely for Git
baseline and clean-replay inspection. The same paths remain in `denyWrite`, and
the runtime state subdirectory keeps its more-specific read denial. This is an
internal stage boundary, not an approval ceiling expansion: a Worker still
cannot obtain a lease to mutate Git metadata, commit, or deliver. On macOS the
Sandbox prefers the direct Command Line Tools executable path, avoiding the
host-side cache write attempted by the `/usr/bin/git` `xcrun` shim.

Its schema requires:

- hypothesis and baseline/control;
- dependencies, fixture, and seed/data hash;
- setup, run, test, verify, cleanup, and clean-replay commands;
- metrics and tolerance;
- commands run, tests run, explicit evidence, and
  `cleanReplayPassed: true`;
- one conclusion: `supported`, `refuted`, or `inconclusive`.

The runner validates the schema, changed paths, and isolated worktree before
recording the report. The artifact is always `kind: experiment` and
`deliverable: false`; `jobs materialize` must reject it.

Current limitation: the control plane validates the reported commands and
clean-replay result but does not independently execute the complete replay
sequence. Treat the report as structured experiment evidence, not as a trusted
deterministic replay receipt.

### 3. Convergence

The final stage creates a fresh read-only Sandbox when it needs tools and
returns a `FeatureDefinition` with summary, acceptance criteria, non-goals, and
a citation-backed `DecisionLedger`. A final review gate controls whether the
result can feed the next task. The active Host may approve a complete bounded
gate under the snapshot; otherwise the decision falls back to the user. Both
paths record `review-gate:approved`, while legacy `user-gate:approved` handoffs
remain valid:

```bash
mise exec -- node scripts/pi-runner.mjs plan --host <host> --prompt-file <plan.md> --discovery-from <discovery-job-id> --json
```

The handoff revalidates that the source is a successful Discovery Job with a
passed stage report and final approval. Gate waiting never owns a Sandbox, and
at most one process-global Sandbox manager is alive at any time.

Advisor is optional and off by default. Enabled consultations are bounded,
read-only, context-only, and non-recursive. They cannot execute actions or
override policy, experiment validation, verification, or user gates.

Decision Mode currently changes bounded orchestration depth: Cost uses one
base perspective, Balance two, and Power three. Context budget and Advisor
quotas remain explicit settings. The `first-principles-qds-v1` option is stored
in PolicySnapshot v3, but the runtime does not yet execute an automatic
Question/Delete/Simplify convergence pass.

## Host Actions

An action recommendation is inert until all of these are true:

1. the parent completed successfully;
2. the parent was `implement` or `setup`, preserving original mutation intent;
3. workspace Host Actions and the action class are enabled;
4. the recommendation was recorded with exact correlation;
5. the user explicitly confirms `jobs action-start`.

```bash
mise exec -- node scripts/pi-runner.mjs jobs action-start --job <parent-job-id> --request <recommendation-id> --json
```

The runner creates a separate isolated child with `principal: host-broker`, the
parent's snapshotted project policy, an action-family lease, postflight checks,
a verifier, an artifact, and a receipt. It never transfers the parent's writer
lease.

Local mutation and draft action classes are enabled by default. Remote write,
message, deploy, and transaction are disabled until the workspace opts in.
Advisor and coordinator roles cannot create Host Actions. An unknown external
outcome is terminal and is never retried automatically.
