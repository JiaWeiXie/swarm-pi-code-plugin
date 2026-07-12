---
name: swarm-pi-code-plugin-orchestrate
description: Run bounded read-only Pi perspectives for complex repository analysis, architecture, migration, or risk assessment from Codex or Claude Code. Do not use for file modification.
---

# Orchestrate Pi

Read the [cross-host control protocol](../../references/host-protocol.md).

Version 0.5.0 uses a bounded fixed panel: Cost selects one base perspective, Balance two, and Power three. Advisor participation is optional, context-only, and quota-limited; it cannot override policy, verification, or user gates. The Host must synthesize the returned sections because the runtime does not yet emit a canonical coordinator report.

1. Decide whether the task depends on external facts. Prefetch one cited context file when the sources are known; otherwise allow each perspective to request bounded live Host Assistance. Preserve URLs, retrieval date, verified claims, unknowns, and version constraints.
2. Write one self-contained brief that names the decision, constraints, shared EvidencePack, and evidence required. The persisted job result is the durable handoff.
3. Run `$RUNNER orchestrate --host "$HOST" --role analyst --prompt-file "$PROMPT_FILE" --execution-mode "$EXECUTION_MODE" --approval-mode "$APPROVAL_MODE" --json`. With `supervised + wait`, the managed relay returns within 15 seconds with a terminal result, `approval-required`, or `wait-timed-out`.
4. Retain the Job ID after `approval-required` or `wait-timed-out`, then poll with `jobs wait --wait-timeout-ms 15000 --job <job-id> --json` until terminal. Present every approval's tool, action, risk, capabilities, reason, and expiry before asking the user for approve or deny. Never auto-approve, and do not leave one opaque shell command running.
5. An approve or deny decision acknowledges only its matching approval notification; terminal notifications remain for explicit Host acknowledgement.
6. Reconcile every selected base perspective and optional Advisor consultation against repository evidence, identify disagreements or failed perspectives, and present one coherent Host-owned conclusion with the source job ID.
7. If implementation is the accepted next step, copy the accepted evidence, constraints, done criteria, and source job ID into the implementation brief. Do not ask the user to choose an internal role.

All perspectives are read-only. Start implementation only after explicit mutation intent. Do not describe long inline code as working code unless the Host validates it with the relevant parser, typecheck, or test.
