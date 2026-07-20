import { classifyProviderModel } from "../telemetry/privacy.js";
export async function executeSession(options) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let output = "";
    let terminalMessage;
    const unsubscribe = options.session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
            output += event.assistantMessageEvent.delta ?? "";
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
            terminalMessage = event.message;
        }
    });
    let timeout;
    let removeAbortListener = () => { };
    try {
        const promptOutcome = options.session.prompt(options.prompt).then(() => ({ type: "completed" }), (error) => ({ type: "error", error }));
        const interruption = new Promise((resolve) => {
            const interrupt = (status) => {
                void interruptSession(options.session).finally(() => resolve({ type: "interrupted", status }));
            };
            if (options.signal) {
                const onAbort = () => interrupt("cancelled");
                if (options.signal.aborted)
                    onAbort();
                else {
                    options.signal.addEventListener("abort", onAbort, { once: true });
                    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
                }
            }
            if (options.timeoutMs !== undefined) {
                timeout = setTimeout(() => interrupt("timed-out"), options.timeoutMs);
            }
        });
        const outcome = await Promise.race([promptOutcome, interruption]);
        if (outcome.type === "interrupted") {
            const message = outcome.status === "timed-out" ? "Pi session timed out." : "Pi session was cancelled.";
            return withTelemetry(result(options.kind, outcome.status, options.model, message), startedMs, startedAt, options.model);
        }
        if (outcome.type === "error") {
            const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
            return withTelemetry(result(options.kind, "failed", options.model, message), startedMs, startedAt, options.model);
        }
        return withTelemetry(resultFromTerminalMessage(options.kind, options.model, output.trim(), terminalMessage), startedMs, startedAt, options.model, terminalMessage);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
        removeAbortListener();
        unsubscribe();
        options.session.dispose();
    }
}
async function interruptSession(session) {
    await session.abort?.().catch(() => { });
    if (!session.waitForIdle)
        return;
    let timeout;
    try {
        await Promise.race([
            session.waitForIdle().catch(() => { }),
            new Promise((resolve) => {
                timeout = setTimeout(resolve, 5_000);
            }),
        ]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
function resultFromTerminalMessage(kind, model, output, message) {
    if (!message?.stopReason) {
        return result(kind, "failed", model, "Pi session completed without a terminal assistant message.");
    }
    if (message.stopReason === "stop")
        return result(kind, "succeeded", model, output);
    if (message.stopReason === "error") {
        return result(kind, "failed", model, message.errorMessage ?? (output || "Pi provider request failed."));
    }
    if (message.stopReason === "length") {
        return result(kind, "failed", model, "Pi response ended before completion.");
    }
    if (message.stopReason === "aborted") {
        return result(kind, "failed", model, message.errorMessage ?? "Pi session was aborted.");
    }
    return result(kind, "failed", model, "Pi session ended while a tool call was still pending.");
}
export function notImplementedResult(kind) {
    return result(kind, "not-implemented", null, `${kind} is not enabled until its safety boundary is implemented.`);
}
function result(kind, status, model, output) {
    return {
        kind,
        status,
        success: status === "succeeded",
        model,
        output,
        changedFiles: [],
        diffStat: "",
        verification: {
            status: "not-run",
            commands: [],
        },
    };
}
function withTelemetry(workerResult, startedMs, startedAt, fallbackModel, terminalMessage) {
    const finishedMs = Date.now();
    const finishedAt = new Date(finishedMs).toISOString();
    const rawProvider = terminalMessage?.provider ?? fallbackModel.split("/", 1)[0] ?? "unknown";
    const rawModel = terminalMessage?.model ?? (fallbackModel.slice(fallbackModel.indexOf("/") + 1) || "unknown");
    const classified = classifyProviderModel(rawProvider, rawModel);
    const usage = usageFromMessage(terminalMessage, classified.provider, classified.model);
    const attempt = {
        attempt: 1,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedMs - startedMs),
        outcome: workerResult.status,
        provider: classified.provider,
        model: classified.model,
        ...(usage ? { usage } : {}),
    };
    return { ...workerResult, telemetry: { attempts: [attempt] } };
}
function usageFromMessage(message, provider, model) {
    const usage = message?.usage;
    if (!usage || typeof usage !== "object")
        return undefined;
    const counters = [usage.input, usage.output, usage.cacheRead];
    if (!counters.some((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
        return undefined;
    }
    return {
        provider,
        model,
        ...(validCounter(usage.input) ? { inputTokens: usage.input } : {}),
        ...(validCounter(usage.output) ? { outputTokens: usage.output } : {}),
        ...(validCounter(usage.cacheRead) ? { cachedInputTokens: usage.cacheRead } : {}),
    };
}
function validCounter(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
