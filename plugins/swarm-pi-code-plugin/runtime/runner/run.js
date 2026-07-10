import fs from "node:fs/promises";
import { buildReviewRequest } from "../git/review.js";
import { captureWorktreeChanges, inspectWorktree, requireCleanWorktree } from "../git/worktree.js";
import { executeSession } from "../pi/execute.js";
import { createModelCatalog, describeModels, describeProviders, modelId, orderModels, } from "../pi/models.js";
import { createWorkerSession } from "../pi/runtime.js";
import { finishJob, startJob } from "../state/jobs.js";
import { clearModelConfiguration, loadModelConfiguration, modelPriority, saveModelPriority, } from "../state/model-config.js";
import { clearConfiguration, loadState, saveProfile, setAvailableModels, setModelPriority, } from "../state/state.js";
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
export async function runCommand(args, cwd, dependencies) {
    if (args.command === "configure") {
        throw new Error("configure must be started through the CLI web configuration entry point");
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
    const jobId = await startJob(cwd, { host, kind: args.command, prompt: rawPrompt, cwd });
    if (candidates.length === 0) {
        const result = withMetadata(failure(args.command, args.model ? `Requested Pi model is unavailable: ${args.model}` : "No configured Pi model is available."), host, jobId, 0);
        await finishJob(cwd, jobId, result);
        return result;
    }
    if (args.command === "orchestrate") {
        const result = await runOrchestration({ cwd, host, prompt: rawPrompt, profile: state.config.profile, candidates, dependencies: activeDependencies });
        const final = withMetadata(result, host, jobId, result.attempts ?? 0);
        await finishJob(cwd, jobId, final);
        return final;
    }
    if (args.command === "implement") {
        try {
            await requireCleanWorktree(cwd);
        }
        catch (error) {
            const result = withMetadata(failure(args.command, error instanceof Error ? error.message : String(error)), host, jobId, 0);
            await finishJob(cwd, jobId, result);
            return result;
        }
    }
    const prompt = buildWorkerPrompt({ host, kind: args.command, prompt: rawPrompt, profile: state.config.profile });
    let result = await runWithFallback({
        kind: args.command,
        cwd,
        prompt,
        mode: args.command === "implement" ? "implement" : "readonly",
        candidates,
        dependencies: activeDependencies,
    });
    let diff = "";
    if (args.command === "implement") {
        const changes = await captureWorktreeChanges(cwd);
        diff = changes.diff;
        result = { ...result, changedFiles: changes.changedFiles, diffStat: changes.diffStat };
    }
    const final = withMetadata(result, host, jobId, result.attempts ?? 0);
    await finishJob(cwd, jobId, final, diff);
    return final;
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
        const model = options.candidates[index];
        try {
            const session = await options.dependencies.createSession({ cwd: options.cwd, mode: options.mode, model });
            last = await executeSession({ kind: options.kind, model: modelId(model), prompt: options.prompt, session });
        }
        catch (error) {
            last = failure(options.kind, error instanceof Error ? error.message : String(error), modelId(model));
        }
        const attempts = index + 1;
        last = { ...last, attempts, fallbackUsed: attempts > 1 };
        if (last.success)
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
        prompt: buildWorkerPrompt({
            host: options.host,
            kind: "orchestrate",
            prompt: options.prompt,
            profile: options.profile,
            perspective,
        }),
    })));
    const success = results.every((result) => result.success);
    return {
        kind: "orchestrate",
        status: success ? "succeeded" : "failed",
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
    return {
        kind,
        status: "failed",
        success: false,
        model,
        output,
        changedFiles: [],
        diffStat: "",
        verification: { status: "not-run", commands: [] },
        error: output,
    };
}
