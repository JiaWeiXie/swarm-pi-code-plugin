/**
 * Versioned, local-only telemetry contracts.
 *
 * These contracts intentionally contain usage metadata and bounded status
 * codes only. They do not model prompts, completions, paths, endpoints,
 * credentials, Git metadata, or arbitrary text.
 */

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export type TelemetrySchemaVersion = typeof TELEMETRY_SCHEMA_VERSION;

export type UsageDimension = "inputTokens" | "outputTokens" | "cachedInputTokens";
export const USAGE_DIMENSIONS: readonly UsageDimension[] = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
];

export type Currency = "USD" | "EUR" | "GBP" | "JPY" | "TWD";
export const CURRENCIES: readonly Currency[] = ["USD", "EUR", "GBP", "JPY", "TWD"];

export type IsoDate = string;
export type DecimalString = string;
export type NonNegativeInteger = number;

export interface MigrationMetadata {
  schemaVersion: TelemetrySchemaVersion;
  migratedFrom: number;
  migratedAt: IsoDate;
}

export interface UsageSnapshot {
  schemaVersion: TelemetrySchemaVersion;
  provider: string;
  model: string;
  capturedAt: IsoDate;
  inputTokens?: NonNegativeInteger;
  outputTokens?: NonNegativeInteger;
  cachedInputTokens?: NonNegativeInteger;
}

export type CollectorHealthStatus = "healthy" | "degraded" | "disabled" | "error";
export type CollectorHealthReason =
  | "not-enabled"
  | "validation-rejected"
  | "write-failed"
  | "clock-skew"
  | "migration-pending"
  | "unknown";

export interface CollectorHealth {
  schemaVersion: TelemetrySchemaVersion;
  status: CollectorHealthStatus;
  reason: CollectorHealthReason;
  checkedAt: IsoDate;
}

export interface TelemetryUsageEvent {
  schemaVersion: TelemetrySchemaVersion;
  eventId: string;
  kind: "usage";
  recordedAt: IsoDate;
  usage: UsageSnapshot;
  migration?: MigrationMetadata;
}

export type TelemetryOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "orphaned"
  | "not-implemented";

export interface TelemetryContext {
  jobId: string;
  taskKind: string;
  provider: string;
  model: string;
  role?: string;
  attempt: NonNegativeInteger;
  startedAt: IsoDate;
  finishedAt: IsoDate;
  durationMs: NonNegativeInteger;
  outcome: TelemetryOutcome;
}

export interface TelemetryAttemptEvent {
  schemaVersion: TelemetrySchemaVersion;
  eventId: string;
  kind: "attempt";
  recordedAt: IsoDate;
  context: TelemetryContext;
  usage?: UsageSnapshot;
  migration?: MigrationMetadata;
}

export interface TelemetryHealthEvent {
  schemaVersion: TelemetrySchemaVersion;
  eventId: string;
  kind: "health";
  recordedAt: IsoDate;
  health: CollectorHealth;
  migration?: MigrationMetadata;
}

export type TelemetryEvent = TelemetryUsageEvent | TelemetryAttemptEvent | TelemetryHealthEvent;

export interface PricingEntry {
  provider: string;
  model: string;
  currency: Currency;
  dimension: UsageDimension;
  /** Minor currency units charged per `unitTokens` tokens. */
  rateMinorUnits: DecimalString;
  unitTokens: number;
  effectiveFrom: IsoDate;
  effectiveTo?: IsoDate;
}

export interface PricingSnapshot {
  schemaVersion: TelemetrySchemaVersion;
  asOf: IsoDate;
  entries: PricingEntry[];
}

export type CostStatus =
  | "priced"
  | "unknown"
  | "stale"
  | "unsupported-dimension"
  | "local-usage-only";
export type CostAttribution = "provider" | "local" | "unattributed";
export type CostReason =
  | "complete"
  | "missing-usage"
  | "missing-pricing"
  | "partial-pricing"
  | "invalid-input"
  | "stale-pricing"
  | "mixed-currency"
  | "local-model"
  | "unsupported-dimension";

export interface CostStatusSnapshot {
  schemaVersion: TelemetrySchemaVersion;
  status: CostStatus;
  attribution: CostAttribution;
  reason: CostReason;
  currency?: Currency;
  amountMinorUnits?: DecimalString;
  /** Kept separate when dimensions resolve to different currencies. */
  amountsMinorUnitsByCurrency?: Partial<Record<Currency, DecimalString>>;
  pricingAsOf?: IsoDate;
}

export interface TelemetryRecord {
  event: TelemetryEvent;
  cost?: CostStatusSnapshot;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${where}: object required`);
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  const object = record(value, where);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) throw new TypeError(`${where}: unknown field ${key}`);
  }
  return object;
}

function schemaVersion(value: unknown, where: string): TelemetrySchemaVersion {
  if (value !== TELEMETRY_SCHEMA_VERSION)
    throw new TypeError(`${where}: unsupported schema version`);
  return TELEMETRY_SCHEMA_VERSION;
}

function isoDate(value: unknown, where: string): IsoDate {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${where}: invalid UTC timestamp`);
  }
  return value;
}

function safeIdentifier(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    !SAFE_IDENTIFIER.test(value) ||
    /(?:https?|file|path|endpoint|prompt|completion|reasoning|secret|credential|password|token|api[-_]?key)/i.test(
      value,
    )
  ) {
    throw new TypeError(`${where}: unsafe public identifier`);
  }
  return value;
}

function eventId(value: unknown, where: string): string {
  if (typeof value !== "string" || !EVENT_ID.test(value))
    throw new TypeError(`${where}: invalid event id`);
  return value;
}

function nonNegativeInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${where}: non-negative integer required`);
  }
  return value;
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${where}: positive integer required`);
  }
  return value;
}

function decimal(value: unknown, where: string): DecimalString {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new TypeError(`${where}: non-negative decimal string required`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], where: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`${where}: unsupported value`);
  }
  return value as T;
}

function parseMigrationMetadataInternal(input: unknown, where: string): MigrationMetadata {
  const value = exact(input, ["schemaVersion", "migratedFrom", "migratedAt"], where);
  schemaVersion(value.schemaVersion, `${where}.schemaVersion`);
  if (
    typeof value.migratedFrom !== "number" ||
    !Number.isSafeInteger(value.migratedFrom) ||
    value.migratedFrom < 0 ||
    value.migratedFrom >= TELEMETRY_SCHEMA_VERSION
  ) {
    throw new TypeError(`${where}.migratedFrom: previous integer schema version required`);
  }
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    migratedFrom: value.migratedFrom,
    migratedAt: isoDate(value.migratedAt, `${where}.migratedAt`),
  };
}

export function parseMigrationMetadata(input: unknown): MigrationMetadata {
  return parseMigrationMetadataInternal(input, "migration");
}

export function parseUsageSnapshot(input: unknown): UsageSnapshot {
  const value = exact(
    input,
    [
      "schemaVersion",
      "provider",
      "model",
      "capturedAt",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
    ],
    "usage",
  );
  schemaVersion(value.schemaVersion, "usage.schemaVersion");
  const usage: UsageSnapshot = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    provider: safeIdentifier(value.provider, "usage.provider"),
    model: safeIdentifier(value.model, "usage.model"),
    capturedAt: isoDate(value.capturedAt, "usage.capturedAt"),
  };
  for (const dimension of USAGE_DIMENSIONS) {
    if (value[dimension] !== undefined)
      usage[dimension] = nonNegativeInteger(value[dimension], `usage.${dimension}`);
  }
  return usage;
}

export function parseCollectorHealth(input: unknown): CollectorHealth {
  const value = exact(input, ["schemaVersion", "status", "reason", "checkedAt"], "health");
  schemaVersion(value.schemaVersion, "health.schemaVersion");
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    status: oneOf(value.status, ["healthy", "degraded", "disabled", "error"], "health.status"),
    reason: oneOf(
      value.reason,
      [
        "not-enabled",
        "validation-rejected",
        "write-failed",
        "clock-skew",
        "migration-pending",
        "unknown",
      ],
      "health.reason",
    ),
    checkedAt: isoDate(value.checkedAt, "health.checkedAt"),
  };
}

export function parseTelemetryEvent(input: unknown): TelemetryEvent {
  const value = exact(
    input,
    ["schemaVersion", "eventId", "kind", "recordedAt", "usage", "health", "context", "migration"],
    "event",
  );
  schemaVersion(value.schemaVersion, "event.schemaVersion");
  const base = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: eventId(value.eventId, "event.eventId"),
    recordedAt: isoDate(value.recordedAt, "event.recordedAt"),
  };
  const migration =
    value.migration === undefined
      ? undefined
      : parseMigrationMetadataInternal(value.migration, "event.migration");
  if (value.kind === "usage") {
    if (value.health !== undefined) throw new TypeError("event.usage: health is not allowed");
    return {
      ...base,
      kind: "usage",
      usage: parseUsageSnapshot(value.usage),
      ...(migration ? { migration } : {}),
    };
  }
  if (value.kind === "health") {
    if (value.usage !== undefined) throw new TypeError("event.health: usage is not allowed");
    return {
      ...base,
      kind: "health",
      health: parseCollectorHealth(value.health),
      ...(migration ? { migration } : {}),
    };
  }
  if (value.kind === "attempt") {
    if (value.health !== undefined) throw new TypeError("event.attempt: health is not allowed");
    const contextValue = exact(
      value.context,
      [
        "jobId",
        "taskKind",
        "provider",
        "model",
        "role",
        "attempt",
        "startedAt",
        "finishedAt",
        "durationMs",
        "outcome",
      ],
      "event.context",
    );
    const context: TelemetryContext = {
      jobId: eventId(contextValue.jobId, "event.context.jobId"),
      taskKind: safeIdentifier(contextValue.taskKind, "event.context.taskKind"),
      provider: safeIdentifier(contextValue.provider, "event.context.provider"),
      model: safeIdentifier(contextValue.model, "event.context.model"),
      ...(contextValue.role === undefined
        ? {}
        : { role: safeIdentifier(contextValue.role, "event.context.role") }),
      attempt: positiveInteger(contextValue.attempt, "event.context.attempt"),
      startedAt: isoDate(contextValue.startedAt, "event.context.startedAt"),
      finishedAt: isoDate(contextValue.finishedAt, "event.context.finishedAt"),
      durationMs: nonNegativeInteger(contextValue.durationMs, "event.context.durationMs"),
      outcome: oneOf(
        contextValue.outcome,
        ["succeeded", "failed", "cancelled", "timed-out", "orphaned", "not-implemented"],
        "event.context.outcome",
      ),
    };
    if (Date.parse(context.finishedAt) < Date.parse(context.startedAt)) {
      throw new TypeError("event.context: finishedAt must not precede startedAt");
    }
    return {
      ...base,
      kind: "attempt",
      context,
      ...(value.usage === undefined ? {} : { usage: parseUsageSnapshot(value.usage) }),
      ...(migration ? { migration } : {}),
    };
  }
  throw new TypeError("event.kind: unsupported value");
}

function rangesOverlap(a: PricingEntry, b: PricingEntry): boolean {
  const aTo = a.effectiveTo ? Date.parse(a.effectiveTo) : Number.POSITIVE_INFINITY;
  const bTo = b.effectiveTo ? Date.parse(b.effectiveTo) : Number.POSITIVE_INFINITY;
  return Date.parse(a.effectiveFrom) < bTo && Date.parse(b.effectiveFrom) < aTo;
}

export function parsePricingSnapshot(input: unknown): PricingSnapshot {
  const value = exact(input, ["schemaVersion", "asOf", "entries"], "pricing");
  schemaVersion(value.schemaVersion, "pricing.schemaVersion");
  if (!Array.isArray(value.entries)) throw new TypeError("pricing.entries: array required");
  const entries = value.entries.map((raw, index): PricingEntry => {
    const item = exact(
      raw,
      [
        "provider",
        "model",
        "currency",
        "dimension",
        "rateMinorUnits",
        "unitTokens",
        "effectiveFrom",
        "effectiveTo",
      ],
      `pricing.entries[${index}]`,
    );
    const effectiveFrom = isoDate(item.effectiveFrom, `pricing.entries[${index}].effectiveFrom`);
    const effectiveTo =
      item.effectiveTo === undefined
        ? undefined
        : isoDate(item.effectiveTo, `pricing.entries[${index}].effectiveTo`);
    if (effectiveTo && Date.parse(effectiveTo) <= Date.parse(effectiveFrom)) {
      throw new TypeError(`pricing.entries[${index}]: effectiveTo must be after effectiveFrom`);
    }
    return {
      provider: safeIdentifier(item.provider, `pricing.entries[${index}].provider`),
      model: safeIdentifier(item.model, `pricing.entries[${index}].model`),
      currency: oneOf(item.currency, CURRENCIES, `pricing.entries[${index}].currency`),
      dimension: oneOf(item.dimension, USAGE_DIMENSIONS, `pricing.entries[${index}].dimension`),
      rateMinorUnits: decimal(item.rateMinorUnits, `pricing.entries[${index}].rateMinorUnits`),
      unitTokens: positiveInteger(item.unitTokens, `pricing.entries[${index}].unitTokens`),
      effectiveFrom,
      ...(effectiveTo ? { effectiveTo } : {}),
    };
  });
  for (let index = 0; index < entries.length; index += 1) {
    for (let other = index + 1; other < entries.length; other += 1) {
      const left = entries[index]!;
      const right = entries[other]!;
      if (
        left.provider === right.provider &&
        left.model === right.model &&
        left.dimension === right.dimension &&
        rangesOverlap(left, right)
      ) {
        throw new TypeError("pricing.entries: overlapping pricing intervals are ambiguous");
      }
    }
  }
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    asOf: isoDate(value.asOf, "pricing.asOf"),
    entries,
  };
}

function currencyAmounts(value: unknown, where: string): Partial<Record<Currency, DecimalString>> {
  const object = exact(value, CURRENCIES, where);
  const amounts: Partial<Record<Currency, DecimalString>> = {};
  for (const currency of CURRENCIES) {
    if (object[currency] !== undefined)
      amounts[currency] = decimal(object[currency], `${where}.${currency}`);
  }
  if (Object.keys(amounts).length === 0)
    throw new TypeError(`${where}: at least one currency required`);
  return amounts;
}

export function parseCostStatusSnapshot(input: unknown): CostStatusSnapshot {
  const value = exact(
    input,
    [
      "schemaVersion",
      "status",
      "attribution",
      "reason",
      "currency",
      "amountMinorUnits",
      "amountsMinorUnitsByCurrency",
      "pricingAsOf",
    ],
    "cost",
  );
  schemaVersion(value.schemaVersion, "cost.schemaVersion");
  const status = oneOf(
    value.status,
    ["priced", "unknown", "stale", "unsupported-dimension", "local-usage-only"],
    "cost.status",
  );
  const attribution = oneOf(
    value.attribution,
    ["provider", "local", "unattributed"],
    "cost.attribution",
  );
  const reason = oneOf(
    value.reason,
    [
      "complete",
      "missing-usage",
      "missing-pricing",
      "partial-pricing",
      "invalid-input",
      "stale-pricing",
      "mixed-currency",
      "local-model",
      "unsupported-dimension",
    ],
    "cost.reason",
  );
  if (value.currency !== undefined) oneOf(value.currency, CURRENCIES, "cost.currency");
  if (value.amountMinorUnits !== undefined)
    decimal(value.amountMinorUnits, "cost.amountMinorUnits");
  const amounts =
    value.amountsMinorUnitsByCurrency === undefined
      ? undefined
      : currencyAmounts(value.amountsMinorUnitsByCurrency, "cost.amountsMinorUnitsByCurrency");
  const pricingAsOf =
    value.pricingAsOf === undefined ? undefined : isoDate(value.pricingAsOf, "cost.pricingAsOf");
  if (
    status === "priced" &&
    (value.amountMinorUnits === undefined || value.currency === undefined)
  ) {
    throw new TypeError("cost.priced: currency and amountMinorUnits are required");
  }
  if (status !== "priced" && value.amountMinorUnits !== undefined) {
    throw new TypeError("cost: non-priced states cannot contain amountMinorUnits");
  }
  if (status === "local-usage-only" && attribution !== "local")
    throw new TypeError("cost.local-usage-only: local attribution required");
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    status,
    attribution,
    reason,
    ...(value.currency === undefined ? {} : { currency: value.currency as Currency }),
    ...(value.amountMinorUnits === undefined
      ? {}
      : { amountMinorUnits: value.amountMinorUnits as string }),
    ...(amounts === undefined ? {} : { amountsMinorUnitsByCurrency: amounts }),
    ...(pricingAsOf === undefined ? {} : { pricingAsOf }),
  };
}
