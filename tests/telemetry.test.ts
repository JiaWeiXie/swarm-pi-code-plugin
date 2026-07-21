import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  calculateCost,
  calculateDimensionCost,
  createNoopTelemetryRecorder,
  parseCollectorHealth,
  parseCostStatusSnapshot,
  parseMigrationMetadata,
  parsePricingSnapshot,
  parseTelemetryEvent,
  parseUsageSnapshot,
  assertNoProhibitedFields,
  classifyProviderModel,
  redactTelemetryEvent,
  PrivacyViolation,
  type PricingSnapshot,
  type UsageSnapshot,
  appendTelemetryAttempts,
  readTelemetryEvents,
  readTelemetryReport,
} from "../src/index.js";

const recordedAt = "2026-07-16T12:00:00.000Z";

function usage(overrides: Record<string, unknown> = {}): UsageSnapshot {
  return parseUsageSnapshot({
    schemaVersion: 1,
    provider: "openai",
    model: "gpt-5",
    capturedAt: recordedAt,
    inputTokens: 1500,
    outputTokens: 500,
    ...overrides,
  });
}

function pricing(overrides: Partial<PricingSnapshot> = {}): PricingSnapshot {
  return parsePricingSnapshot({
    schemaVersion: 1,
    asOf: recordedAt,
    entries: [
      {
        provider: "openai",
        model: "gpt-5",
        currency: "USD",
        dimension: "inputTokens",
        rateMinorUnits: "5",
        unitTokens: 1000,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-12-31T00:00:00.000Z",
      },
      {
        provider: "openai",
        model: "gpt-5",
        currency: "USD",
        dimension: "outputTokens",
        rateMinorUnits: "7",
        unitTokens: 1000,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-12-31T00:00:00.000Z",
      },
    ],
    ...overrides,
  });
}

test("strict parsers accept partial usage and reject unknown or malformed fields", () => {
  const partial = usage({ outputTokens: undefined, cachedInputTokens: 2 });
  assert.equal(partial.inputTokens, 1500);
  assert.equal(partial.cachedInputTokens, 2);
  assert.equal(partial.outputTokens, undefined);

  assert.throws(
    () => parseUsageSnapshot({ ...partial, prompt: "never collect this" }),
    /unknown field prompt/,
  );
  assert.throws(() => parseUsageSnapshot({ ...partial, inputTokens: -1 }), /non-negative integer/);
  assert.throws(
    () => parseUsageSnapshot({ ...partial, schemaVersion: 2 }),
    /unsupported schema version/,
  );
});

test("health and migration parsers are closed and exhaustive", () => {
  assert.deepEqual(
    parseCollectorHealth({
      schemaVersion: 1,
      status: "disabled",
      reason: "not-enabled",
      checkedAt: recordedAt,
    }),
    { schemaVersion: 1, status: "disabled", reason: "not-enabled", checkedAt: recordedAt },
  );
  assert.throws(
    () =>
      parseCollectorHealth({
        schemaVersion: 1,
        status: "arbitrary",
        reason: "unknown",
        checkedAt: recordedAt,
      }),
    /unsupported value/,
  );
  assert.throws(
    () =>
      parseTelemetryEvent({
        schemaVersion: 1,
        eventId: "evt-1",
        kind: "health",
        recordedAt,
        health: { schemaVersion: 1, status: "healthy", reason: "unknown", checkedAt: recordedAt },
        usage: usage(),
      }),
    /usage is not allowed/,
  );
  assert.throws(
    () => parseMigrationMetadata({ schemaVersion: 1, migratedFrom: 1, migratedAt: recordedAt }),
    /previous integer schema version/,
  );
});

test("telemetry event privacy allowlist accepts token counters but rejects prohibited data", () => {
  const event = parseTelemetryEvent({
    schemaVersion: 1,
    eventId: "evt-usage-1",
    kind: "usage",
    recordedAt,
    usage: usage(),
  });
  assert.equal(event.kind, "usage");
  if (event.kind !== "usage") throw new Error("usage event fixture expected");
  assert.doesNotThrow(() => assertNoProhibitedFields(event));
  assert.throws(
    () => assertNoProhibitedFields({ ...event, usage: { ...event.usage, tokenCount: 1 } }),
    PrivacyViolation,
  );
  assert.throws(
    () =>
      assertNoProhibitedFields({
        ...event,
        usage: { ...event.usage, provider: "https://api.example.test" },
      }),
    /unsafe provider\/model identifier|prohibited value/,
  );
  assert.throws(
    () =>
      assertNoProhibitedFields({
        ...event,
        usage: { ...event.usage, nested: [{ prompt: "secret" }] },
      }),
    /field is not allowlisted|prohibited field/,
  );
});

test("provider/model labels fall back without retaining unsafe values", () => {
  assert.deepEqual(classifyProviderModel("openai", "gpt-5"), {
    provider: "openai",
    model: "gpt-5",
    kind: "public",
    pseudonymous: false,
  });
  assert.equal(classifyProviderModel("ollama", "llama3").kind, "local");
  assert.deepEqual(classifyProviderModel("https://secret.example", "Bearer-token"), {
    provider: "unknown-custom",
    model: "unknown-custom",
    kind: "unknown-custom",
    pseudonymous: true,
  });
});

test("redaction validates before copying only the allowlisted shape", () => {
  const event = {
    schemaVersion: 1,
    eventId: "evt-health-1",
    kind: "health",
    recordedAt,
    health: {
      schemaVersion: 1,
      status: "degraded",
      reason: "validation-rejected",
      checkedAt: recordedAt,
    },
  };
  assert.deepEqual(redactTelemetryEvent(event), event);
  assert.throws(
    () => redactTelemetryEvent({ ...event, prompt: "do not retain" }),
    /unknown field prompt/,
  );
});

test("no-op recorder has no filesystem or durable-state side effects", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-telemetry-"));
  const before = fs.readdirSync(directory);
  const recorder = createNoopTelemetryRecorder();
  recorder.record(
    parseTelemetryEvent({
      schemaVersion: 1,
      eventId: "evt-noop-1",
      kind: "usage",
      recordedAt,
      usage: usage(),
    }),
  );
  recorder.flush();
  recorder.close();
  assert.deepEqual(fs.readdirSync(directory), before);
  assert.deepEqual(recorder.health(), {
    schemaVersion: 1,
    status: "disabled",
    reason: "not-enabled",
    checkedAt: "1970-01-01T00:00:00.000Z",
  });
});

test("attempt telemetry persists bounded lifecycle details and aggregates reports", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-telemetry-store-"));
  await appendTelemetryAttempts(stateDir, { jobId: "job-1", taskKind: "ask", role: "scout" }, [
    {
      attempt: 1,
      automaticRetries: 2,
      startedAt: "2026-07-16T12:00:00.000Z",
      finishedAt: "2026-07-16T12:00:01.250Z",
      durationMs: 1250,
      outcome: "succeeded",
      provider: "openai",
      model: "gpt-5",
      usage: { provider: "openai", model: "gpt-5", inputTokens: 10, outputTokens: 4 },
    },
    {
      attempt: 2,
      startedAt: "2026-07-16T12:00:02.000Z",
      finishedAt: "2026-07-16T12:00:03.000Z",
      durationMs: 1000,
      outcome: "failed",
      provider: "openai",
      model: "gpt-5",
    },
  ]);
  const stored = await readTelemetryEvents(stateDir);
  assert.equal(stored.events.length, 2);
  assert.equal(stored.health.status, "healthy");
  assert.equal(stored.events[0]?.kind, "attempt");
  assert.equal(fs.statSync(path.join(stateDir, "telemetry")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "telemetry", "events.jsonl")).mode & 0o777, 0o600);
  assert.doesNotThrow(() => assertNoProhibitedFields(stored.events[0]));

  const report = await readTelemetryReport(stateDir, { limit: 10 });
  assert.equal(report.summary.attempts, 2);
  assert.equal(report.summary.automaticRetries, 2);
  assert.equal(report.summary.succeeded, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.inputTokens, 10);
  assert.equal(report.summary.outputTokens, 4);
  assert.equal(report.byModel[0]?.key, "openai/gpt-5");
  assert.equal(report.details.length, 2);
  assert.deepEqual(report.cost, {
    status: "unknown",
    attribution: "unattributed",
    reason: "missing-pricing",
  });
});

test("pricing parser rejects reversed and ambiguous intervals, including currency changes", () => {
  const first = pricing().entries[0]!;
  assert.throws(
    () =>
      pricing({
        entries: [
          {
            ...first,
            effectiveFrom: "2026-12-01T00:00:00.000Z",
            effectiveTo: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    /effectiveTo must be after/,
  );
  assert.throws(
    () => pricing({ entries: [first, { ...first, currency: "EUR" }] }),
    /overlapping pricing intervals/,
  );
  assert.throws(() => pricing({ asOf: "not-a-date" }), /invalid UTC timestamp/);
});

test("cost arithmetic uses fixed precision, half-up rounding, and explicit states", () => {
  const snapshot = pricing();
  assert.equal(calculateDimensionCost(1500, snapshot.entries[0]!), "8");
  assert.deepEqual(calculateCost(usage(), snapshot, { at: recordedAt }), {
    schemaVersion: 1,
    status: "priced",
    attribution: "provider",
    reason: "complete",
    currency: "USD",
    amountMinorUnits: "12",
    pricingAsOf: recordedAt,
  });
  assert.equal(
    calculateCost(usage({ inputTokens: undefined, outputTokens: undefined }), snapshot, {
      at: recordedAt,
    }).status,
    "unknown",
  );
  assert.equal(
    calculateCost(usage(), snapshot, { at: recordedAt, localModel: true }).status,
    "local-usage-only",
  );
  assert.equal(calculateCost(usage(), snapshot, { at: "invalid" }).reason, "invalid-input");
  assert.equal(
    calculateCost(
      usage(),
      { ...snapshot, asOf: "2025-01-01T00:00:00.000Z" },
      { at: recordedAt, maxPricingAgeMs: 1 },
    ).status,
    "stale",
  );
});

test("cost logic preserves multi-currency attribution instead of aggregating it", () => {
  const mixed = pricing({
    entries: [pricing().entries[0]!, { ...pricing().entries[1]!, currency: "EUR" }],
  });
  const result = calculateCost(usage(), mixed, { at: recordedAt });
  assert.equal(result.status, "unsupported-dimension");
  assert.equal(result.reason, "mixed-currency");
  assert.deepEqual(result.amountsMinorUnitsByCurrency, { USD: "8", EUR: "4" });
  assert.equal(result.amountMinorUnits, undefined);
});

test("cost status snapshots keep schema evolution and state combinations explicit", () => {
  assert.doesNotThrow(() =>
    parseCostStatusSnapshot({
      schemaVersion: 1,
      status: "priced",
      attribution: "provider",
      reason: "complete",
      currency: "USD",
      amountMinorUnits: "12",
    }),
  );
  const mixed = {
    schemaVersion: 1,
    status: "unsupported-dimension",
    attribution: "provider",
    reason: "mixed-currency",
    amountsMinorUnitsByCurrency: { USD: "8", EUR: "4" },
  } as const;
  assert.doesNotThrow(() => parseCostStatusSnapshot(mixed));
  assert.doesNotThrow(() => assertNoProhibitedFields(mixed));
  assert.throws(
    () =>
      parseCostStatusSnapshot({
        schemaVersion: 1,
        status: "priced",
        attribution: "provider",
        reason: "complete",
      }),
    /currency and amountMinorUnits/,
  );
});
