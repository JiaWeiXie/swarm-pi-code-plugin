/**
 * Versioned, local-only telemetry contracts.
 *
 * These contracts intentionally contain usage metadata and bounded status
 * codes only. They do not model prompts, completions, paths, endpoints,
 * credentials, Git metadata, or arbitrary text.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;
export const USAGE_DIMENSIONS = [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
];
export const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "TWD"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
function record(value, where) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${where}: object required`);
    }
    return value;
}
function exact(value, allowed, where) {
    const object = record(value, where);
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(object)) {
        if (!allowedSet.has(key))
            throw new TypeError(`${where}: unknown field ${key}`);
    }
    return object;
}
function schemaVersion(value, where) {
    if (value !== TELEMETRY_SCHEMA_VERSION)
        throw new TypeError(`${where}: unsupported schema version`);
    return TELEMETRY_SCHEMA_VERSION;
}
function isoDate(value, where) {
    if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
        throw new TypeError(`${where}: invalid UTC timestamp`);
    }
    return value;
}
function safeIdentifier(value, where) {
    if (typeof value !== "string" ||
        !SAFE_IDENTIFIER.test(value) ||
        /(?:https?|file|path|endpoint|prompt|completion|reasoning|secret|credential|password|token|api[-_]?key)/i.test(value)) {
        throw new TypeError(`${where}: unsafe public identifier`);
    }
    return value;
}
function eventId(value, where) {
    if (typeof value !== "string" || !EVENT_ID.test(value))
        throw new TypeError(`${where}: invalid event id`);
    return value;
}
function nonNegativeInteger(value, where) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${where}: non-negative integer required`);
    }
    return value;
}
function positiveInteger(value, where) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${where}: positive integer required`);
    }
    return value;
}
function decimal(value, where) {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new TypeError(`${where}: non-negative decimal string required`);
    }
    return value;
}
function oneOf(value, values, where) {
    if (typeof value !== "string" || !values.includes(value)) {
        throw new TypeError(`${where}: unsupported value`);
    }
    return value;
}
function parseMigrationMetadataInternal(input, where) {
    const value = exact(input, ["schemaVersion", "migratedFrom", "migratedAt"], where);
    schemaVersion(value.schemaVersion, `${where}.schemaVersion`);
    if (typeof value.migratedFrom !== "number" ||
        !Number.isSafeInteger(value.migratedFrom) ||
        value.migratedFrom < 0 ||
        value.migratedFrom >= TELEMETRY_SCHEMA_VERSION) {
        throw new TypeError(`${where}.migratedFrom: previous integer schema version required`);
    }
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        migratedFrom: value.migratedFrom,
        migratedAt: isoDate(value.migratedAt, `${where}.migratedAt`),
    };
}
export function parseMigrationMetadata(input) {
    return parseMigrationMetadataInternal(input, "migration");
}
export function parseUsageSnapshot(input) {
    const value = exact(input, [
        "schemaVersion",
        "provider",
        "model",
        "capturedAt",
        "inputTokens",
        "outputTokens",
        "cachedInputTokens",
    ], "usage");
    schemaVersion(value.schemaVersion, "usage.schemaVersion");
    const usage = {
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
export function parseCollectorHealth(input) {
    const value = exact(input, ["schemaVersion", "status", "reason", "checkedAt"], "health");
    schemaVersion(value.schemaVersion, "health.schemaVersion");
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        status: oneOf(value.status, ["healthy", "degraded", "disabled", "error"], "health.status"),
        reason: oneOf(value.reason, [
            "not-enabled",
            "validation-rejected",
            "write-failed",
            "clock-skew",
            "migration-pending",
            "unknown",
        ], "health.reason"),
        checkedAt: isoDate(value.checkedAt, "health.checkedAt"),
    };
}
export function parseTelemetryEvent(input) {
    const value = exact(input, ["schemaVersion", "eventId", "kind", "recordedAt", "usage", "health", "migration"], "event");
    schemaVersion(value.schemaVersion, "event.schemaVersion");
    const base = {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        eventId: eventId(value.eventId, "event.eventId"),
        recordedAt: isoDate(value.recordedAt, "event.recordedAt"),
    };
    const migration = value.migration === undefined
        ? undefined
        : parseMigrationMetadataInternal(value.migration, "event.migration");
    if (value.kind === "usage") {
        if (value.health !== undefined)
            throw new TypeError("event.usage: health is not allowed");
        return {
            ...base,
            kind: "usage",
            usage: parseUsageSnapshot(value.usage),
            ...(migration ? { migration } : {}),
        };
    }
    if (value.kind === "health") {
        if (value.usage !== undefined)
            throw new TypeError("event.health: usage is not allowed");
        return {
            ...base,
            kind: "health",
            health: parseCollectorHealth(value.health),
            ...(migration ? { migration } : {}),
        };
    }
    throw new TypeError("event.kind: unsupported value");
}
function rangesOverlap(a, b) {
    const aTo = a.effectiveTo ? Date.parse(a.effectiveTo) : Number.POSITIVE_INFINITY;
    const bTo = b.effectiveTo ? Date.parse(b.effectiveTo) : Number.POSITIVE_INFINITY;
    return Date.parse(a.effectiveFrom) < bTo && Date.parse(b.effectiveFrom) < aTo;
}
export function parsePricingSnapshot(input) {
    const value = exact(input, ["schemaVersion", "asOf", "entries"], "pricing");
    schemaVersion(value.schemaVersion, "pricing.schemaVersion");
    if (!Array.isArray(value.entries))
        throw new TypeError("pricing.entries: array required");
    const entries = value.entries.map((raw, index) => {
        const item = exact(raw, [
            "provider",
            "model",
            "currency",
            "dimension",
            "rateMinorUnits",
            "unitTokens",
            "effectiveFrom",
            "effectiveTo",
        ], `pricing.entries[${index}]`);
        const effectiveFrom = isoDate(item.effectiveFrom, `pricing.entries[${index}].effectiveFrom`);
        const effectiveTo = item.effectiveTo === undefined
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
            const left = entries[index];
            const right = entries[other];
            if (left.provider === right.provider &&
                left.model === right.model &&
                left.dimension === right.dimension &&
                rangesOverlap(left, right)) {
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
function currencyAmounts(value, where) {
    const object = exact(value, CURRENCIES, where);
    const amounts = {};
    for (const currency of CURRENCIES) {
        if (object[currency] !== undefined)
            amounts[currency] = decimal(object[currency], `${where}.${currency}`);
    }
    if (Object.keys(amounts).length === 0)
        throw new TypeError(`${where}: at least one currency required`);
    return amounts;
}
export function parseCostStatusSnapshot(input) {
    const value = exact(input, [
        "schemaVersion",
        "status",
        "attribution",
        "reason",
        "currency",
        "amountMinorUnits",
        "amountsMinorUnitsByCurrency",
        "pricingAsOf",
    ], "cost");
    schemaVersion(value.schemaVersion, "cost.schemaVersion");
    const status = oneOf(value.status, ["priced", "unknown", "stale", "unsupported-dimension", "local-usage-only"], "cost.status");
    const attribution = oneOf(value.attribution, ["provider", "local", "unattributed"], "cost.attribution");
    const reason = oneOf(value.reason, [
        "complete",
        "missing-usage",
        "missing-pricing",
        "partial-pricing",
        "invalid-input",
        "stale-pricing",
        "mixed-currency",
        "local-model",
        "unsupported-dimension",
    ], "cost.reason");
    if (value.currency !== undefined)
        oneOf(value.currency, CURRENCIES, "cost.currency");
    if (value.amountMinorUnits !== undefined)
        decimal(value.amountMinorUnits, "cost.amountMinorUnits");
    const amounts = value.amountsMinorUnitsByCurrency === undefined
        ? undefined
        : currencyAmounts(value.amountsMinorUnitsByCurrency, "cost.amountsMinorUnitsByCurrency");
    const pricingAsOf = value.pricingAsOf === undefined ? undefined : isoDate(value.pricingAsOf, "cost.pricingAsOf");
    if (status === "priced" &&
        (value.amountMinorUnits === undefined || value.currency === undefined)) {
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
        ...(value.currency === undefined ? {} : { currency: value.currency }),
        ...(value.amountMinorUnits === undefined
            ? {}
            : { amountMinorUnits: value.amountMinorUnits }),
        ...(amounts === undefined ? {} : { amountsMinorUnitsByCurrency: amounts }),
        ...(pricingAsOf === undefined ? {} : { pricingAsOf }),
    };
}
