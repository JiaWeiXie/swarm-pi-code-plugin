import { randomUUID } from "node:crypto";

import { parseArguments } from "./runner/args.js";
import { runCommand } from "./runner/run.js";
import { createJobEventSnapshot, createWatchReadyEvent, dedupeJobEvents } from "./state/job-events.js";
import { isTerminalJobStatus, reconcileJobs } from "./state/jobs.js";
import { loadState } from "./state/state.js";
import { startConfigurationServer } from "./web/configuration-server.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const wantsJson = argv.includes("--json");
  try {
    const args = parseArguments(argv);
    if (args.command === "configure") {
      const session = await startConfigurationServer(process.cwd(), {
        host: args.host,
        port: args.port,
        openBrowser: !args.noOpen,
        mode: args.configurationSection === "project" ? "project" : "full",
        ...(args.continuationId ? { continuationId: args.continuationId } : {}),
      });
      process.stdout.write(
        args.json
          ? `${JSON.stringify({ event: "ready", url: session.url })}\n`
          : `Swarm Pi setup is available at:\n${session.url}\n\nWaiting for the browser configuration to finish...\n`,
      );
      const completion = await session.completion;
      process.stdout.write(`${JSON.stringify(completion, null, args.json ? 2 : 0)}\n`);
      return completion.status === "timed-out" ? 1 : 0;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const watch = args.command === "jobs" && args.jobsAction === "watch";
    if (watch) {
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        return await streamJobWatch(args, process.cwd(), controller.signal);
      } finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
      }
    }
    const delegated = args.command === "ask" || args.command === "review" ||
      args.command === "plan" || args.command === "implement" || args.command === "orchestrate" ||
      args.command === "scaffold" || args.command === "setup";
    if (delegated) {
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
    }
    const result = await runCommand(args, process.cwd(), undefined, { signal: controller.signal }).finally(() => {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    });
    const serialized = JSON.stringify(result, null, args.json ? 2 : 0);
    process.stdout.write(`${serialized}\n`);

    if ("event" in result && result.event === "wait-timed-out") return 3;
    if ("event" in result && result.event === "approval-required") return 4;
    if ("event" in result && (result.event === "setup-required" || result.event === "workspace-action-required")) return 5;
    return "success" in result && !result.success ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv[0] === "jobs" && argv[1] === "watch") {
      process.stderr.write(`${message}\n`);
    } else if (wantsJson) {
      process.stdout.write(`${JSON.stringify({ event: "system-error", errorCode: "system-error", message })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
  }
}

async function streamJobWatch(
  args: ReturnType<typeof parseArguments>,
  cwd: string,
  signal: AbortSignal,
): Promise<number> {
  const watcherId = randomUUID();
  const seen = new Set<string>();
  let since: string | undefined;
  let first = true;

  while (true) {
    if (signal.aborted) return 0;
    await reconcileJobs(cwd);
    const state = await loadState(cwd);
    const projectionOptions: Parameters<typeof createJobEventSnapshot>[1] = { includeProgress: true };
    if (args.jobId) projectionOptions.jobId = args.jobId;
    if (!first) {
      projectionOptions.includeResolved = true;
      if (since) projectionOptions.since = since;
    }
    const snapshot = createJobEventSnapshot(state, projectionOptions);
    if (first) {
      writeNdjson(createWatchReadyEvent(watcherId, snapshot.pendingCount, snapshot.snapshotAt));
    }
    for (const event of dedupeJobEvents(snapshot.events, seen)) writeNdjson(event);
    first = false;
    since = snapshot.snapshotAt;

    if (args.once) return 0;
    if (args.jobId) {
      const job = state.jobs.find((candidate) => candidate.id === args.jobId);
      if (job && isTerminalJobStatus(String(job.status))) return 0;
    }
    await waitForWatchInterval(signal);
  }
}

function writeNdjson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForWatchInterval(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(done, 500);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    function done(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
