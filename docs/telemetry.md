# Local telemetry, reports, and dashboard

This slice adds a local-only usage collector on top of the versioned P0
contracts. Every terminal Job persists bounded `attempt` events in the existing
state directory; the collector never sends data to a provider, starts a
sidecar, or creates a second service. `TelemetryRecorder` remains available as
an inert library default for callers that do not opt into the file store.

## Data boundary

The persisted event contains only:

- an opaque Job/event identifier, task kind, role, provider/model labels, and
  attempt number and Pi automatic retry count;
- UTC start, finish, and recorded timestamps, duration, and terminal outcome;
- input, output, and cached-input token counters when the provider reports them.

Strict parsers and privacy validation reject prompts, completions, reasoning,
source text, paths, URLs/endpoints, personal data, secrets, credentials, raw
provider configuration, Git metadata, arbitrary text, unknown fields, and
unsupported schema versions. Unsafe provider/model labels become
`unknown-custom`; their raw values are never persisted. Local models remain
usage-only.

## Storage and lifecycle

The file store writes newline-delimited JSON to:

```text
<existing state directory>/telemetry/events.jsonl
```

The directory is mode `0700` and the event file is mode `0600`. A terminal Job
is marked complete before telemetry is appended. A telemetry write or parse
failure is diagnostic only and cannot turn a completed Job into a failed Job.
The report marks malformed or unreadable history as degraded. Existing Job
pruning does not silently delete telemetry history; removing the state directory
remains an explicit local state-management action.

Each fallback attempt is retained when the runner has a measured session
boundary. Attempts that fail before a session starts still retain outcome and
duration, but have no usage counters. The collector is not a billing ledger and
does not retain prompt or response text.

## Detailed report contract

`telemetry report` returns a versioned JSON object with:

- `summary`: attempts, outcomes, duration, token totals, and automatic retry totals;
- `byModel`, `byRole`, and `byTaskKind`: bounded aggregation buckets;
- `details`: newest-first attempt records, limited to 100 by default and 500 at
  most;
- `health`, `range`, and an explicit `cost` state.

Use the CLI without starting a model session:

```bash
mise exec -- node scripts/pi-runner.mjs telemetry report --json
mise exec -- node scripts/pi-runner.mjs telemetry report --from 2026-07-01T00:00:00.000Z --limit 50 --json
```

The report always returns `cost.status: "unknown"` with
`reason: "missing-pricing"` in this release. Static pricing calculation
helpers remain available for explicit fixtures, but no pricing source is
authoritative enough for automatic dashboard amounts. Mixed currencies, stale
fixtures, and local models therefore cannot be collapsed into a currency total.

## Dashboard

Start the local dashboard with:

```bash
mise exec -- node scripts/pi-runner.mjs dashboard
```

The server binds to `127.0.0.1`, uses a random session token, enforces the same
loopback and CSP boundary as setup, and closes after its normal timeout or an
explicit Ctrl-C. The dashboard displays summary cards, model/role breakdowns,
recent attempt details, empty/degraded states, and the unavailable-cost label.
It is not a provider dashboard, an upload endpoint, a billing console, or a
replacement for `jobs export --audit`.

## Cost semantics

The existing pricing fixtures use integer minor currency units and deterministic
half-up rounding. `calculateCost` preserves `unknown`, `stale`,
`unsupported-dimension`, and `local-usage-only` states. The dashboard and
report do not call that helper with invented prices and never claim billing
accuracy.

## Verification boundary

Tests cover closed event parsing, privacy rejection, JSONL persistence,
aggregation, fallback/outcome lifecycle capture, terminal Job integration,
CLI argument validation, dashboard CSP/token checks, and dashboard script
parsing. The collector does not independently replay provider calls or claim a
performance benchmark. Host-owned verification must still inspect the diff,
runtime side effects, and fresh checks before delivery.
