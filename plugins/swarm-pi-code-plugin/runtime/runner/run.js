import fs from "node:fs/promises";
import { buildReviewRequest } from "../git/review.js";
import { captureWorktreeChanges, inspectWorktree, requireCleanWorktree } from "../git/worktree.js";
import { executeSession } from "../pi/execute.js";
import { createModelCatalog, describeModels, describeProviders, modelId, orderModels, } from "../pi/models.js";
import { createWorkerSession } from "../pi/runtime.js";
import { acknowledgeJob, attachJobProcess, cancelJob, finishJob, getJob, heartbeatJob, JOB_HEARTBEAT_INTERVAL_MS, listJobs, markJobRunning, readJobPrompt, readJobRequest, startJob, waitForJob, } from "../state/jobs.js";
import { clearModelConfiguration, loadModelConfiguration, modelPriority, saveModelPriority, } from "../state/model-config.js";
import { clearConfiguration, loadState, saveProfile, setAvailableModels, setModelPriority, } from "../state/state.js";
import { spawnBackgroundWorker } from "./background.js";
import { buildWorkerPrompt } from "./prompts.js";
export function defaultDependencies(modelConfiguration) {
    return {
        catalog: createModelCatalog(modelConfiguration),
        readFile: (file) => fs.readFile(file, "utf8"),
        createSession: async (options) => {
            const { session } = await createWorkerSession({ ...options, modelConfiguration });
            return session;
        },
    };
}
export async function runCommand(args, cwd, dependencies, options = {}) {
    if (args.command === "configure") {
        throw new Error("configure must be started through the CLI web configuration entry point");
    }
    if (args.command === "jobs")
        return handleJobs(args, cwd);
    if (args.command === "__worker") {
        return runBackgroundJob(args, cwd, dependencies, options.signal);
    }
    const state = await loadState(cwd);
    const modelConfiguration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const activeDependencies = dependencies ?? defaultDependencies(modelConfiguration);
    const available = activeDependencies.catalog.available();
    if (args.command === "models") {
        return modelInventory(activeDependencies.catalog, modelConfiguration, args);
    }
    if (args.command === "providers") {
        return {
            providers: describeProviders(activeDependencies.catalog, modelConfiguration),
            registryError: activeDependencies.catalog.error?.() ?? null,
        };
    }
    if (args.command === "init") {
        return handleInit(args, cwd, available, activeDependencies, modelConfiguration);
    }
    const host = args.host;
    const rawPrompt = args.command === "review"
        ? await buildReviewRequest(cwd, { base: args.base, scope: args.scope })
        : await activeDependencies.readFile(args.promptFile);
    const candidates = orderModels(available, {
        requested: args.model,
        priority: modelPriority(modelConfiguration),
    });
    const executionMode = args.executionMode ?? "supervised";
    const timeoutMs = args.timeoutMs ?? defaultTimeoutMs(args.command);
    const job = await startJob(cwd, {
        host,
        kind: args.command,
        prompt: rawPrompt,
        cwd,
        executionMode,
        timeoutMs,
        ...(args.model ? { model: args.model } : {}),
    });
    if (executionMode === "background") {
        try {
            const spawnWorker = options.spawnWorker ?? spawnBackgroundWorker;
            const pid = await spawnWorker({ cwd, jobId: job.id, workerToken: job.workerToken });
            await attachJobProcess(cwd, job.id, job.workerToken, pid);
            return { event: "accepted", jobId: job.id, status: "queued", executionMode: "background" };
        }
        catch (error) {
            const failed = withMetadata(failure(args.command, error instanceof Error ? error.message : String(error)), host, job.id, 0);
            await finishJob(cwd, job.id, failed);
            return failed;
        }
    }
    return runStartedJobSafely({
        args,
        cwd,
        host,
        rawPrompt,
        ...(state.config.profile ? { profile: state.config.profile } : {}),
        candidates,
        dependencies: activeDependencies,
        job,
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
    });
}
async function handleJobs(args, cwd) {
    switch (args.jobsAction) {
        case "list":
            return { jobs: (await listJobs(cwd, args.pendingNotifications ?? false)).map(publicJob) };
        case "status": {
            const snapshot = await getJob(cwd, args.jobId);
            return { job: publicJob(snapshot.job), result: snapshot.result };
        }
        case "wait":
            return waitForJob(cwd, args.jobId, args.waitTimeoutMs);
        case "cancel":
            return { job: publicJob(await cancelJob(cwd, args.jobId)) };
        case "acknowledge":
            return { job: publicJob(await acknowledgeJob(cwd, args.jobId)) };
        default:
            throw new Error(`Unknown jobs action: ${args.jobsAction ?? "<none>"}`);
    }
}
function publicJob(job) {
    const { workerToken: _workerToken, ...publicRecord } = job;
    return publicRecord;
}
async function runBackgroundJob(args, cwd, dependencies, outerSignal) {
    const request = await readJobRequest(cwd, args.jobId);
    if (request.workerToken !== args.workerToken)
        throw new Error(`Worker token mismatch for job: ${request.id}`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const forwardAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
    try {
        const snapshot = await getJob(cwd, request.id);
        if (snapshot.job.cancelRequestedAt)
            controller.abort();
        const state = await loadState(cwd);
        const modelConfiguration = await loadModelConfiguration(cwd, state.config.modelPriority);
        const activeDependencies = dependencies ?? defaultDependencies(modelConfiguration);
        const candidates = orderModels(activeDependencies.catalog.available(), {
            requested: request.model,
            priority: modelPriority(modelConfiguration),
        });
        const prompt = await readJobPrompt(cwd, request.id);
        return runStartedJobSafely({
            args: requestArguments(request),
            cwd,
            host: request.host,
            rawPrompt: prompt,
            ...(state.config.profile ? { profile: state.config.profile } : {}),
            candidates,
            dependencies: activeDependencies,
            job: { id: request.id, workerToken: request.workerToken },
            timeoutMs: request.timeoutMs,
            signal: controller.signal,
        });
    }
    catch (error) {
        const failed = withMetadata(failure(request.kind, error instanceof Error ? error.message : String(error), request.model ?? null), request.host, request.id, 0);
        await finishJob(cwd, request.id, failed);
        return failed;
    }
    finally {
        process.removeListener("SIGINT", abort);
        process.removeListener("SIGTERM", abort);
        outerSignal?.removeEventListener("abort", forwardAbort);
    }
}
function requestArguments(request) {
    return {
        command: request.kind,
        host: request.host,
        ...(request.model ? { model: request.model } : {}),
        executionMode: "supervised",
        timeoutMs: request.timeoutMs,
        reconfigure: false,
        reset: false,
        json: true,
    };
}
async function runStartedJobSafely(options) {
    try {
        return await runStartedJob(options);
    }
    catch (error) {
        const kind = options.args.command;
        const failed = withMetadata(failure(kind, error instanceof Error ? error.message : String(error), options.args.model ?? null), options.host, options.job.id, 0);
        await finishJob(options.cwd, options.job.id, failed);
        return failed;
    }
}
async function runStartedJob(options) {
    const kind = options.args.command;
    const jobId = options.job.id;
    await markJobRunning(options.cwd, jobId, options.job.workerToken, process.pid);
    const heartbeat = setInterval(() => {
        void heartbeatJob(options.cwd, jobId, options.job.workerToken, process.pid).catch(() => { });
    }, JOB_HEARTBEAT_INTERVAL_MS);
    const deadline = Date.now() + options.timeoutMs;
    try {
        if (options.candidates.length === 0) {
            const result = withMetadata(failure(kind, options.args.model ? `Requested Pi model is unavailable: ${options.args.model}` : "No configured Pi model is available."), options.host, jobId, 0);
            await finishJob(options.cwd, jobId, result);
            return result;
        }
        if (kind === "orchestrate") {
            const result = await runOrchestration({
                cwd: options.cwd,
                host: options.host,
                prompt: options.rawPrompt,
                profile: options.profile,
                candidates: options.candidates,
                dependencies: options.dependencies,
                deadline,
                ...(options.signal ? { signal: options.signal } : {}),
            });
            const final = withMetadata(result, options.host, jobId, result.attempts ?? 0);
            await finishJob(options.cwd, jobId, final);
            return final;
        }
        if (kind === "implement") {
            try {
                await requireCleanWorktree(options.cwd);
            }
            catch (error) {
                const result = withMetadata(failure(kind, error instanceof Error ? error.message : String(error)), options.host, jobId, 0);
                await finishJob(options.cwd, jobId, result);
                return result;
            }
        }
        const prompt = buildWorkerPrompt({
            host: options.host,
            kind,
            prompt: options.rawPrompt,
            profile: options.profile,
        });
        let result = await runWithFallback({
            kind,
            cwd: options.cwd,
            prompt,
            mode: kind === "implement" ? "implement" : "readonly",
            candidates: options.candidates,
            dependencies: options.dependencies,
            deadline,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        let diff = "";
        if (kind === "implement") {
            const changes = await captureWorktreeChanges(options.cwd);
            diff = changes.diff;
            result = { ...result, changedFiles: changes.changedFiles, diffStat: changes.diffStat };
        }
        const final = withMetadata(result, options.host, jobId, result.attempts ?? 0);
        await finishJob(options.cwd, jobId, final, diff);
        return final;
    }
    finally {
        clearInterval(heartbeat);
    }
}
async function handleInit(args, cwd, available, dependencies, modelConfiguration) {
    if (args.reset) {
        await clearModelConfiguration(cwd);
        const state = await clearConfiguration(cwd);
        return initStatus(state, [], [], args, true);
    }
    const detected = available.map(modelId);
    await setAvailableModels(cwd, detected);
    const selectedPriority = args.modelPriority ?? (args.modelPriorityFile
        ? parseStringArrayJson(await dependencies.readFile(args.modelPriorityFile), "model priority file")
        : undefined);
    if (selectedPriority) {
        const unavailable = selectedPriority.filter((model) => !detected.includes(model));
        if (unavailable.length)
            throw new Error(`Selected Pi models are not available: ${unavailable.join(", ")}`);
        await saveModelPriority(cwd, modelConfiguration, selectedPriority);
        await setModelPriority(cwd, selectedPriority);
    }
    const profile = args.profile ?? (args.profileFile
        ? parseObjectJson(await dependencies.readFile(args.profileFile), "profile file")
        : undefined);
    if (profile)
        await saveProfile(cwd, parseProfile(profile));
    const state = await loadState(cwd);
    const currentModelConfiguration = await loadModelConfiguration(cwd, state.config.modelPriority);
    return initStatus(state, modelPriority(currentModelConfiguration), detected, args, false);
}
function parseStringArrayJson(value, label) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error(`${label} must contain a JSON string array`);
    }
    return parsed;
}
function parseObjectJson(value, label) {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${label} must contain a JSON object`);
    }
    return parsed;
}
function initStatus(state, priority, detected, args, reset) {
    const activeModel = priority.find((model) => detected.includes(model)) ?? null;
    return {
        configured: Boolean(activeModel || state.config.profile),
        reconfigure: args.reconfigure,
        reset,
        activeModel,
        modelPriority: priority,
        detectedModels: detected,
        profile: state.config.profile ?? null,
        jobs: state.jobs.length,
    };
}
async function runWithFallback(options) {
    let last = failure(options.kind, "No model attempt completed.");
    for (let index = 0; index < options.candidates.length; index += 1) {
        const remainingMs = options.deadline - Date.now();
        if (remainingMs <= 0)
            return statusResult(options.kind, "timed-out", "Pi job timed out.");
        const model = options.candidates[index];
        try {
            const session = await options.dependencies.createSession({ cwd: options.cwd, mode: options.mode, model });
            last = await executeSession({
                kind: options.kind,
                model: modelId(model),
                prompt: options.prompt,
                session,
                timeoutMs: remainingMs,
                ...(options.signal ? { signal: options.signal } : {}),
            });
        }
        catch (error) {
            last = failure(options.kind, error instanceof Error ? error.message : String(error), modelId(model));
        }
        const attempts = index + 1;
        last = { ...last, attempts, fallbackUsed: attempts > 1 };
        if (last.success)
            return last;
        if (last.status === "cancelled" || last.status === "timed-out")
            return last;
        if (options.mode === "implement" && !(await inspectWorktree(options.cwd)).clean)
            return last;
    }
    return last;
}
async function runOrchestration(options) {
    const perspectives = [
        "Correctness and failure modes",
        "Architecture, maintainability, and security",
        "Testing, compatibility, and user experience",
    ];
    const results = await Promise.all(perspectives.map((perspective) => runWithFallback({
        kind: "orchestrate",
        cwd: options.cwd,
        mode: "readonly",
        candidates: options.candidates,
        dependencies: options.dependencies,
        deadline: options.deadline,
        ...(options.signal ? { signal: options.signal } : {}),
        prompt: buildWorkerPrompt({
            host: options.host,
            kind: "orchestrate",
            prompt: options.prompt,
            profile: options.profile,
            perspective,
        }),
    })));
    const success = results.every((result) => result.success);
    const status = success
        ? "succeeded"
        : results.some((result) => result.status === "cancelled")
            ? "cancelled"
            : results.some((result) => result.status === "timed-out")
                ? "timed-out"
                : "failed";
    return {
        kind: "orchestrate",
        status,
        success,
        model: results.find((result) => result.model)?.model ?? null,
        output: results
            .map((result, index) => `## ${perspectives[index]}\n\n${result.output}`)
            .join("\n\n"),
        changedFiles: [],
        diffStat: "",
        verification: { status: "not-run", commands: [] },
        attempts: results.reduce((total, result) => total + (result.attempts ?? 0), 0),
        fallbackUsed: results.some((result) => result.fallbackUsed),
        error: success ? null : "One or more orchestration workers failed.",
    };
}
function modelInventory(catalog, configuration, args) {
    const available = catalog.available();
    const source = args.allModels ? catalog.all?.() ?? available : available;
    const models = args.provider
        ? source.filter((model) => model.provider === args.provider)
        : source;
    const providers = {};
    for (const model of models)
        providers[model.provider] = (providers[model.provider] ?? 0) + 1;
    return {
        models: describeModels(models),
        active: modelPriority(configuration).find((candidate) => available.some((model) => modelId(model) === candidate)) ?? null,
        providers,
    };
}
function parseProfile(value) {
    return {
        ...(typeof value.goal === "string" ? { goal: value.goal } : {}),
        ...(Array.isArray(value.dirs) && value.dirs.every((item) => typeof item === "string")
            ? { dirs: value.dirs }
            : {}),
        ...(Array.isArray(value.tasks) && value.tasks.every((item) => typeof item === "string")
            ? { tasks: value.tasks }
            : {}),
        configuredAt: typeof value.configuredAt === "string" ? value.configuredAt : new Date().toISOString(),
    };
}
function withMetadata(result, host, jobId, attempts) {
    return {
        ...result,
        host,
        jobId,
        attempts,
        fallbackUsed: result.fallbackUsed ?? attempts > 1,
        error: result.success ? null : result.error ?? result.output,
    };
}
function failure(kind, output, model = null) {
    return statusResult(kind, "failed", output, model);
}
function statusResult(kind, status, output, model = null) {
    return {
        kind,
        status,
        success: status === "succeeded",
        model,
        output,
        changedFiles: [],
        diffStat: "",
        verification: { status: "not-run", commands: [] },
        error: output,
    };
}
function defaultTimeoutMs(kind) {
    return kind === "orchestrate" || kind === "implement" ? 60 * 60_000 : 30 * 60_000;
}
