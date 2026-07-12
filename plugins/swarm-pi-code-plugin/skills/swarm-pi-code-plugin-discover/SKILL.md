---
name: swarm-pi-code-plugin-discover
description: Run a fixed, evidence-backed discovery workflow for unknown requirements, research, experiment planning, and convergence. Keep experiments reproducible, testable, and non-materializing.
---

# Discover With Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

1. Write a self-contained discovery brief naming the unknowns, constraints, evidence acceptance criteria, freshness/version requirements, and user gate before experimentation.
2. Run `$RUNNER discover --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode supervised --approval-mode "$APPROVAL_MODE" --json`.
3. Retain the Job ID after `approval-required` or `wait-timed-out`, then poll with bounded `$RUNNER jobs wait --job <job-id> --wait-timeout-ms 15000 --json` calls. Present matching approvals and terminal notifications; never auto-approve or auto-decide.
4. Treat the three fixed reports as gates: research/evidence plan, experiment micro-SDLC, and definition/convergence. The runner schema-validates every stage. Research must pass its Human Decision gate before the experiment. The experiment runs as a durable, isolated `experimenter` child Job and cannot pass without a hypothesis, baseline/control, locked dependencies, fixture, seed/data hash, setup/run/test/verify/cleanup commands, metrics, tolerance, explicit evidence, tests, and clean replay.
5. Treat `supported`, `refuted`, and `inconclusive` as the only experiment conclusions. Experiment artifacts are always `deliverable:false` and cannot materialize. A DiscoveryResult is a decision input, not a product artifact; after the final Human Decision gate, hand it to `$RUNNER plan ... --discovery-from <discovery-job-id>` so provenance and verification are revalidated.

The parent remains read-only while the experiment runs in its separate isolated child workspace. Never write to or transfer a writer lease from the parent worktree.
