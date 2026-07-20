import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  CollectorHealth,
  TelemetryAttemptEvent,
  TelemetryEvent,
  TelemetryOutcome,
  UsageSnapshot,
} from "./contracts.js";
import { parseTelemetryEvent, TELEMETRY_SCHEMA_VERSION } from "./contracts.js";
import { classifyProviderModel, redactTelemetryEvent } from "./privacy.js";
import type { WorkerTelemetryAttempt } from "../core/contracts.js";

const TELEMETRY_DIRECTORY = "telemetry";
const EVENTS_FILE = "events.jsonl";

export interface TelemetryJobContext {
  jobId: string;
  taskKind: string;
  role?: string;
}

export interface TelemetryReadResult {
  events: TelemetryEvent[];
  health: CollectorHealth;
}

function eventFile(stateDir: string): string {
  return path.join(stateDir, TELEMETRY_DIRECTORY, EVENTS_FILE);
}

function healthy(now = new Date().toISOString()): CollectorHealth {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    status: "healthy",
    reason: "unknown",
    checkedAt: now,
  };
}

function disabled(now = new Date().toISOString()): CollectorHealth {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    status: "disabled",
    reason: "not-enabled",
    checkedAt: now,
  };
}

function failed(now = new Date().toISOString()): CollectorHealth {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    status: "degraded",
    reason: "write-failed",
    checkedAt: now,
  };
}

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

export function telemetryPath(stateDir: string): string {
  return eventFile(stateDir);
}

export async function appendTelemetryEvent(stateDir: string, input: TelemetryEvent): Promise<void> {
  const event = redactTelemetryEvent(input);
  const file = eventFile(stateDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const handle = await fs.open(file, "a", 0o600);
  try {
    await fs.chmod(file, 0o600);
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function appendTelemetryAttempts(
  stateDir: string,
  context: TelemetryJobContext,
  attempts: WorkerTelemetryAttempt[],
): Promise<void> {
  for (const attempt of attempts) {
    const classified = classifyProviderModel(attempt.provider, attempt.model);
    const usage: UsageSnapshot | undefined = attempt.usage
      ? {
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          provider: classified.provider,
          model: classified.model,
          capturedAt: attempt.finishedAt,
          ...(attempt.usage.inputTokens === undefined
            ? {}
            : { inputTokens: attempt.usage.inputTokens }),
          ...(attempt.usage.outputTokens === undefined
            ? {}
            : { outputTokens: attempt.usage.outputTokens }),
          ...(attempt.usage.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: attempt.usage.cachedInputTokens }),
        }
      : undefined;
    const event: TelemetryAttemptEvent = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: `attempt-${randomUUID()}`,
      kind: "attempt",
      recordedAt: attempt.finishedAt,
      context: {
        jobId: context.jobId,
        taskKind: context.taskKind,
        provider: classified.provider,
        model: classified.model,
        ...((attempt.role ?? context.role) ? { role: attempt.role ?? context.role } : {}),
        attempt: attempt.attempt,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        durationMs: attempt.durationMs,
        outcome: attempt.outcome as TelemetryOutcome,
      },
      ...(usage ? { usage } : {}),
    };
    await appendTelemetryEvent(stateDir, event);
  }
}

export async function readTelemetryEvents(stateDir: string): Promise<TelemetryReadResult> {
  const file = eventFile(stateDir);
  if (!(await fileExists(file))) return { events: [], health: disabled() };
  const checkedAt = new Date().toISOString();
  try {
    const contents = await fs.readFile(file, "utf8");
    const events: TelemetryEvent[] = [];
    let invalid = false;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(parseTelemetryEvent(JSON.parse(line)));
      } catch {
        invalid = true;
      }
    }
    return { events, health: invalid ? failed(checkedAt) : healthy(checkedAt) };
  } catch {
    return { events: [], health: failed(checkedAt) };
  }
}
