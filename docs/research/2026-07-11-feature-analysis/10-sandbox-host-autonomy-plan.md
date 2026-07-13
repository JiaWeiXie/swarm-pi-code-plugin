# Discover Sandbox and Host Autonomy Plan

Date: 2026-07-13

Status: implementation record; runtime, documentation, and Host adapter work in
progress

## Incident and Root Cause

The failing Evobox Discover Job was created with an old snapshot whose project
roots were empty. Independently of that stale scope, the immediate singleton
failure came from Sandbox ownership. The Discover parent created one
process-global Sandbox runtime and held it from Research through Gate waiting.
The Experiment child then ran in the same Node process and attempted to create
a second runtime manager. The upstream Sandbox backend permits only one live
manager per process, so the child failed before it could perform the planned
experiment.

Changing Discover to Strict would hide this lifecycle bug while also changing
the Job's snapshotted policy. That is not an acceptable fix. Discover must use
the mode, roots, and network rules selected when the Job starts, and each
stage-specific policy view must be cryptographically bound to that immutable
parent snapshot.

## Decisions

### Configuration and compatibility

- A newly created configuration starts in Adaptive mode.
- A persisted configuration with an explicit mode keeps that mode.
- A legacy configuration with no mode continues to normalize to Strict. This
  avoids silently granting shell or network capabilities to an existing
  project.
- New Host Assistance policy defaults are Host-first review, Reversible scope,
  and Discovery gate auto-review. Missing fields in a legacy saved policy
  normalize to User-only, Context-only, and no gate auto-review.
- Every running Job uses its immutable policy snapshot. Saving configuration
  affects only later Jobs.
- Adaptive requires a classifier once a primary model is selected. The primary
  model becomes the initial classifier when the new configuration does not yet
  contain an explicit classifier selection. An incomplete provider setup may be
  saved, but Job readiness remains fail-closed until the model is available.

### Stage-scoped Sandbox ownership

Discover no longer owns a Sandbox for its full lifetime. Each stage that needs
tools creates one runtime and disposes it in `finally`:

1. Research uses a read-only Sandbox.
2. The Sandbox is disposed before the Research gate is surfaced.
3. Experiment uses a separate implementation Sandbox in the job-owned isolated
   worktree.
4. The child inherits the parent's mode, roots, trusted domains, and network
   policy. It uses the same Adaptive network authorizer as its parent. Its
   `experimenter` role and disabled Advisor produce a distinct stage policy
   document, so it must not reuse the parent's hash. Instead, the canonical v3
   child snapshot includes the exact parent hash as `parentPolicyHash`; this
   lineage binding is itself covered by the child stage hash.
5. The Experiment Sandbox may read its linked worktree Git administrative
   linkage for baseline and clean-replay checks, but those paths remain
   deny-write. On macOS it prefers the direct Command Line Tools binary so the
   `xcrun` shim does not require a host-cache write.
6. Convergence and each optional Advisor consultation use fresh read-only
   Sandboxes.
7. Success, error, cancellation, and timeout paths all dispose their current
   stage runtime. Gate waiting never owns a Sandbox.

This sequencing preserves the upstream process-global singleton invariant. A
failed Experiment keeps its isolated worktree and durable Job evidence for
investigation; cleanup remains an explicit Host or user action.

### Host Assistance admission

`request_host_assistance` is a control-plane request, not an ordinary Worker
tool action. It therefore bypasses only the generic tool classifier and then
enters its own typed admission path. That path still enforces the snapshotted
mode, context classes, data classification, request quota, session uniqueness,
fan-out, expiry, and durable correlation. Bash, filesystem, and network tools
continue through the generic classifier.

Every new Worker request must include a `WorkerAssessment` describing purpose,
blocker, minimum access, exact targets, side effects, exposure, failure modes,
mitigations, reversibility, rollback, verification, proposed risk, and a safe
fallback. Legacy persisted requests may omit the field so old Jobs remain
readable. Worker risk is evidence, not authority; the Host model independently
adjudicates it.

### Host-first adjudication

Only the model in the active Codex or Claude Code Host turn may produce an
automatic decision. It reads the full durable request, the original Job intent,
role ceiling, project policy, Sandbox roots, action fingerprint, and policy
hash. If the action is within the snapshotted ceiling, it writes a
`HostAdjudicationReceipt` and invokes the existing CLI with
`--adjudication-file`.

The runtime validates the receipt again. A valid Host-model allow must:

- identify the same Host and exact v3 policy hash;
- match the exact 64-character action fingerprint;
- state a low or medium assessed risk, intent match, and `autoResolved: true`;
- contain a complete WorkerAssessment;
- remain within the configured Context-only, Read-only, or Reversible ceiling;
- use a one-action capability lease for tool approvals.

Read-only public context may be auto-resolved. A reversible local mutation may
be approved only when the original Job already carries mutation intent and the
target remains inside the snapshotted workspace or job-owned worktree.
Discovery decisions may be auto-resolved only for an identified Discovery gate
when gate auto-review is enabled, and an automatic decision may only choose the
bounded `approve` outcome.

Strict mode cannot be expanded by a Host receipt. Private connectors, secrets,
Git metadata, workspace escapes, partial or irreversible changes, deletions,
delivery actions, deployment, publication, messaging, transactions, action
recommendations, role escalation, and uncertain intent remain outside the
automatic ceiling. They fall back to the user or are hard denied by policy.

Recovery hooks, SessionStart, watch replay, timeouts, and background processes
only project pending or resolved events. They never generate a receipt, resolve
a request, or issue a lease. Replayed events use stable identifiers; resolving
the same durable request twice is rejected.

### Audit and notification

The receipt records the principal, Host and optional model identifier, decision,
risk, rationale, constraints, intent match, fingerprint, policy hash,
auto-resolution flag, and timestamp. Approval and Host Assistance resolution
events expose only the safe principal/risk/auto-resolution summary. Full
requests, assessments, receipts, and leases are preserved in the redacted Job
audit export.

The existing commands keep their manual meaning when no receipt is supplied:

```text
jobs approve --job JOB --approval ID [--approval-scope once|job]
jobs host-respond --job JOB --request ID --response-file RESPONSE
jobs decide --job JOB --request ID --response-file RESPONSE
```

An active Host model adds `--adjudication-file RECEIPT`. The runtime does not
trust the filename or the Host narrative; it revalidates the durable pending
record, snapshot, fingerprint, and ceiling immediately before changing state.

## Verification Matrix

The implementation is accepted only when all of these properties are covered
by executable tests or packaged-Host validation:

| Case | Expected result |
| --- | --- |
| Research → Gate → Experiment → Convergence | Stage runtimes never overlap and each disposes |
| Experiment failure, cancellation, timeout | Current runtime disposes; evidence remains |
| Adaptive child network request | Uses the shared authorizer and snapshotted policy |
| Legacy config missing new Host fields | User-only; no automatic expansion |
| Public read-only context | Active Host may resolve with an exact receipt |
| Reversible in-scope implementation write | One exact Host-model lease |
| Fingerprint, target, command, or policy changes | Receipt or lease is invalid |
| Strict Job | Host receipt cannot add capabilities |
| Private connector, secret, Git, delivery, live mutation | User decision or hard deny |
| SessionStart/watch replay | Notification only; no receipt or lease |
| Duplicate resolution/replay | Stable event and no duplicate state transition |
| Codex and Claude fixture | Same decision and fingerprint; identity metadata may differ |

The final development verification also includes targeted tests, typecheck,
lint, formatting, the full test suite, packaged runtime parity, documentation
impact checks, skill validation, both plugin manifests, the Claude development
plugin validator, Codex cachebuster/reinstall checks, and a controlled fresh
Discover fixture inside this plugin. The fixture must pause at both durable
review gates, prove that no Sandbox is held while waiting, resolve each gate
with an exact Host receipt, and complete the isolated Experiment without using
an external product repository.

An earlier external integration validation exposed a false negative in
Host-first shell classification: a bounded `sha256sum` over two workspace files
received a generic partially-reversible assessment and waited until the Job
deadline.
Checksum inspection is now part of the narrow trusted read-only grammar, with
tests retaining fail-closed traversal and external absolute-path behavior.

A later controlled validation found the same false negative for toolchain
version probes and non-writing file comparisons. The grammar now recognizes
only bounded `rustc`/`cargo` version forms and two-file `cmp`/`diff` forms;
compilation, tests, output options, traversal, and external paths remain outside
the automatic ceiling.

Screenshot-Impact: reviewed-current — `parentPolicyHash` and the linked
worktree Git read boundary are internal Job/audit and runtime behavior. They add
no setup field or layout change, so the current Execution Safety and Host
Assistance screenshots remain accurate.

## Rollout and Rollback

This change does not bump the release version. The development Codex manifest
cachebuster may change so a new Codex task loads the updated skill and runtime.
The installed-version checker must still report one synchronized semantic
version for both Hosts.

Runtime rollback is conservative: disable Host-first review (User-only), disable
Discovery gate auto-review, or select Strict for later Jobs. Existing running
Jobs retain their original snapshots. No rollback path rewrites a durable Job,
deletes an experiment worktree, or broadens a lease.
