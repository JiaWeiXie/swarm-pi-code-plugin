import { randomUUID } from "node:crypto";
import { parseArguments } from "./runner/args.js";
export async function main(argv = process.argv.slice(2)) {
    const wantsJson = argv.includes("--json");
    try {
        const args = parseArguments(argv);
        if (args.command === "configure") {
            const { startConfigurationServer } = await import("./web/configuration-server.js");
            const session = await startConfigurationServer(process.cwd(), {
                host: args.host,
                port: args.port,
                openBrowser: !args.noOpen,
                mode: args.configurationSection === "project" ? "project" : "full",
                ...(args.continuationId ? { continuationId: args.continuationId } : {}),
            });
            process.stdout.write(args.json
                ? `${JSON.stringify({ event: "ready", url: session.url })}\n`
                : `Swarm Pi setup is available at:\n${session.url}\n\nWaiting for the browser configuration to finish...\n`);
            const completion = await session.completion;
            process.stdout.write(`${JSON.stringify(completion, null, args.json ? 2 : 0)}\n`);
            return completion.status === "timed-out" ? 1 : 0;
        }
        if (args.command === "dashboard") {
            const { startConfigurationServer } = await import("./web/configuration-server.js");
            const session = await startConfigurationServer(process.cwd(), {
                port: args.port,
                openBrowser: !args.noOpen,
                mode: "dashboard",
            });
            process.stdout.write(args.json
                ? `${JSON.stringify({ event: "ready", url: session.url })}\n`
                : `Swarm Pi usage dashboard is available at:\n${session.url}\n\nPress Ctrl-C to close it.\n`);
            const stop = () => void session.close();
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            await session.completion;
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
            return 0;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        const watch = args.command === "jobs" && args.jobsAction === "watch";
        if (watch) {
            process.once("SIGINT", abort);
            process.once("SIGTERM", abort);
            try {
                return await streamJobWatch(args, process.cwd(), controller.signal);
            }
            finally {
                process.removeListener("SIGINT", abort);
                process.removeListener("SIGTERM", abort);
            }
        }
        const delegated = isDelegatedCommand(args.command);
        if (delegated) {
            process.once("SIGINT", abort);
            process.once("SIGTERM", abort);
        }
        const { runCommand } = await import("./runner/run.js");
        const result = await runCommand(args, process.cwd(), undefined, {
            signal: controller.signal,
        }).finally(() => {
            process.removeListener("SIGINT", abort);
            process.removeListener("SIGTERM", abort);
        });
        if (args.command === "jobs" && args.jobsAction === "prune" && !args.json) {
            const { formatPruneReport } = await import("./state/prune.js");
            process.stdout.write(formatPruneReport(result));
        }
        else {
            const serialized = JSON.stringify(result, null, args.json ? 2 : 0);
            process.stdout.write(`${serialized}\n`);
        }
        if ("event" in result && result.event === "wait-timed-out")
            return 3;
        if ("event" in result && result.event === "approval-required")
            return 4;
        if ("event" in result &&
            (result.event === "setup-required" || result.event === "workspace-action-required"))
            return 5;
        return "success" in result && !result.success ? 1 : 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (argv[0] === "jobs" && argv[1] === "watch") {
            process.stderr.write(`${message}\n`);
        }
        else if (wantsJson) {
            process.stdout.write(`${JSON.stringify({ event: "system-error", errorCode: "system-error", message })}\n`);
        }
        else {
            process.stderr.write(`${message}\n`);
        }
        return 2;
    }
}
export function isDelegatedCommand(command) {
    return (command === "ask" ||
        command === "review" ||
        command === "plan" ||
        command === "implement" ||
        command === "orchestrate" ||
        command === "discover" ||
        command === "scaffold" ||
        command === "setup");
}
async function streamJobWatch(args, cwd, signal) {
    const [jobEvents, jobs, stateObserver, state] = await Promise.all([
        import("./state/job-events.js"),
        import("./state/jobs.js"),
        import("./state/state-observer.js"),
        import("./state/state.js"),
    ]);
    const watcherId = randomUUID();
    const seen = new Set();
    let since;
    let first = true;
    const observer = stateObserver.stateObservers.acquire(await stateObserver.canonicalStateFile(await state.resolveStateFile(cwd)));
    try {
        while (true) {
            if (signal.aborted)
                return 0;
            const generation = observer.generation();
            await jobs.reconcileJobs(cwd);
            const currentState = await state.loadState(cwd);
            const projectionOptions = {
                includeProgress: true,
            };
            if (args.jobId)
                projectionOptions.jobId = args.jobId;
            if (!first) {
                projectionOptions.includeResolved = true;
                if (since)
                    projectionOptions.since = since;
            }
            const snapshot = jobEvents.createJobEventSnapshot(currentState, projectionOptions);
            if (first) {
                writeNdjson(jobEvents.createWatchReadyEvent(watcherId, snapshot.pendingCount, snapshot.snapshotAt));
            }
            for (const event of jobEvents.dedupeJobEvents(snapshot.events, seen))
                writeNdjson(event);
            first = false;
            since = snapshot.snapshotAt;
            if (args.once)
                return 0;
            if (args.jobId) {
                const job = currentState.jobs.find((candidate) => candidate.id === args.jobId);
                if (job && jobs.isTerminalJobStatus(String(job.status)))
                    return 0;
            }
            await waitForWatchInterval(signal, observer, generation);
        }
    }
    finally {
        observer.release();
    }
}
function writeNdjson(value) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}
export function jobWatchFallbackMs(observer) {
    return observer.isWatching() ? 5_000 : 500;
}
async function waitForWatchInterval(signal, observer, generation) {
    await new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        let settled = false;
        const abort = () => done();
        function done() {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener("abort", abort);
            resolve();
        }
        signal.addEventListener("abort", abort, { once: true });
        void observer.waitForChange(generation, jobWatchFallbackMs(observer)).then(done, done);
    });
}
