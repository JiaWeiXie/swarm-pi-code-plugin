# Orchestration and Adaptive Policy

This document is the implementation contract for role-based model routing,
adaptive execution policy, durable approval, and delegated delivery. The host
remains the supervisor; the embedded Pi runtime enforces the resolved policy.

## Layers

The runtime separates five responsibilities:

1. **Orchestration** resolves a task into a role, model chain, thinking level,
   execution mode, and verification policy.
2. **Policy** combines the immutable platform ceiling, worker and role
   capabilities, user configuration, project restrictions, classifier output,
   and active capability leases.
3. **Enforcement** applies the decision in Pi tool hooks, scoped file tools,
   the OS-sandboxed Bash adapter, and postflight worktree validation.
4. **Job control** persists requests, decisions, approvals, leases, heartbeat,
   notifications, cancellation, and terminal results.
5. **Delivery** preserves an isolated implementation artifact for host review;
   Pi never owns merge, push, deployment, or production credentials.

No layer may broaden the ceiling established by a previous layer. Repository
instructions are untrusted input and may only add restrictions.

## Role Registry

| Role | Task kinds | Thinking | Execution modes | Mutation |
| --- | --- | --- | --- | --- |
| `scout` | `ask` | `low` | supervised, background | none |
| `planner` | `plan` | `xhigh` | supervised, background | none |
| `reviewer` | `review` | `high` | supervised, background | none |
| `analyst` | `orchestrate`, `discover` | `medium` | supervised, background | none |
| `experimenter` | internal discovery experiment stage | `high` | supervised | bounded/sandboxed only |
| `review-coordinator` | reserved internal review/convergence role | `high` | supervised | none |
| `advisor` | optional review/discovery consultation | `high` | supervised | none; context-only |
| `mechanical-executor` | `implement` | `low` | supervised; optional background | worktree |
| `executor` | `implement` | `high` | supervised | worktree |
| `security-executor` | ask, review, implement | `high` | supervised | role dependent |
| `project-architect` | `plan` for scaffold specification | `high` | supervised, background | none |
| `scaffolder` | `scaffold` | `high` | supervised | isolated staging |
| `environment-engineer` | `setup` | `high` | supervised | worktree |
| `verifier` | internal | `medium` | internal | none; no Bash |
| `classifier` | internal | `medium` | internal | no tools |

Each role has an ordered model chain, maximum two model attempts, a capability
ceiling, and a verification policy. Requested and effective thinking levels
are recorded because Pi clamps thinking to model capabilities. Model fallback
handles provider or model failure only and never bypasses a policy decision.

`review-coordinator` is excluded from public `--role` selection. `review
--review-profile lean` uses a deterministic coordinator, not a coordinator
model session or dynamic `ReviewPlan`: three independent readonly candidates
(clarity, YAGNI, leverage) must reach a two-of-three success quorum, are
deduplicated by path/overlap/tag, then at most six candidates are independently
validated in batches of three. Every logical session uses the immutable Job
policy, a fresh readonly sandbox, independent correlation and telemetry. Only
`supported` findings are public; a failed or timed-out validator is
`inconclusive`, and no unresolved validation may produce `Lean already. Ship.`
The lean panel never adds Advisor consultation. `orchestrate` uses a bounded fixed set of perspectives: Cost
selects one, Balance two, and Power three. All selected perspectives are
read-only. Any failed perspective currently fails the whole orchestration
result, and outputs are concatenated rather than reduced to one canonical
semantic report.

Advisor is optional and disabled by default. When enabled for a task, the
runner adds up to the configured minimum of `maxRequests` and
`maxPerspectives` read-only consultations. Advisor output is additional
evidence; it cannot recurse, mutate, start Host Actions, or override policy,
verification, or a user decision.

The default role follows the public task kind. A host may select another
compatible role explicitly. A mechanical executor may escalate only before any
file, ignored-file, network, process, or external side effect exists. A
background mechanical executor that needs escalation pauses for supervisor
review rather than switching to a broader role automatically.

## Policy Resolution

Every proposed action is evaluated in this order:

1. immutable platform hard-deny;
2. task and worker-mode ceiling;
3. role ceiling;
4. user policy and repository-supplied deny constraints;
5. deterministic read-only fast path;
6. classifier decision when adaptive policy requires it;
7. durable supervisor approval when the decision is `require-approval`;
8. a command-specific sandbox profile and independent tool enforcement.

Policy decisions are `allow`, `deny`, or `require-approval`, with a risk level,
capabilities, constraints, reason, model, and policy hash. Action capabilities
are derived by the runtime and are authoritative. A classifier's claimed
capabilities are normalized to that exact set and retained in
`classifierEvidence`; a harmless over- or under-claim no longer fails the whole
decision. An unexpected material write, network, or unknown capability still
requires approval. Low and medium risk actions may be allowed within the effective
ceiling. High risk actions require approval. Critical and hard-denied actions
cannot be approved.

Adaptive Bash hard-deny checks use executable positions and path operands from
a bounded shell analysis rather than scanning undifferentiated command text.
Quoted grep patterns, output prose, and heredoc bodies are inert data. Actual
privilege, Git delivery/mutation, deployment, host provisioning, and protected
path operands retain their existing ceilings. The same analysis supplies the
deterministic read-only fast path when every command and composition operator is
proven safe.

An approval creates a capability lease scoped to one matching action or to the
same normalized action family for the current job. Leases include the job
generation, policy hash, role, action fingerprint, expiry, and consumption
state. They are checked and consumed atomically immediately before execution.
The policy hash commits to the effective project policy and its scope hash, so
a project-scope change invalidates outstanding leases.

## Enforced Project Policy

### Policy compilation and defaults

Project-profile task categories compile to the admitted `TaskKind` allowlist:
`analysis` maps to `ask` and `orchestrate`, `planning` to `plan`, `code-review`
to `review`, and `implementation` to `implement`; `discover` is a public
task kind for unknown requirements and evidence-backed convergence. Project-profile `dirs`
compile to relative roots for `read`, `search`, `write`, and `shell` operations.
Roots use directory-segment prefix semantics, not globs. An omitted task or
directory restriction permits all task kinds or the whole execution workspace
(`.`), respectively. An explicit empty task or directory list fails closed.
Repository-supplied policy may add deny rules but never broadens the effective
project policy.

### Durable per-job snapshot

A new job persists a non-secret v2 or v3 policy snapshot in its request. The snapshot
contains the effective project policy, its `scopeHash`, and the complete
`policyHash`; v3 additionally snapshots Decision Mode, Host Assistance, Advisor,
context budget, and doctrine controls. Queued, running, and resumed jobs use that snapshot; profile
edits affect only subsequently submitted jobs. The worker prompt includes the
project goal and canonical rendered policy text, but enforcement never depends
on model compliance with that prompt.

New configuration uses Adaptive mode. Explicitly stored modes remain unchanged,
and a legacy configuration with no mode stays Strict. New Host Assistance
policy defaults to Host-first/Reversible with Discovery gate review; missing
fields in a legacy saved policy remain User-only/Context-only with gate review
off. These compatibility rules are applied before the immutable Job snapshot is
created and never rewrite an existing Job.

Decision Mode does not compile all review and context limits into a preset in
the current runtime. It changes bounded orchestration depth and some
decision-attempt limits;
Host Assistance, context budget, and Advisor quotas remain independent fields.
The optional `first-principles-qds-v1` doctrine is snapshotted but is not yet
executed by the runner. It is metadata, not an active gate.

### Enforcement layers

Enforcement runs in this order:

1. The admission gate rejects a disallowed task kind before any job or model
   side effect.
2. The scoped Pi filesystem tools (`read`, `grep`, `find`, `ls`, `write`, and
   `edit`) validate every path against the bound policy before the underlying
   operation runs. File mutation uses no-follow descriptors and final
   descriptor identity checks; parent directories are revalidated by
   device/inode identity. Recursive search rejects every symlink entry and
   revalidates the traversed directory identities after the SDK operation.
3. In adaptive and lenient sandbox modes, the Bash write allowlist limits
   writes to the bound write and shell roots plus the sandbox temporary
   directory. `full-access` removes the OS sandbox, so this allowlist cannot
   constrain its raw Bash; only the tool boundary and postflight backstop remain,
   and out-of-scope writes made during the run are unobserved.
4. The postflight backstop requires every changed path to be under the write
   roots before checkpointing, verification, artifact delivery, or
   materialization eligibility.

The three write-enforcement layers are the tool boundary, sandbox write
allowlist, and postflight backstop. Admission is a separate, earlier gate.

### Isolated worktrees

For an isolated-worktree job, relative roots are rebound against the worktree
execution root. Changed paths remain relative to that same root, so no
original-workspace path translation is performed or needed.

### Rejections

Policy rejections use event `policy-rejected`, error codes
`task-kind-not-allowed`, `project-scope-invalid`,
`project-scope-violation`, and `policy-snapshot-invalid`, and stages
`admission`, `preflight`, `postflight`, and `materialization`. A postflight
scope violation fails the job with `errorCode: "project-scope-violation"` and
prevents checkpointing, verification, and delivery. The rejection can include
violating paths, `policyHash`, `scopeHash`, and safe next actions.

### Audit trail

Policy-engine decisions are appended to the job's `policy-events.jsonl`.
Scoped-tool `ProjectPolicyError` denials are also recorded there and increment
`policySummary.denied`. The audit export includes `policy-events.jsonl`, full
redacted Host Assistance records and WorkerAssessments, runtime
`effectAssessment` and classifier-normalization evidence, approval receipts,
and lease principals/constraints.
Postflight failure is reported in the terminal result and is not necessarily a
separate policy event.

### Capability leases and legacy

Leases remain bound to the job, generation, action fingerprint, expiry, and
complete policy hash. Because the v2 hash includes the effective policy and
`scopeHash`, a scope edit invalidates outstanding leases. `scopeHash` on a
lease record is optional audit metadata; authorization relies on the exact
`policyHash`. Existing leases are not migrated or rehashed.

Legacy v1 requests and an unrestricted v2 policy materialize
whole-execution-workspace behavior. Scoped Pi read and search tools enforce
read and search roots. Raw Bash reads in adaptive, lenient, and full-access modes
are not folder-scoped: they can read the workspace outside configured
directories, subject only to the existing sensitive read deny paths. This is an accepted
boundary, not an oversight: pinned `@carderne/sandbox-runtime@0.0.49` reads
are allow-by-default (deny-then-allow, with `allowRead` overriding `denyRead`).
Scoping Bash reads would require denying the workspace and re-allowing the
policy roots plus a complete, ecosystem-specific tooling read closure (such as
project metadata, dependencies, project references, temporary roots, and
runtime libraries) that cannot be derived from the project directories; this
would break normal tooling, and a broad re-allow could reopen already-denied
sensitive paths. Shell writes remain constrained to the write/shell roots in
adaptive and lenient modes (full-access has no OS sandbox and therefore no such
constraint on raw Bash); Strict mode, which exposes no Bash, is the option when
folder-level read confidentiality is required. Reconsider this boundary only if the sandbox
runtime gains a true allow-only read model, or the project supplies an
explicit, testable tooling-read dependency manifest.

## Sandbox Modes

- `strict` exposes scoped Pi tools and no Bash. It never calls the classifier.
- `adaptive` exposes OS-sandboxed Bash and evaluates non-trivial writes,
  process execution, and network destinations through the policy engine.
- `lenient` preserves the existing OS-sandboxed Bash and outbound network
  behavior. It remains subject to immutable filesystem, environment, socket,
  Git metadata, and credential restrictions.
- `autopilot` keeps `lenient`'s OS-sandboxed Bash and outbound network behavior —
  it needs the same sandbox backend and stays subject to the same immutable
  filesystem, environment, socket, Git metadata, and credential restrictions —
  but routine supervised shell (build/test, file moves/removes, fetches,
  interpreters, redirection, workspace-external paths) auto-runs unattended
  without stopping for supervisor approval. That routine-shell autonomy is
  intrinsic to the mode; plain `lenient` still gates it.
- `full-access` removes the plugin's own OS sandbox: the worker's Bash runs
  un-wrapped, an explicit opt-out of the "never fall back to an unsandboxed
  shell" invariant. It is a hybrid — for availability and runner creation it
  behaves like `strict` (no sandbox backend, so it is always selectable), and
  for policy decisions it behaves like `lenient` (allow-all). The worker's actual
  reach then depends entirely on the host's own sandbox, which the plugin cannot
  control or detect. Its shell environment is the real environment minus only the
  plugin's injected `SWARM_PI_CODE_PLUGIN_*` variables. Discovery experiment
  children and Host Action delivery children never inherit `full-access` or
  `autopilot`; they downgrade to `lenient` so they retain an OS sandbox.

Autopilot is the fifth Sandbox mode, not an autonomy preset. Selecting it keeps
`lenient`'s OS-sandbox isolation but makes routine supervised shell (build/test,
file moves/removes, fetches, interpreters, redirection, workspace-external paths)
auto-run unattended without stopping for supervisor approval; that autonomy is
intrinsic to the mode, `full-access` behaves the same way for routine shell, and
plain `lenient` still gates it. The `autoGitWrites` and `autoDelivery`
capabilities — available under Autopilot and `full-access` — lift `git
commit`/`push`/`merge` and `kubectl`/`helm`/`terraform` from immutable hard-deny
to actions the user may approve; they are never host-model auto-approved, and
`outwardApprovalGranularity` (`each-time` or `first-then-auto`) governs the
approval scope. sudo/su, plugin control paths, secrets, forbidden/loopback
domains, and direct Git-metadata writes stay enforced under both `full-access`
and Autopilot.

Adaptive network access starts denied. Trusted domains may pass deterministic
policy; all other destinations are evaluated by hostname, port, and resolved
address. Loopback, private networks, cloud metadata, local binding, and Unix
sockets remain hard-denied. Adaptive Bash calls are serialized within the
worker because the sandbox runtime owns process-global state.

Discover never holds that process-global manager across its whole workflow.
Research owns a read-only stage manager and disposes it before gate waiting;
the isolated Experiment child owns the next manager and reuses the parent's
Adaptive network authorizer; Convergence and each Advisor tool stage create
fresh read-only managers. Every path disposes in `finally`, so success, error,
cancellation, and timeout preserve the one-live-manager invariant. A failed
Experiment worktree remains durable until explicit cleanup.

## Classifier Boundary

The classifier is an internal Pi completion with no tools or extensions. It
receives the immutable delegation specification, role and policy summary,
truncated visible conversation, and proposed action. It does not receive tool
results, raw file contents, credentials, or the complete transcript.

Classifier output is validated as structured JSON. Malformed output receives
one repair attempt before the next configured classifier model is tried. If no
classifier succeeds, the action requires approval when a live approval channel
exists and is denied otherwise. A classifier can issue only capabilities
already present in the effective ceiling.

## Approval, Assistance, and Job Lifecycle

Jobs use `queued`, `running`, `awaiting-approval`, `awaiting-host`,
`awaiting-decision`, and explicit terminal states. A worker waiting for
approval or Host Assistance keeps its heartbeat, deadline, and signal handlers
active. Approval, assistance, human-decision, and terminal notifications have
separate IDs and matching acknowledgements.

Approval, denial, cancellation, timeout, and worker completion are serialized
through the state lock and generation fencing. A stale, expired, consumed, or
terminal-job approval is rejected. If a waiting worker disappears, the job is
orphaned and its approval cannot be applied to another worker generation.

`jobs wait` returns an approval-required event when intervention is needed. A
`supervised + wait` request uses the managed relay: its durable Job remains
supervised even though the worker is detached from the initiating process, and
the Host regains control within 15 seconds. Hosts use bounded waits and inspect
the durable job phase; a detached Host relay is not reported as Pi background
execution. `jobs watch --emit ndjson` replays allowlisted events for recovery,
but it never writes a receipt, approves, denies, responds, issues a lease, or
acknowledges a notification.

The relay launches its private `__worker` command with both a job ID and worker
token. Argument validation permits that job ID only for `__worker`, then rejects
an incomplete worker invocation; public commands retain their normal `--job`
restrictions.

The same managed relay is enabled when effective Host Assistance is active.
`jobs wait` may return `host-assistance-required` or
`human-decision-required`. Responses are fenced by Job, generation, session,
attempt, optional perspective, and request ID. New Worker requests carry a
complete WorkerAssessment, while legacy persisted requests remain readable.
The active Host model reads the full request and `adjudicationContext`, then
independently checks intent, role, roots, deny rules, action fingerprint,
policy hash, reversibility, rollback, and verification. A valid allow receipt
creates only one exact lease; an `ask-user` receipt leaves the request pending;
a `hard-deny` receipt resolves it without a lease. Only the first valid
response can be consumed by the live session. Secret egress is denied;
connector and non-public egress always require the user or are denied. See
[Host Assistance, Discovery, and Host Actions](host-assistance-discovery.md).

Strict cannot be expanded by a Host receipt. Host auto-allow is limited to
low/medium-risk public/read-only context or fully reversible in-scope changes
already authorized by the original task. Git metadata, workspace escape,
deletion, partial/irreversible changes, action recommendations, role escalation,
adoption, materialization, delivery, deployment, publication, messaging,
transactions, and uncertain live services stay outside the ceiling.

Full-access likewise cannot be reached through a Host receipt; it is chosen only
by explicit configuration, and selecting it removes the plugin's own OS sandbox
rather than granting a leased capability. Under Autopilot or full-access, the
`autoGitWrites` and `autoDelivery` capabilities lift `git commit`/`push`/`merge`
and deployment commands from hard-deny only to a user decision: the git/deploy ceiling forces
user fallback, so the host model never auto-approves them. The host relays the
user's decision with an approval scope taken from `outwardApprovalGranularity` —
`--approval-scope once` for `each-time` or `--approval-scope job` for
`first-then-auto`, whose job-scoped lease is fingerprint-exact and therefore only
auto-repeats identical commands.

## Verification Boundaries

Project scope, postflight changed-path validation, schema validation, hashes,
and artifact/materialization checks are deterministic control-plane evidence.
The implementation verifier is a separate strict read-only Pi review:
it is instructed not to run shell and classifies its response as verified,
refuted, or inconclusive. It is useful semantic review, not a trusted
command-running verification pipeline.

Discovery validates all required stage fields. The experiment child records
commands, tests, evidence, and a reported clean replay and runs in an isolated
worktree or scratch root. The control plane does not yet independently execute
the complete ExperimentSpec replay. Neither mechanism should be described as
deterministic build/test proof.

## Delivery

Read-only roles may run in the background. Background mechanical
implementation is separately opt-in and always receives a job-owned Git
worktree and branch. The trusted control plane may create a checkpoint artifact
after path validation; the Pi session cannot write Git metadata. The
independent semantic verifier must pass before the artifact is considered
deliverable. Refuted, failed, or orphaned work is preserved for inspection and
never merged automatically.
Safe-dirty implementation uses this isolated path automatically. After explicit
delivery approval, `jobs materialize` applies the verified patch to the original
HEAD while preserving pre-existing ephemeral files and leaves commit ownership
with the Host.

Experiment artifacts are permanently non-deliverable. A recorded Host Action
recommendation is also inert: only an explicitly confirmed
`jobs action-start` from a successful `implement` or `setup` parent can create
a separate isolated `host-broker` child with a new action-family lease.
