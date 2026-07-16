import { CURRENCIES, parseTelemetryEvent, USAGE_DIMENSIONS, } from "./contracts.js";
export class PrivacyViolation extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = "PrivacyViolation";
        this.path = path;
    }
}
const ALLOWED_FIELDS = new Set([
    "schemaVersion",
    "eventId",
    "kind",
    "recordedAt",
    "usage",
    "health",
    "migration",
    "provider",
    "model",
    "capturedAt",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "status",
    "reason",
    "checkedAt",
    "migratedFrom",
    "migratedAt",
    "asOf",
    "entries",
    "currency",
    "dimension",
    "rateMinorUnits",
    "unitTokens",
    "effectiveFrom",
    "effectiveTo",
    "attribution",
    "amountMinorUnits",
    "amountsMinorUnitsByCurrency",
    "pricingAsOf",
    ...CURRENCIES,
]);
const PROHIBITED_KEY = /(?:prompt|completion|reasoning|source(?:Text)?|file|directory|path|url|endpoint|secret|credential|password|authorization|cookie|git|commit|branch|header|body|request|response)/i;
const PROHIBITED_VALUE = /(?:https?:\/\/|file:\/\/|(?:^|\s)(?:\/Users\/|\/home\/|\/private\/|~\/|[A-Za-z]:\\)|-----BEGIN|bearer\s+|(?:sk|sess|key|token)[-_][A-Za-z0-9]{12,})/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const HEALTH_STATUSES = ["healthy", "degraded", "disabled", "error"];
const COST_STATUSES = [
    "priced",
    "unknown",
    "stale",
    "unsupported-dimension",
    "local-usage-only",
];
const HEALTH_REASONS = [
    "not-enabled",
    "validation-rejected",
    "write-failed",
    "clock-skew",
    "migration-pending",
    "unknown",
];
const COST_REASONS = [
    "complete",
    "missing-usage",
    "missing-pricing",
    "partial-pricing",
    "invalid-input",
    "stale-pricing",
    "mixed-currency",
    "local-model",
    "unsupported-dimension",
];
function object(value, path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new PrivacyViolation(path, "object required");
    }
    return value;
}
function safePublicIdentifier(value, path) {
    if (typeof value !== "string" ||
        !SAFE_IDENTIFIER.test(value) ||
        /(?:https?|file|path|endpoint|prompt|completion|reasoning|secret|credential|password|token|api[-_]?key)/i.test(value)) {
        throw new PrivacyViolation(path, "unsafe provider/model identifier");
    }
}
function safeString(value, key, path) {
    if (typeof value !== "string")
        throw new PrivacyViolation(path, "string required");
    if (PROHIBITED_VALUE.test(value))
        throw new PrivacyViolation(path, "prohibited value");
    switch (key) {
        case "provider":
        case "model":
            safePublicIdentifier(value, path);
            break;
        case "eventId":
            if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
                throw new PrivacyViolation(path, "unsafe event id");
            break;
        case "recordedAt":
        case "capturedAt":
        case "checkedAt":
        case "migratedAt":
        case "asOf":
        case "effectiveFrom":
        case "effectiveTo":
        case "pricingAsOf":
            if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value)))
                throw new PrivacyViolation(path, "invalid timestamp");
            break;
        case "rateMinorUnits":
        case "amountMinorUnits":
        case "USD":
        case "EUR":
        case "GBP":
        case "JPY":
        case "TWD":
            if (!DECIMAL.test(value))
                throw new PrivacyViolation(path, "invalid fixed-precision amount");
            break;
        case "kind":
            if (value !== "usage" && value !== "health")
                throw new PrivacyViolation(path, "unsupported event kind");
            break;
        case "status":
            if (![...HEALTH_STATUSES, ...COST_STATUSES].includes(value)) {
                throw new PrivacyViolation(path, "unsupported status");
            }
            break;
        case "reason":
            if (![...HEALTH_REASONS, ...COST_REASONS].includes(value)) {
                throw new PrivacyViolation(path, "unsupported reason");
            }
            break;
        case "dimension":
            if (!USAGE_DIMENSIONS.includes(value))
                throw new PrivacyViolation(path, "unsupported usage dimension");
            break;
        case "currency":
            if (!CURRENCIES.includes(value))
                throw new PrivacyViolation(path, "unsupported currency");
            break;
        case "attribution":
            if (value !== "provider" && value !== "local" && value !== "unattributed")
                throw new PrivacyViolation(path, "unsupported attribution");
            break;
        default:
            throw new PrivacyViolation(path, "arbitrary free-form text is not allowlisted");
    }
}
function walk(value, path, key) {
    if (typeof value === "string") {
        if (!key)
            throw new PrivacyViolation(path, "free-form text is not allowed");
        safeString(value, key, path);
        return;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0)
            throw new PrivacyViolation(path, "bounded non-negative integer required");
        if (key === "schemaVersion" && value !== 1)
            throw new PrivacyViolation(path, "unsupported schema version");
        if (key === "migratedFrom" && value >= 1)
            throw new PrivacyViolation(path, "unsupported migration source");
        if (key === "unitTokens" && value === 0)
            throw new PrivacyViolation(path, "positive unit required");
        if (key &&
            ![
                "schemaVersion",
                "migratedFrom",
                "inputTokens",
                "outputTokens",
                "cachedInputTokens",
                "unitTokens",
            ].includes(key)) {
            throw new PrivacyViolation(path, "numeric field is not allowlisted");
        }
        return;
    }
    if (typeof value === "boolean" || value === null || value === undefined) {
        throw new PrivacyViolation(path, "primitive field is not allowlisted");
    }
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries())
            walk(item, `${path}[${index}]`);
        return;
    }
    const objectValue = object(value, path);
    for (const [childKey, child] of Object.entries(objectValue)) {
        if (!ALLOWED_FIELDS.has(childKey)) {
            if (PROHIBITED_KEY.test(childKey))
                throw new PrivacyViolation(`${path}.${childKey}`, "prohibited field");
            throw new PrivacyViolation(`${path}.${childKey}`, "field is not allowlisted");
        }
        walk(child, `${path}.${childKey}`, childKey);
    }
}
/** Rejects all data outside the explicit telemetry allowlist. */
export function assertNoProhibitedFields(value) {
    walk(value, "$");
}
export function isSafePublicIdentifier(value) {
    try {
        safePublicIdentifier(value, "identifier");
        return true;
    }
    catch {
        return false;
    }
}
export function classifyProviderModel(provider, model) {
    if (!isSafePublicIdentifier(String(provider)) || !isSafePublicIdentifier(String(model))) {
        return {
            provider: "unknown-custom",
            model: "unknown-custom",
            kind: "unknown-custom",
            pseudonymous: true,
        };
    }
    const providerLabel = String(provider);
    const modelLabel = String(model);
    const local = /^(?:local|ollama|lm[-_]?studio|llama(?:\.cpp)?)(?:[/:._-]|$)/i.test(providerLabel);
    return {
        provider: providerLabel,
        model: modelLabel,
        kind: local ? "local" : "public",
        pseudonymous: false,
    };
}
/**
 * Validates first, then copies only the allowlisted event fields. Malformed
 * input is rejected rather than silently carried into a supposedly redacted
 * record.
 */
export function redactTelemetryEvent(input) {
    const event = parseTelemetryEvent(input);
    assertNoProhibitedFields(event);
    if (event.kind === "usage") {
        return {
            schemaVersion: event.schemaVersion,
            eventId: event.eventId,
            kind: event.kind,
            recordedAt: event.recordedAt,
            usage: { ...event.usage },
            ...(event.migration ? { migration: { ...event.migration } } : {}),
        };
    }
    return {
        schemaVersion: event.schemaVersion,
        eventId: event.eventId,
        kind: event.kind,
        recordedAt: event.recordedAt,
        health: { ...event.health },
        ...(event.migration ? { migration: { ...event.migration } } : {}),
    };
}
