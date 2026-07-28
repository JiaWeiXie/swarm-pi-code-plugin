import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTelemetryEvent, TELEMETRY_SCHEMA_VERSION } from "./contracts.js";
import { classifyProviderModel, redactTelemetryEvent } from "./privacy.js";
const TELEMETRY_DIRECTORY = "telemetry";
const EVENTS_FILE = "events.jsonl";
const MAX_TELEMETRY_READ_BYTES = 1024 * 1024;
function eventFile(stateDir) {
    return path.join(stateDir, TELEMETRY_DIRECTORY, EVENTS_FILE);
}
function healthy(now = new Date().toISOString()) {
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        status: "healthy",
        reason: "unknown",
        checkedAt: now,
    };
}
function disabled(now = new Date().toISOString()) {
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        status: "disabled",
        reason: "not-enabled",
        checkedAt: now,
    };
}
function degraded(reason, now = new Date().toISOString()) {
    return {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        status: "degraded",
        reason,
        checkedAt: now,
    };
}
async function fileExists(file) {
    return fs.stat(file).then(() => true, () => false);
}
export function telemetryPath(stateDir) {
    return eventFile(stateDir);
}
export async function appendTelemetryEvent(stateDir, input) {
    const event = redactTelemetryEvent(input);
    const file = eventFile(stateDir);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(file), 0o700);
    const handle = await fs.open(file, "a", 0o600);
    try {
        await fs.chmod(file, 0o600);
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    }
    finally {
        await handle.close();
    }
}
export async function appendTelemetryAttempts(stateDir, context, attempts) {
    for (const attempt of attempts) {
        const classified = classifyProviderModel(attempt.provider, attempt.model);
        const usage = attempt.usage
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
                ...(attempt.usage.cacheWriteTokens === undefined
                    ? {}
                    : { cacheWriteTokens: attempt.usage.cacheWriteTokens }),
            }
            : undefined;
        const event = {
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
                ...(attempt.automaticRetries === undefined
                    ? {}
                    : { automaticRetries: attempt.automaticRetries }),
                startedAt: attempt.startedAt,
                finishedAt: attempt.finishedAt,
                durationMs: attempt.durationMs,
                outcome: attempt.outcome,
            },
            ...(usage ? { usage } : {}),
        };
        await appendTelemetryEvent(stateDir, event);
    }
}
async function readNewestTelemetryLines(file) {
    const size = (await fs.stat(file)).size;
    const byteLength = Math.min(size, MAX_TELEMETRY_READ_BYTES);
    const start = size - byteLength;
    const readStart = start === 0 ? 0 : start - 1;
    const buffer = Buffer.alloc(byteLength + (start === 0 ? 0 : 1));
    const handle = await fs.open(file, "r");
    try {
        await handle.read(buffer, 0, buffer.length, readStart);
    }
    finally {
        await handle.close();
    }
    if (start === 0)
        return { contents: buffer.toString("utf8"), truncated: false };
    const beginsAtLineBoundary = buffer[0] === 0x0a;
    const contents = buffer.subarray(1).toString("utf8");
    if (beginsAtLineBoundary)
        return { contents, truncated: true };
    const firstNewline = contents.indexOf("\n");
    return {
        contents: firstNewline === -1 ? "" : contents.slice(firstNewline + 1),
        truncated: true,
    };
}
export async function readTelemetryEvents(stateDir) {
    const file = eventFile(stateDir);
    if (!(await fileExists(file)))
        return { events: [], health: disabled() };
    const checkedAt = new Date().toISOString();
    try {
        const { contents, truncated } = await readNewestTelemetryLines(file);
        const events = [];
        let invalid = false;
        for (const line of contents.split("\n")) {
            if (!line.trim())
                continue;
            try {
                events.push(parseTelemetryEvent(JSON.parse(line)));
            }
            catch {
                invalid = true;
            }
        }
        return {
            events,
            health: truncated
                ? degraded("history-truncated", checkedAt)
                : invalid
                    ? degraded("history-invalid", checkedAt)
                    : healthy(checkedAt),
        };
    }
    catch {
        return { events: [], health: degraded("write-failed", checkedAt) };
    }
}
