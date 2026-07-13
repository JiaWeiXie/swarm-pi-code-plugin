import type { TaskKind, WorkerResult } from "../core/contracts.js";

interface SessionEvent {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  message?: {
    role?: string;
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
  };
}

export interface RunnableSession {
  prompt(prompt: string): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  abort?(): Promise<void>;
  waitForIdle?(): Promise<void>;
  readonly thinkingLevel?: string;
  dispose(): void;
}

export interface ExecuteSessionOptions {
  kind: TaskKind;
  model: string;
  prompt: string;
  session: RunnableSession;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function executeSession(options: ExecuteSessionOptions): Promise<WorkerResult> {
  let output = "";
  let terminalMessage: SessionEvent["message"];
  const unsubscribe = options.session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      output += event.assistantMessageEvent.delta ?? "";
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      terminalMessage = event.message;
    }
  });

  let timeout: NodeJS.Timeout | undefined;
  let removeAbortListener = () => {};
  try {
    const promptOutcome = options.session.prompt(options.prompt).then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "error" as const, error }),
    );
    const interruption = new Promise<{ type: "interrupted"; status: "cancelled" | "timed-out" }>(
      (resolve) => {
        const interrupt = (status: "cancelled" | "timed-out") => {
          void interruptSession(options.session).finally(() =>
            resolve({ type: "interrupted", status }),
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
        if (options.timeoutMs !== undefined) {
          timeout = setTimeout(() => interrupt("timed-out"), options.timeoutMs);
        }
      },
    );
    const outcome = await Promise.race([promptOutcome, interruption]);
    if (outcome.type === "interrupted") {
      const message =
        outcome.status === "timed-out" ? "Pi session timed out." : "Pi session was cancelled.";
      return result(options.kind, outcome.status, options.model, message);
    }
    if (outcome.type === "error") {
      const message =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      return result(options.kind, "failed", options.model, message);
    }
    return resultFromTerminalMessage(options.kind, options.model, output.trim(), terminalMessage);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener();
    unsubscribe();
    options.session.dispose();
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
