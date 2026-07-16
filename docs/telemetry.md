# Local telemetry P0 contract

This P0 slice defines a safe foundation for a possible future usage dashboard;
it does not collect, persist, transmit, price, or display telemetry yet.
`TelemetryRecorder` defaults to a no-op implementation, so no files, sockets,
processes, network requests, home-directory folders, or durable state are
created by this slice.

## Data boundary

The versioned contracts contain only bounded usage counters, safe provider and
model labels, UTC timestamps, pricing fixtures, cost status, collector health,
and migration metadata. Unknown fields and unsupported schema versions are
rejected. Prompts, completions, reasoning, source text, paths, URLs/endpoints,
personal data, secrets, credentials, raw provider configuration, Git metadata,
and arbitrary free-form text are prohibited.

Provider/model values must be safe public identifiers. Unsafe custom values are
represented as `unknown-custom` and are never persisted as raw input. Local
models are reported as usage-only; this slice never invents a monetary amount
for them.

## Cost semantics

Pricing fixtures use integer minor currency units per integer token unit. Each
dimension is multiplied with `bigint` arithmetic and rounded half-up before the
dimension amounts are summed. Pricing intervals must be ordered, non-overlapping
for the same provider/model/dimension, and selected by their effective UTC
dates. Currency amounts are never combined: mixed currencies remain a visible
`unsupported-dimension` result with a separate amount per currency.

Missing usage is `unknown`; incomplete pricing is `unsupported-dimension` or
`unknown` when no dimension can be priced; expired fixtures are `stale`; local
models are `local-usage-only`; malformed inputs are `unknown` with an
`invalid-input` reason. No automatic pricing retrieval or provider API access
is included.

## Workflow boundary

The prior discovery result for sidecar viability is `inconclusive`, and no
performance claim is made here. Storage, asynchronous queues, sidecars, IPC,
writer election, retention, delete/export, dashboard UI, lifecycle call sites,
automatic pricing refresh, credentials, deployment, materialization, commits,
and pushes require a later plan and explicit authorization.

The Host must compare Pi output with the repository, actual diff, runtime side
effects, and fresh verification before accepting any future implementation.
