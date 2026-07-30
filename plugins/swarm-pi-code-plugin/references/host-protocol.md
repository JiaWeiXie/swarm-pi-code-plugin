# Shared Host Protocol

Load this reference when a Skill creates or continues a durable Job.

## Node contract

Every Skill is both a standalone node and an internal Workflow node. Its input
is the user request plus bounded evidence; its output is an envelope containing
`result`, `evidence`, `verification`, `terminationReason`, and `nextActions`.
The Host may route `discover → plan → implement → review → fix/verify`, but a
clear one-step request stays a single node. Do not invent user-authored graphs.

## Durable control loop

1. Read readiness and pending notifications before delegation.
2. Submit the narrowest Skill with explicit scope, acceptance evidence, and
   protected boundaries.
3. Preserve every Job ID, immutable snapshot, continuation, and artifact.
4. Treat `wait-timed-out` as a bounded Host wait only; poll again or report the
   durable state. It never means the Job was terminated.
5. Only the active Host turn may resolve an in-policy approval, assistance, or
   human decision. Hooks, probes, watchers, recovery, and replay may notify
   but never decide, acknowledge, resume, or expand authority.
6. Complete only after a terminal result, relevant verification, and an
   explicit delivery state. Commit, merge, push, deploy, message, transaction,
   adoption, and materialization remain separate user decisions.

## Time and recovery

`--hard-run-limit-ms` is the canonical active-work cap; `--timeout-ms` is the
0.23 compatibility alias. The limit covers provider execution, queue, tools,
retries, compaction, and child work; explicit approval, Host, and human-decision
waits pause it. Resume never refreshes consumed time. Children receive no more
than their parent’s remaining budget.

Worker heartbeat proves only that the process exists. Trusted stream, thinking,
tool, retry, compaction, and child transitions reset the idle probe. A probe
does not send another LLM prompt: it checks the existing session, transport,
active tool, process group, or provider status. A reachable but quiet session
is `suspected-stalled`, not a timeout. Repeated probe failure ends as
`timed-out` with `unresponsive-timeout`; the independent cap ends as
`timed-out` with `hard-limit-exceeded`. Preserve partial evidence before abort.

New-task defaults are 1h for ask/plan/review, 4h for implement/setup/scaffold,
and 8h for discover/orchestrate. Configuration may select 1/4/8/12h. These are
product policy informed by published observations, not a provider SLA.

## Migration and safety

Host Actions 0.5 is removed. Legacy `hostActions` values normalize to a disabled
audit tombstone; old `jobs action-start` calls return `host-actions-removed` and
never execute. Pending legacy records are evidence only.

If state writes return `EPERM`, preserve the request and existing configuration.
Do not create state files manually; retry the same local runner outside the
outer Host sandbox only with user approval. Host Assistance remains bounded,
correlated, consume-once, and cannot alter intent or policy.
