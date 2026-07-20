import type {
  CollectorHealth,
  IsoDate,
  TelemetryAttemptEvent,
  TelemetryEvent,
} from "./contracts.js";
import { readTelemetryEvents } from "./store.js";

export interface TelemetryReportOptions {
  from?: IsoDate;
  to?: IsoDate;
  jobId?: string;
  role?: string;
  limit?: number;
}

export interface TelemetryReportBucket {
  key: string;
  provider?: string;
  model?: string;
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface TelemetryReportDetail {
  eventId: string;
  recordedAt: IsoDate;
  context: TelemetryAttemptEvent["context"];
  usage?: TelemetryAttemptEvent["usage"];
}

export interface TelemetryReport {
  schemaVersion: 1;
  generatedAt: IsoDate;
  range: { from?: IsoDate; to?: IsoDate };
  health: CollectorHealth;
  cost: {
    status: "unknown";
    attribution: "unattributed";
    reason: "missing-pricing";
  };
  summary: TelemetryReportBucket;
  byModel: TelemetryReportBucket[];
  byRole: TelemetryReportBucket[];
  byTaskKind: TelemetryReportBucket[];
  details: TelemetryReportDetail[];
}

function add(left: number, right: number): number {
  const next = left + right;
  return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}

function emptyBucket(key: string): TelemetryReportBucket {
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

function addEvent(bucket: TelemetryReportBucket, event: TelemetryAttemptEvent): void {
  bucket.attempts += 1;
  if (event.context.outcome === "succeeded") bucket.succeeded += 1;
  else if (event.context.outcome === "cancelled") bucket.cancelled += 1;
  else if (event.context.outcome === "timed-out") bucket.timedOut += 1;
  else bucket.failed += 1;
  bucket.durationMs = add(bucket.durationMs, event.context.durationMs);
  bucket.inputTokens = add(bucket.inputTokens, event.usage?.inputTokens ?? 0);
  bucket.outputTokens = add(bucket.outputTokens, event.usage?.outputTokens ?? 0);
  bucket.cachedInputTokens = add(bucket.cachedInputTokens, event.usage?.cachedInputTokens ?? 0);
}

function bucketMap(
  events: TelemetryAttemptEvent[],
  keyFor: (event: TelemetryAttemptEvent) => string,
) {
  const buckets = new Map<string, TelemetryReportBucket>();
  for (const event of events) {
    const key = keyFor(event);
    const bucket = buckets.get(key) ?? emptyBucket(key);
    addEvent(bucket, event);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) =>
    left.attempts === right.attempts
      ? left.key.localeCompare(right.key)
      : right.attempts - left.attempts,
  );
}

function selected(
  events: TelemetryEvent[],
  options: TelemetryReportOptions,
): TelemetryAttemptEvent[] {
  const from = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
  const to = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;
  return events
    .filter((event): event is TelemetryAttemptEvent => event.kind === "attempt")
    .filter((event) => {
      const recorded = Date.parse(event.recordedAt);
      return (
        recorded >= from &&
        recorded <= to &&
        (options.jobId === undefined || event.context.jobId === options.jobId) &&
        (options.role === undefined || event.context.role === options.role)
      );
    })
    .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
}

export function buildTelemetryReport(
  events: TelemetryEvent[],
  health: CollectorHealth,
  options: TelemetryReportOptions = {},
): TelemetryReport {
  const attempts = selected(events, options);
  const detailLimit = Math.min(500, Math.max(1, options.limit ?? 100));
  const summary = emptyBucket("all");
  for (const event of attempts) addEvent(summary, event);
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

export async function readTelemetryReport(
  stateDir: string,
  options: TelemetryReportOptions = {},
): Promise<TelemetryReport> {
  const result = await readTelemetryEvents(stateDir);
  return buildTelemetryReport(result.events, result.health, options);
}
