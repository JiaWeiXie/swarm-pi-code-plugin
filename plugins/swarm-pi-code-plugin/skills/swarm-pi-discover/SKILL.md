---
name: swarm-pi-discover
description: Run a fixed, evidence-backed discovery workflow for unknown requirements, research, experiment planning, and convergence. Keep experiments reproducible, testable, and non-materializing.
---

# Discover With Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

1. Write a self-contained discovery brief naming the unknowns, constraints, evidence acceptance criteria, freshness/version requirements, user gate, and resource-aware experiment plan before experimentation. Record expected command fan-out and keep expensive setup, run, test, verify, cleanup, and replay work sequential.
2. Run `$RUNNER discover --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`.
3. Retain the Job ID after `approval-required`, a gate, or `wait-timed-out`, then poll with bounded `$RUNNER jobs wait --job <job-id> --wait-timeout-ms 15000 --json` calls. Inspect each full request and immutable Job policy snapshot. The active Host may approve an in-scope reversible Experiment action or a complete bounded Discovery gate only when Host-first and the matching automatic scope are enabled; write an exact receipt. Fall back to the user for missing evidence, high risk, or any runtime rejection.
4. Treat the three fixed reports as gates: research/evidence plan, experiment micro-SDLC, and definition/convergence. The runner schema-validates every stage. Research must pass its decision gate before the experiment. The experiment runs as a durable, isolated `experimenter` child Job and cannot pass schema validation without a hypothesis, baseline/control, locked dependencies, fixture, seed/data hash, setup/run/test/verify/cleanup commands, metrics, tolerance, explicit evidence, tests, and a reported clean replay. The control plane does not independently replay all of those commands.
5. Treat `supported`, `refuted`, and `inconclusive` as the only experiment conclusions. Experiment artifacts are always `deliverable:false` and cannot materialize. A DiscoveryResult is a decision input, not a product artifact; after the final Human Decision gate, hand it to `$RUNNER plan ... --discovery-from <discovery-job-id>` so provenance and verification are revalidated.

The Job keeps the Sandbox mode, roots, network policy, and policy hash captured at start. Research disposes its read-only Sandbox before waiting at a gate; Experiment creates and disposes its own Sandbox in the isolated child worktree and uses the shared Adaptive network authorizer; Convergence and Advisor tool use create fresh read-only stage Sandboxes. The parent never owns a writer lease, and a failed Experiment remains inspectable until explicit cleanup.
