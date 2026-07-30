import type {
  TaskKind,
  WorkerResult,
  WorkerTelemetryAttempt,
  WorkerTelemetryUsage,
} from "../core/contracts.js";
import { classifyProviderModel } from "../telemetry/privacy.js";
import type { ExecutionTerminationReason, ExecutionTimePolicy } from "../core/contracts.js";

export const DEFAULT_EXECUTION_TIME_POLICY: Readonly<ExecutionTimePolicy> = Object.freeze({
  hardRunLimitMs: 60 * 60_000,
  probeAfterIdleMs: 5 * 60_000,
  probeIntervalMs: 60_000,
  probeResponseDeadlineMs: 10_000,
  consecutiveProbeFailures: 3,
  recoveryGraceMs: 10 * 60_000,
});

interface SessionEvent {
  type: string;
  attempt?: number;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    timestamp?: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
  };
}

interface SessionStats {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface RunnableSession {
  prompt(prompt: string): Promise<void>;
  sendCustomMessage?: (
    message: {
      customType: string;
      content: string;
      display: boolean;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  getSessionStats?(): SessionStats;
  abort?(): Promise<void>;
  waitForIdle?(): Promise<void>;
  readonly isStreaming?: boolean;
  readonly isIdle?: boolean;
  /** Optional provider/runtime probe. It must not create a second model turn. */
  probeLiveness?: () => Promise<"alive" | "unresponsive">;
  readonly thinkingLevel?: string;
  dispose(): void;
}

export interface ExecuteSessionOptions {
  kind: TaskKind;
  model: string;
  prompt: string;
  session: RunnableSession;
  timeoutMs?: number;
  executionTimePolicy?: Partial<ExecutionTimePolicy>;
  onProbe?: (probe: SessionProbe) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SessionProbe {
  attemptedAt: string;
  activitySequence: number;
  lastActivityAt: string;
  outcome: "progress" | "alive" | "unresponsive";
  consecutiveFailures: number;
}

export async function executeSession(options: ExecuteSessionOptions): Promise<WorkerResult> {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const policy = normalizeExecutionTimePolicy(options.executionTimePolicy, options.timeoutMs);
  let output = "";
  let terminalMessage: SessionEvent["message"];
  let automaticRetries = 0;
  let activitySequence = 0;
  let lastActivityMs = startedMs;
  let consecutiveProbeFailures = 0;
  let recoveryStartedMs: number | undefined;
  let probing = false;
  let interruptedReason: ExecutionTerminationReason | undefined;
  const unsubscribe = options.session.subscribe((event) => {
    if (isTrustedActivity(event)) {
      activitySequence += 1;
      lastActivityMs = Date.now();
      consecutiveProbeFailures = 0;
      recoveryStartedMs = undefined;
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      output += event.assistantMessageEvent.delta ?? "";
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      terminalMessage = event.message;
    }
    if (event.type === "auto_retry_start") automaticRetries += 1;
  });

  let hardLimitTimer: NodeJS.Timeout | undefined;
  let probeTimer: NodeJS.Timeout | undefined;
  let removeAbortListener = () => {};
  try {
    const promptOutcome = options.session.prompt(options.prompt).then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "error" as const, error }),
    );
    const interruption = new Promise<{
      type: "interrupted";
      status: "cancelled" | "timed-out";
      terminationReason?: ExecutionTerminationReason;
    }>((resolve) => {
      const interrupt = (
        status: "cancelled" | "timed-out",
        terminationReason?: ExecutionTerminationReason,
      ) => {
        if (interruptedReason || status === "timed-out") interruptedReason ??= terminationReason;
        void interruptSession(options.session).finally(() =>
          resolve({
            type: "interrupted",
            status,
            ...(terminationReason ? { terminationReason } : {}),
          }),
        );
      };
      if (options.signal) {
        const onAbort = () => interrupt("cancelled");
        if (options.signal.aborted) onAbort();
        else {
          options.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        }
      }
      hardLimitTimer = setTimeout(
        () => interrupt("timed-out", "hard-limit-exceeded"),
        policy.hardRunLimitMs,
      );
      probeTimer = setInterval(
        () => {
          if (probing || interruptedReason) return;
          const now = Date.now();
          if (now - lastActivityMs < policy.probeAfterIdleMs) return;
          probing = true;
          void runProbe(options.session, policy.probeResponseDeadlineMs)
            .then(async (outcome) => {
              const madeProgress =
                activitySequence > 0 && now - lastActivityMs < policy.probeAfterIdleMs;
              if (madeProgress || outcome === "progress") {
                consecutiveProbeFailures = 0;
                recoveryStartedMs = undefined;
              } else if (outcome === "unresponsive") {
                consecutiveProbeFailures += 1;
              } else {
                // A reachable session without new output is suspicious, but not proof that a
                // provider is gone. Keep the hard limit authoritative in that case.
                consecutiveProbeFailures = 0;
              }
              await options.onProbe?.({
                attemptedAt: new Date().toISOString(),
                activitySequence,
                lastActivityAt: new Date(lastActivityMs).toISOString(),
                outcome: madeProgress ? "progress" : outcome,
                consecutiveFailures: consecutiveProbeFailures,
              });
              if (consecutiveProbeFailures >= policy.consecutiveProbeFailures) {
                if (recoveryStartedMs === undefined) recoveryStartedMs = Date.now();
                else if (Date.now() - recoveryStartedMs >= policy.recoveryGraceMs) {
                  interrupt("timed-out", "unresponsive-timeout");
                }
              }
            })
            .finally(() => {
              probing = false;
            });
        },
        Math.min(policy.probeIntervalMs, policy.probeAfterIdleMs),
      );
    });
    const outcome = await Promise.race([promptOutcome, interruption]);
    const sessionStats = readSessionStats(options.session);
    if (outcome.type === "interrupted") {
      const message =
        outcome.status === "timed-out" ? "Pi session timed out." : "Pi session was cancelled.";
      const timedOut = result(options.kind, outcome.status, options.model, message);
      if (outcome.terminationReason) {
        timedOut.terminationReason = outcome.terminationReason;
        timedOut.errorCode = outcome.terminationReason;
      }
      return withTelemetry(
        timedOut,
        startedMs,
        startedAt,
        options.model,
        undefined,
        sessionStats,
        automaticRetries,
      );
    }
    if (outcome.type === "error") {
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return withTelemetry(
        result(options.kind, "failed", options.model, message),
        startedMs,
        startedAt,
        options.model,
        undefined,
        sessionStats,
        automaticRetries,
      );
    }
    return withTelemetry(
      resultFromTerminalMessage(options.kind, options.model, output.trim(), terminalMessage),
      startedMs,
      startedAt,
      options.model,
      terminalMessage,
      sessionStats,
      automaticRetries,
    );
  } finally {
    if (hardLimitTimer) clearTimeout(hardLimitTimer);
    if (probeTimer) clearInterval(probeTimer);
    removeAbortListener();
    unsubscribe();
    options.session.dispose();
  }
}

function normalizeExecutionTimePolicy(
  policy: Partial<ExecutionTimePolicy> | undefined,
  legacyTimeoutMs: number | undefined,
): ExecutionTimePolicy {
  const hardRunLimitMs =
    policy?.hardRunLimitMs ?? legacyTimeoutMs ?? DEFAULT_EXECUTION_TIME_POLICY.hardRunLimitMs;
  return {
    hardRunLimitMs,
    probeAfterIdleMs: policy?.probeAfterIdleMs ?? DEFAULT_EXECUTION_TIME_POLICY.probeAfterIdleMs,
    probeIntervalMs: policy?.probeIntervalMs ?? DEFAULT_EXECUTION_TIME_POLICY.probeIntervalMs,
    probeResponseDeadlineMs:
      policy?.probeResponseDeadlineMs ?? DEFAULT_EXECUTION_TIME_POLICY.probeResponseDeadlineMs,
    consecutiveProbeFailures:
      policy?.consecutiveProbeFailures ?? DEFAULT_EXECUTION_TIME_POLICY.consecutiveProbeFailures,
    recoveryGraceMs: policy?.recoveryGraceMs ?? DEFAULT_EXECUTION_TIME_POLICY.recoveryGraceMs,
  };
}

function isTrustedActivity(event: SessionEvent): boolean {
  return [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "auto_retry_start",
    "auto_retry_end",
    "compaction_start",
    "compaction_end",
  ].includes(event.type);
}

async function runProbe(
  session: RunnableSession,
  timeoutMs: number,
): Promise<"progress" | "alive" | "unresponsive"> {
  if (session.probeLiveness) {
    const result = await withTimeout(session.probeLiveness(), timeoutMs).catch(
      () => "unresponsive" as const,
    );
    return result === "unresponsive" ? "unresponsive" : "alive";
  }
  if (session.isIdle === true || session.isStreaming === false) return "unresponsive";
  return "alive";
}

async function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Session probe timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function interruptSession(session: RunnableSession): Promise<void> {
  await session.abort?.().catch(() => {});
  if (!session.waitForIdle) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.waitForIdle().catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resultFromTerminalMessage(
  kind: TaskKind,
  model: string,
  output: string,
  message: SessionEvent["message"],
): WorkerResult {
  if (!message?.stopReason) {
    return result(
      kind,
      "failed",
      model,
      "Pi session completed without a terminal assistant message.",
    );
  }
  if (message.stopReason === "stop") return result(kind, "succeeded", model, output);
  if (message.stopReason === "error") {
    return result(
      kind,
      "failed",
      model,
      message.errorMessage ?? (output || "Pi provider request failed."),
    );
  }
  if (message.stopReason === "length") {
    return result(kind, "failed", model, "Pi response ended before completion.");
  }
  if (message.stopReason === "aborted") {
    return result(kind, "failed", model, message.errorMessage ?? "Pi session was aborted.");
  }
  return result(kind, "failed", model, "Pi session ended while a tool call was still pending.");
}

export function notImplementedResult(kind: TaskKind): WorkerResult {
  return result(
    kind,
    "not-implemented",
    null,
    `${kind} is not enabled until its safety boundary is implemented.`,
  );
}

function result(
  kind: TaskKind,
  status: WorkerResult["status"],
  model: string | null,
  output: string,
): WorkerResult {
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

function withTelemetry(
  workerResult: WorkerResult,
  startedMs: number,
  startedAt: string,
  fallbackModel: string,
  terminalMessage?: SessionEvent["message"],
  sessionStats?: SessionStats,
  automaticRetries = 0,
): WorkerResult {
  const finishedMs = Date.now();
  const finishedAt = new Date(finishedMs).toISOString();
  const rawProvider = terminalMessage?.provider ?? fallbackModel.split("/", 1)[0] ?? "unknown";
  const rawModel =
    terminalMessage?.model ?? (fallbackModel.slice(fallbackModel.indexOf("/") + 1) || "unknown");
  const classified = classifyProviderModel(rawProvider, rawModel);
  const usage =
    usageFromStats(sessionStats, classified.provider, classified.model) ??
    usageFromMessage(terminalMessage, classified.provider, classified.model);
  const attempt: WorkerTelemetryAttempt = {
    attempt: 1,
    ...(automaticRetries > 0 ? { automaticRetries } : {}),
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

function readSessionStats(session: RunnableSession): SessionStats | undefined {
  try {
    return session.getSessionStats?.();
  } catch {
    return undefined;
  }
}

function usageFromStats(
  stats: SessionStats | undefined,
  provider: string,
  model: string,
): WorkerTelemetryUsage | undefined {
  const usage = stats?.tokens;
  if (!usage) return undefined;
  const counters = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (
    !counters.some(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    return undefined;
  }
  return {
    provider,
    model,
    ...(validCounter(usage.input) ? { inputTokens: usage.input } : {}),
    ...(validCounter(usage.output) ? { outputTokens: usage.output } : {}),
    ...(validCounter(usage.cacheRead) ? { cachedInputTokens: usage.cacheRead } : {}),
    ...(validCounter(usage.cacheWrite) ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

function usageFromMessage(
  message: SessionEvent["message"] | undefined,
  provider: string,
  model: string,
): WorkerTelemetryUsage | undefined {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const counters = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (
    !counters.some(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    return undefined;
  }
  return {
    provider,
    model,
    ...(validCounter(usage.input) ? { inputTokens: usage.input } : {}),
    ...(validCounter(usage.output) ? { outputTokens: usage.output } : {}),
    ...(validCounter(usage.cacheRead) ? { cachedInputTokens: usage.cacheRead } : {}),
    ...(validCounter(usage.cacheWrite) ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
