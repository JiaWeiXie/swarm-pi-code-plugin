---
name: swarm-pi-discover
description: Run Pi's fixed, evidence-backed research, experiment, and convergence workflow for unknown requirements or unresolved technical claims. Use when reproducible investigation and Human Decision gates are needed; use ask for one answer, plan when evidence is already sufficient, and never materialize discovery artifacts.
---

# Discover With Pi

Read the [cross-host control protocol](../../references/host-protocol.md) and use its Skill Control Loop.

1. Write a self-contained discovery brief with unknowns, constraints, evidence acceptance criteria, freshness requirements, user gates, and a resource-aware experiment plan. Keep expensive setup, run, test, verify, cleanup, and replay commands sequential.
2. Run `$RUNNER discover --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`.
3. For every approval, gate, Host Assistance request, or timeout, use the control loop. Apply Host-first review only within the snapshotted scope and exact receipt ceiling; otherwise ask the user.
4. Enforce the three schema-validated gates: research/evidence plan, experiment micro-SDLC, and definition/convergence. Require hypothesis, baseline/control, locked dependencies, fixture, seed or data hash, exact sequential commands, metrics, tolerance, evidence, tests, cleanup, and reported clean replay. The control plane validates the report but does not independently replay every command.
5. Accept only `supported`, `refuted`, or `inconclusive`. Keep every experiment artifact `deliverable:false`; after the final Human Decision gate, pass the DiscoveryResult to `$RUNNER plan ... --discovery-from <job-id>`.

Every stage inherits the immutable Job policy. Research, convergence, and Advisor tool use own fresh read-only stage Sandboxes; the isolated experimenter child owns and disposes its Sandbox and uses the shared Adaptive network authorizer. The parent never owns a writer lease.
