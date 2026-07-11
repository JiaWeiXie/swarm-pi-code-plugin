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
| `analyst` | `orchestrate` | `medium` | supervised, background | none |
| `mechanical-executor` | `implement` | `low` | supervised; optional background | worktree |
| `executor` | `implement` | `high` | supervised | worktree |
| `security-executor` | ask, review, implement | `high` | supervised | role dependent |
| `verifier` | internal | `medium` | internal | none; no Bash |
| `classifier` | internal | `medium` | internal | no tools |

Each role has an ordered model chain, maximum two model attempts, a capability
ceiling, and a verification policy. Requested and effective thinking levels
are recorded because Pi clamps thinking to model capabilities. Model fallback
handles provider or model failure only and never bypasses a policy decision.

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
capabilities, constraints, reason, model, and policy hash. Low and medium risk
actions may be allowed within the effective ceiling. High risk actions require
approval. Critical and hard-denied actions cannot be approved.

An approval creates a capability lease scoped to one matching action or to the
same normalized action family for the current job. Leases include the job
generation, policy hash, role, action fingerprint, expiry, and consumption
state. They are checked and consumed atomically immediately before execution.

## Sandbox Modes

- `strict` exposes scoped Pi tools and no Bash. It never calls the classifier.
- `adaptive` exposes OS-sandboxed Bash and evaluates non-trivial writes,
  process execution, and network destinations through the policy engine.
- `lenient` preserves the existing OS-sandboxed Bash and outbound network
  behavior. It remains subject to immutable filesystem, environment, socket,
  Git metadata, and credential restrictions.

Adaptive network access starts denied. Trusted domains may pass deterministic
policy; all other destinations are evaluated by hostname, port, and resolved
address. Loopback, private networks, cloud metadata, local binding, and Unix
sockets remain hard-denied. Adaptive Bash calls are serialized within the
worker because the sandbox runtime owns process-global state.

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

## Approval and Job Lifecycle

Jobs use `queued`, `running`, `awaiting-approval`, and explicit terminal
states. A worker waiting for approval keeps its heartbeat, deadline, and signal
handlers active. Approval and terminal notifications have separate IDs and
acknowledgements.

Approval, denial, cancellation, timeout, and worker completion are serialized
through the state lock and generation fencing. A stale, expired, consumed, or
terminal-job approval is rejected. If a waiting worker disappears, the job is
orphaned and its approval cannot be applied to another worker generation.

`jobs wait` returns an approval-required event when intervention is needed. A
host with a relay or watcher submits jobs with approval mode `wait`; a host
without a usable notification channel uses `deny` so execution cannot deadlock.

## Delivery

Read-only roles may run in the background. Background mechanical
implementation is separately opt-in and always receives a job-owned Git
worktree and branch. The trusted control plane may create a checkpoint artifact
after path validation; the Pi session cannot write Git metadata. Verification
must pass before the artifact is considered deliverable. Refuted, failed, or
orphaned work is preserved for inspection and never merged automatically.
