const NOOP_HEALTH = {
    schemaVersion: 1,
    status: "disabled",
    reason: "not-enabled",
    checkedAt: "1970-01-01T00:00:00.000Z",
};
/**
 * The P0 default is deliberately inert. It does not validate, persist, spawn,
 * connect, or retain the event passed to `record`.
 */
export function createNoopTelemetryRecorder() {
    return {
        record: () => undefined,
        flush: () => undefined,
        close: () => undefined,
        health: () => ({ ...NOOP_HEALTH }),
    };
}
export const noopTelemetryRecorder = createNoopTelemetryRecorder();
