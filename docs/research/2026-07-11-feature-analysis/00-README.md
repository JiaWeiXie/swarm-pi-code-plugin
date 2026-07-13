# Feature Analysis: Current Index

This directory is the maintained decision record for the feature research that
started on 2026-07-11. It is internal planning material, not user guidance.
Current product behavior belongs in the root READMEs and the references under
`docs/`.

The original research grew into several overlapping proposal lists. Those
superseded drafts were removed on 2026-07-13 after their surviving decisions
were consolidated here. Git history remains the source for the original
interviews, line-level observations, and proposal numbering.

## Maintained Documents

| Document | Purpose |
| --- | --- |
| [01-project-analysis.md](01-project-analysis.md) | Current 0.5.0 capability and gap assessment |
| [04-first-principles-review.md](04-first-principles-review.md) | Durable Question/Delete/Simplify decisions |
| [05-roadmap.md](05-roadmap.md) | Evidence-based remaining roadmap |
| [09-claude-codex-concurrency-plan.md](09-claude-codex-concurrency-plan.md) | Shared-control-plane concurrency contract and residual risks |
| [10-sandbox-host-autonomy-plan.md](10-sandbox-host-autonomy-plan.md) | Discover Sandbox lifecycle and Host-first adjudication implementation record |

## Current Outcome

The research no longer maps one proposal to one feature. The implemented
product is better described as four capability groups:

1. A bounded delegation control plane: enforced project policy, scoped tools,
   approval leases, durable jobs, worktree artifacts, audit export, and
   explicit materialization.
2. Generic Host Assistance: a worker can request bounded workspace, Web,
   documentation, paper, connector, skill, or human-decision help and consume
   one correlated response in the same live session.
3. Discovery: a fixed research → experiment → convergence workflow with
   schema-gated reports, human gates, and an isolated non-materializable
   experiment child.
4. Isolated Host Actions: an inert recommendation can become a separate
   `host-broker` child only after explicit confirmation and policy checks.

Several planned guarantees remain incomplete. In particular, the current
implementation does not yet provide a deterministic command-running verifier,
a runtime Review Coordinator, automatic Question/Delete/Simplify convergence,
or a control-plane replay of experiment commands. These gaps are first-class
roadmap items and must not be described as completed behavior.

## Explicit Non-goals

- arbitrary user-defined workflow DAGs;
- an external semantic/result cache for repository answers;
- a native MCP client inside Pi workers;
- cross-job or cross-workspace model-session reuse;
- automatic execution of Host recommendations;
- automatic commit, merge, push, deployment, or experiment materialization.
