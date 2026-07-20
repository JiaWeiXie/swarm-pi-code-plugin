import { readTelemetryEvents } from "./store.js";
function add(left, right) {
    const next = left + right;
    return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}
function emptyBucket(key) {
    return {
        key,
        attempts: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        timedOut: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
    };
}
function addEvent(bucket, event) {
    bucket.attempts += 1;
    if (event.context.outcome === "succeeded")
        bucket.succeeded += 1;
    else if (event.context.outcome === "cancelled")
        bucket.cancelled += 1;
    else if (event.context.outcome === "timed-out")
        bucket.timedOut += 1;
    else
        bucket.failed += 1;
    bucket.durationMs = add(bucket.durationMs, event.context.durationMs);
    bucket.inputTokens = add(bucket.inputTokens, event.usage?.inputTokens ?? 0);
    bucket.outputTokens = add(bucket.outputTokens, event.usage?.outputTokens ?? 0);
    bucket.cachedInputTokens = add(bucket.cachedInputTokens, event.usage?.cachedInputTokens ?? 0);
}
function bucketMap(events, keyFor) {
    const buckets = new Map();
    for (const event of events) {
        const key = keyFor(event);
        const bucket = buckets.get(key) ?? emptyBucket(key);
        addEvent(bucket, event);
        buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((left, right) => left.attempts === right.attempts
        ? left.key.localeCompare(right.key)
        : right.attempts - left.attempts);
}
function selected(events, options) {
    const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
    const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;
    return events
        .filter((event) => event.kind === "attempt")
        .filter((event) => {
        const recorded = Date.parse(event.recordedAt);
        return (recorded >= from &&
            recorded <= to &&
            (options.jobId === undefined || event.context.jobId === options.jobId) &&
            (options.role === undefined || event.context.role === options.role));
    })
        .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
}
export function buildTelemetryReport(events, health, options = {}) {
    const attempts = selected(events, options);
    const detailLimit = Math.min(500, Math.max(1, options.limit ?? 100));
    const summary = emptyBucket("all");
    for (const event of attempts)
        addEvent(summary, event);
    return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        range: {
            ...(options.from ? { from: options.from } : {}),
            ...(options.to ? { to: options.to } : {}),
        },
        health,
        cost: { status: "unknown", attribution: "unattributed", reason: "missing-pricing" },
        summary,
        byModel: bucketMap(attempts, (event) => `${event.context.provider}/${event.context.model}`),
        byRole: bucketMap(attempts, (event) => event.context.role ?? "unassigned"),
        byTaskKind: bucketMap(attempts, (event) => event.context.taskKind),
        details: attempts.slice(0, detailLimit).map((event) => ({
            eventId: event.eventId,
            recordedAt: event.recordedAt,
            context: { ...event.context },
            ...(event.usage ? { usage: { ...event.usage } } : {}),
        })),
    };
}
export async function readTelemetryReport(stateDir, options = {}) {
    const result = await readTelemetryEvents(stateDir);
    return buildTelemetryReport(result.events, result.health, options);
}
