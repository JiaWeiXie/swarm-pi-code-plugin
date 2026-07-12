# Host Assistance, Discovery, and Host Actions

This reference defines the 0.5.0 worker-to-Host assistance loop, the fixed
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
freshness/version constraints, data classification, egress permission, and a
numeric budget. The runner checks the snapshotted class allowlist and context
budget before exposing the request to the Host.

`HumanDecisionRequest` asks the user to choose or clarify scope. It does not
create a capability lease.

`ActionRecommendation` records a proposed side effect. Recording it does not
execute anything; see [Host Actions](#host-actions).

### Routing and policy

The Host chooses the narrowest available mechanism and returns a typed result.
This routing happens in the Host adapter/session, not inside the runner.

- Workspace context stays subject to the effective project roots and protected
  paths.
- Public Web, docs, and paper requests do not require a private-data approval.
- Connector requests and non-public external egress enter the existing
  approval path. A workspace may deny connectors completely.
- Secret or credential egress is hard denied.
- Unknown skills or skills with undeclared/transitive side effects must be
  declined by the Host.

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
node scripts/pi-runner.mjs jobs host-requests --job <job-id> --json
node scripts/pi-runner.mjs jobs host-respond --job <job-id> --request <request-id> --response-file <bundle.json> --json
node scripts/pi-runner.mjs jobs host-decline --job <job-id> --request <request-id> --reason <reason> --json
node scripts/pi-runner.mjs jobs decisions --job <job-id> --json
node scripts/pi-runner.mjs jobs decide --job <job-id> --request <request-id> --response-file <decision.json> --json
```

Live Jobs use `awaiting-host` or `awaiting-decision`. The event stream adds
`host-assistance-required`, `host-assistance-resolved`,
`human-decision-required`, and `human-decision-resolved`. Events contain a safe
summary and correlation identifiers, not raw questions, prompts, secrets, or
private payloads. Replay is informational and never consent.

Static Host-prefetched context remains available through
`--host-context-file`. Use it when the needed sources are known before the Pi
session starts; use live assistance when the unknown emerges during work.

## Discovery

`discover` is one fixed, linear parent workflow. It is for uncertainty that
prevents a defensible feature definition, not for ordinary implementation.

### 1. Research

The analyst returns an `EvidencePlan` and `EvidencePack`. The schema requires
unknowns, source classes, acceptance criteria, budget, claims, citations,
conflicts, and remaining unknowns. When user gates are enabled, the Host must
obtain a Human Decision before the experiment stage starts.

### 2. Experiment micro-SDLC

The parent creates a durable isolated `experimenter` child. Its schema requires:

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

Current limitation: the 0.5.0 control plane validates the reported commands and
clean-replay result but does not independently execute the complete replay
sequence. Treat the report as structured experiment evidence, not as a trusted
deterministic replay receipt.

### 3. Convergence

The final stage returns a `FeatureDefinition` with summary, acceptance
criteria, non-goals, and a citation-backed `DecisionLedger`. A final Human
Decision gate controls whether the result can feed:

```bash
node scripts/pi-runner.mjs plan --host <host> --prompt-file <plan.md> --discovery-from <discovery-job-id> --json
```

The handoff revalidates that the source is a successful Discovery Job with a
passed stage report and final approval.

Advisor is optional and off by default. Enabled consultations are bounded,
read-only, context-only, and non-recursive. They cannot execute actions or
override policy, experiment validation, verification, or user gates.

Decision Mode currently changes bounded orchestration depth: Cost uses one
base perspective, Balance two, and Power three. Context budget and Advisor
quotas remain explicit settings. The `first-principles-qds-v1` option is stored
in PolicySnapshot v3, but 0.5.0 does not yet execute an automatic
Question/Delete/Simplify convergence pass.

## Host Actions

An action recommendation is inert until all of these are true:

1. the parent completed successfully;
2. the parent was `implement` or `setup`, preserving original mutation intent;
3. workspace Host Actions and the action class are enabled;
4. the recommendation was recorded with exact correlation;
5. the user explicitly confirms `jobs action-start`.

```bash
node scripts/pi-runner.mjs jobs action-start --job <parent-job-id> --request <recommendation-id> --json
```

The runner creates a separate isolated child with `principal: host-broker`, the
parent's snapshotted project policy, an action-family lease, postflight checks,
a verifier, an artifact, and a receipt. It never transfers the parent's writer
lease.

Local mutation and draft action classes are enabled by default. Remote write,
message, deploy, and transaction are disabled until the workspace opts in.
Advisor and coordinator roles cannot create Host Actions. An unknown external
outcome is terminal and is never retried automatically.
