# Execution Time and Recovery

Swarm Pi 0.23 separates **liveness recovery** from the **hard active-work
limit**. It does not infer a time limit from model name or size.

New-job defaults are 1 hour for `ask`, `plan`, and `review`; 4 hours for
`implement`, `setup`, and `scaffold`; and 8 hours for `discover` and
`orchestrate`. Configuration offers 1, 4, 8, and 12 hours. These are product
policy choices informed by public observations, not a provider SLA: published
agent turns vary from seconds to long-tail tens of minutes, while long API work
can run for hours. Existing snapshots keep their saved 12–24 hour deadline.

`--hard-run-limit-ms` is the canonical CLI option. `--timeout-ms` remains a
deprecated 0.23 alias. `--wait-timeout-ms` limits only the Host's observation
call and never stops a Job.

## Four independent signals

1. A 15-second worker heartbeat proves the process exists.
2. Trusted progress is a stream delta, thinking delta, tool transition, retry,
   compaction, or child-job transition.
3. Liveness probes inspect the existing session, transport, active tool,
   process group, and provider status where available; they never send a second
   LLM prompt.
4. The hard limit ends active work even when all other signals are healthy.

After five idle minutes, probes repeat every minute with a 10-second response
deadline. Three failed probes start a ten-minute recovery grace and a final
probe. A quiet but reachable provider becomes `suspected-stalled`, not a false
timeout. Final loss produces compatible `timed-out` status with
`unresponsive-timeout`; the absolute cap uses `hard-limit-exceeded`.

Active time includes provider work, queueing, tools, retries/backoff,
compaction, and child work. Explicit approval, Host Assistance, and Human
Decision waits pause the budget. Resume preserves consumed time; child nodes
receive at most their parent's remaining budget. Partial evidence, telemetry,
and audit records remain readable after termination.

See also [Configuration](configuration.md) and [Architecture](architecture.md).
