# Host Assistance and Discovery

Host Assistance is the generic worker-to-host loop shared by research, planning,
review, implementation, and advisory work. A worker describes an unknown and
acceptance criteria; the Host chooses the narrowest allowed workspace search,
Web, Context7/official docs, paper, connector, or installed skill capability.
The worker never chooses a provider, query engine, connector, or shell command.

Every response is a bounded `HostContextBundle` with claims, citations or
provenance, retrieval time, version constraints, conflicts, unknowns,
redactions, and hashes. Host context is marked `[UNTRUSTED_HOST_CONTEXT]` and
cannot alter system/project policy, task intent, experiment specs, or user
gates. Human clarification uses a decision request and never creates a
capability lease. Requests are correlated to the same Job, generation, session,
attempt, and perspective; duplicate or stale responses are not consumed. The
live `request_host_assistance` tool keeps the worker promise and heartbeat alive
while the Host handles `host-assistance-required` or `human-decision-required`.
Requests, safe events, responses, delivery, hashes, and consume-once state are
durable; `.pending` artifacts are reconciled after a crash. Static,
host-preloaded `--host-context-file` remains available.

## Discovery

`discover` is a fixed linear parent workflow with three reports:

1. Research & Synthesis creates an Evidence Plan and an EvidencePack.
2. Experiment micro-SDLC freezes a reproducible, testable, evidence-backed
   ExperimentSpec. It requires a hypothesis, baseline/control, locked
   dependencies, fixture, seed/data hash, setup/run/test/verify/cleanup,
   metrics, tolerance, and clean replay. Conclusions are only `supported`,
   `refuted`, or `inconclusive`.
3. Definition & Convergence creates the FeatureDefinition, acceptance
   criteria, non-goals, and DecisionLedger, then applies optional
   Question/Delete/Simplify reduction after doctrine-neutral review.

The runner schema-validates every required stage field. Research must pass a
Human Decision gate before experimentation. The experiment runs as a durable
isolated `experimenter` child Job with postflight and verification; its artifact
is always `deliverable:false` and can never be materialized. Convergence must
pass its final Human Decision gate before `plan --discovery-from <job-id>` will
accept the result. Each stage has a verification result and canonical report.

Advisor is optional and disabled by default. When enabled, the Review
Coordinator uses the snapped Decision Mode and Advisor quotas to choose direct
or bounded panel review. Advisor consultations are context-only and cannot
recurse, execute actions, weaken safety, or bypass deterministic verification
and user gates.

## Host Actions 0.5

An `ActionRecommendation` is inert until the Host explicitly records it and the
user confirms `jobs action-start --job <parent> --request <id>`. Only successful
terminal `implement` or `setup` parents have original mutation intent. The
runner creates a separate isolated child with `principal: host-broker`, the
same snapshotted policy/scope, a bounded action-family lease, postflight,
verifier, `host-action` artifact, and receipt. It never transfers the parent
writer lease. Local mutation and draft actions are enabled by default; remote
write, message, deploy, and transaction are disabled until the Workspace opts
in. Unknown external outcomes are terminal and are never retried automatically.
