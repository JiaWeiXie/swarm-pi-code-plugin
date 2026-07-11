import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_ADAPTIVE_POLICY, DEFAULT_BACKGROUND_ROLE_POLICY, isThinkingLevel, isWorkerRole, normalizeAdaptivePolicy, listDefaultRoles, } from "../orchestration/roles.js";
import { createPiEnvironment } from "../pi/environment.js";
import { executeSession } from "../pi/execute.js";
import { createWorkerSession } from "../pi/runtime.js";
import { createModelCatalog, describeProviders, modelId } from "../pi/models.js";
import { detectSandboxAvailability } from "../sandbox/availability.js";
import { assessWorkspace } from "../git/worktree.js";
import { loadModelConfiguration, modelPriority, parseModelConfiguration, saveModelConfiguration, resolveModelConfigurationFile, } from "../state/model-config.js";
import { loadState, resolveStateDir, resolveStateFile, resolveWorkspaceRoot, saveProjectSettings, saveExecutionSettings, setModelPriority, setSandboxMode, } from "../state/state.js";
import { discoverEndpoint, discoverLocalEndpoints, } from "./model-discovery.js";
export async function previewProviderConnection(cwd, credential, env = process.env) {
    const normalized = normalizeCredential(credential);
    if (!normalized)
        throw new Error("Choose a provider and enter its API key");
    const state = await loadState(cwd);
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const pi = createPiEnvironment(configuration, env);
    pi.authStorage.setRuntimeApiKey(normalized.provider, normalized.apiKey);
    const all = pi.modelRegistry.getAll();
    const providerModels = all.filter((model) => model.provider === normalized.provider);
    if (providerModels.length === 0)
        throw new Error(`Unknown provider: ${normalized.provider}`);
    const available = new Set(pi.modelRegistry.getAvailable().map(modelId));
    const models = providerModels.map((model) => browserModel(model, available.has(modelId(model)), configuration));
    return {
        provider: {
            id: normalized.provider,
            name: pi.modelRegistry.getProviderDisplayName(normalized.provider),
            ready: models.some((model) => model.available),
            modelCount: models.length,
            availableModelCount: models.filter((model) => model.available).length,
            auth: { source: "runtime", label: "API key entered in this setup session" },
            selection: null,
            custom: false,
        },
        models,
    };
}
export async function discoverConfigurationEndpoint(cwd, request, env = process.env) {
    const state = await loadState(cwd);
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const catalog = createModelCatalog(configuration, env);
    const all = catalog.all?.() ?? catalog.available();
    return discoverEndpoint(request, all, {
        reservedProviderIds: [
            ...all.map((model) => model.provider),
            ...(request.reservedProviderIds ?? []),
        ],
    });
}
export async function discoverLocalConfigurationEndpoints(cwd, env = process.env) {
    const state = await loadState(cwd);
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const catalog = createModelCatalog(configuration, env);
    const all = catalog.all?.() ?? catalog.available();
    return discoverLocalEndpoints(all, {
        reservedProviderIds: all.map((model) => model.provider),
    });
}
export async function loadConfigurationView(cwd, env = process.env) {
    const state = await loadState(cwd);
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const catalog = createModelCatalog(configuration, env);
    const all = catalog.all?.() ?? catalog.available();
    const availableModels = catalog.available();
    const available = new Set(availableModels.map(modelId));
    const selected = new Set(modelPriority(configuration));
    const custom = new Set(configuration.customProviders.map((provider) => provider.id));
    const relevant = all.filter((model) => available.has(modelId(model)) || selected.has(modelId(model)) || custom.has(model.provider));
    const providerIds = [...new Set(all.map((model) => model.provider))];
    return {
        configuration,
        profile: state.config.profile ?? null,
        directoryOptions: await projectDirectoryOptions(cwd, state.config.profile?.dirs ?? []),
        providers: describeProviders(catalog, configuration),
        providerCatalog: providerIds
            .map((id) => ({ id, name: catalog.displayName?.(id) ?? id }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        models: relevant.map((model) => browserModel(model, available.has(modelId(model)), configuration)),
        registryError: catalog.error?.() ?? null,
        sandboxMode: state.config.sandboxMode ?? "strict",
        sandboxAvailability: detectSandboxAvailability(),
        rolePolicies: structuredClone(state.config.rolePolicies ?? {}),
        adaptivePolicy: normalizeAdaptivePolicy(state.config.adaptivePolicy),
        backgroundRolePolicy: structuredClone(state.config.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY),
        roles: listDefaultRoles(),
        workspace: await assessWorkspace(cwd),
        workspaceId: createHash("sha256").update(await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd))).digest("hex").slice(0, 24),
    };
}
function browserModel(model, available, configuration) {
    const configured = configuration.customProviders
        .find((provider) => provider.id === model.provider)
        ?.models.find((entry) => entry.id === model.id);
    const isCustomModel = configured !== undefined;
    return {
        id: modelId(model),
        provider: model.provider,
        model: model.id,
        name: model.name,
        available,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: isCustomModel ? configured.contextWindow ?? null : model.contextWindow ?? null,
        maxTokens: isCustomModel ? configured.maxTokens ?? null : model.maxTokens ?? null,
        metadata: {
            contextWindow: isCustomModel
                ? configured.metadata?.contextWindow ?? null
                : model.contextWindow
                    ? "pi-catalog"
                    : null,
            maxTokens: isCustomModel
                ? configured.metadata?.maxTokens ?? null
                : model.maxTokens
                    ? "pi-catalog"
                    : null,
        },
    };
}
export async function saveConfigurationSubmission(cwd, submission, env = process.env) {
    const current = await loadConfigurationView(cwd, env);
    const profile = submission.profile
        ? await normalizeProjectProfile(cwd, submission.profile)
        : undefined;
    const sandboxMode = normalizeSandboxMode(submission.sandboxMode, current.sandboxMode);
    const execution = normalizeExecutionSettings(submission, current);
    assertSandboxModeAvailable(sandboxMode);
    const candidate = parseModelConfiguration({
        version: 1,
        primary: submission.primary,
        fallbacks: submission.fallbacks,
        customProviders: submission.customProviders,
        updatedAt: null,
    });
    assertNoBuiltInProviderOverride(current, candidate);
    const pi = createPiEnvironment(candidate, env);
    const credentials = normalizeCredentials(submission);
    for (const credential of credentials) {
        pi.authStorage.setRuntimeApiKey(credential.provider, credential.apiKey);
    }
    const all = new Map(pi.modelRegistry.getAll().map((model) => [modelId(model), model]));
    const priority = modelPriority(candidate);
    const missing = priority.filter((reference) => !all.has(reference));
    if (missing.length > 0) {
        throw new Error(`Unknown model selection: ${missing.join(", ")}`);
    }
    for (const credential of credentials) {
        if (![...all.values()].some((model) => model.provider === credential.provider)) {
            throw new Error(`Unknown credential provider: ${credential.provider}`);
        }
    }
    const available = new Set(pi.modelRegistry.getAvailable().map(modelId));
    const unavailable = priority.filter((reference) => !available.has(reference));
    if (unavailable.length > 0) {
        throw new Error(`Selected models are not authenticated: ${unavailable.join(", ")}`);
    }
    assertExecutionModels(execution, all, available, sandboxMode);
    if (env.SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST !== "1") {
        const smokeModels = [...new Set([
                ...(candidate.primary ? [candidate.primary] : []),
                ...(sandboxMode === "adaptive" ? execution.adaptivePolicy.classifierModels : []),
            ])];
        for (const reference of smokeModels) {
            const model = all.get(reference);
            const { session } = await createWorkerSession({
                cwd,
                mode: "readonly",
                model,
                modelConfiguration: candidate,
                authStorage: pi.authStorage,
                modelRegistry: pi.modelRegistry,
                thinkingLevel: "minimal",
            });
            const smoke = await executeSession({
                kind: "ask",
                model: reference,
                prompt: "Reply with exactly READY.",
                session,
                timeoutMs: 15_000,
            });
            if (!smoke.success)
                throw new Error(`Model smoke test failed for ${reference}: ${smoke.error ?? smoke.output}`);
        }
    }
    const modelFile = await resolveModelConfigurationFile(cwd);
    const stateFile = await resolveStateFile(cwd);
    const fileSnapshots = await Promise.all([snapshotFile(modelFile), snapshotFile(stateFile)]);
    const credentialSnapshots = credentials.map((credential) => ({
        provider: credential.provider,
        value: pi.authStorage.get(credential.provider),
    }));
    try {
        for (const credential of credentials) {
            pi.authStorage.removeRuntimeApiKey(credential.provider);
            pi.authStorage.set(credential.provider, { type: "api_key", key: credential.apiKey });
        }
        const saved = await saveModelConfiguration(cwd, candidate);
        await setModelPriority(cwd, modelPriority(saved));
        if (profile)
            await saveProjectSettings(cwd, profile, sandboxMode, execution);
        else
            await saveExecutionSettings(cwd, sandboxMode, execution);
    }
    catch (error) {
        const rollbackErrors = [];
        for (const snapshot of credentialSnapshots) {
            try {
                if (snapshot.value)
                    pi.authStorage.set(snapshot.provider, snapshot.value);
                else
                    pi.authStorage.remove(snapshot.provider);
            }
            catch (rollbackError) {
                rollbackErrors.push(`credential:${snapshot.provider}:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
        }
        for (const snapshot of fileSnapshots) {
            try {
                await restoreFile(snapshot);
            }
            catch (rollbackError) {
                rollbackErrors.push(`file:${snapshot.file}:${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
        }
        if (rollbackErrors.length > 0) {
            await writeRecoveryJournal(cwd, rollbackErrors);
            throw new Error("Configuration failed and could not be fully rolled back; run doctor (configuration-recovery-required)");
        }
        throw error;
    }
    return loadConfigurationView(cwd, env);
}
async function snapshotFile(file) {
    const contents = await fs.readFile(file).catch((error) => {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    });
    return { file, ...(contents ? { contents } : {}) };
}
async function restoreFile(snapshot) {
    if (!snapshot.contents) {
        await fs.rm(snapshot.file, { force: true });
        return;
    }
    await fs.mkdir(path.dirname(snapshot.file), { recursive: true, mode: 0o700 });
    const temporary = `${snapshot.file}.${process.pid}.rollback`;
    await fs.writeFile(temporary, snapshot.contents, { mode: 0o600 });
    await fs.rename(temporary, snapshot.file);
}
async function writeRecoveryJournal(cwd, errors) {
    const directory = path.join(await resolveStateDir(cwd), "recovery");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, "configuration.json"), `${JSON.stringify({
        code: "configuration-recovery-required",
        createdAt: new Date().toISOString(),
        errors: errors.map((error) => error.replace(/(?:sk-|key=)[^\s:]+/gi, "[redacted]")),
    }, null, 2)}\n`, { mode: 0o600 });
}
export async function saveProjectProfileSubmission(cwd, submission) {
    const current = await loadState(cwd);
    const settings = "profile" in submission ? submission : { profile: submission };
    const profile = await normalizeProjectProfile(cwd, settings.profile);
    const sandboxMode = normalizeSandboxMode(settings.sandboxMode, current.config.sandboxMode ?? "strict");
    const execution = normalizeExecutionSettings(settings, {
        rolePolicies: current.config.rolePolicies ?? {},
        adaptivePolicy: normalizeAdaptivePolicy(current.config.adaptivePolicy),
        backgroundRolePolicy: current.config.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY,
    });
    assertSandboxModeAvailable(sandboxMode);
    const modelConfiguration = await loadModelConfiguration(cwd, current.config.modelPriority);
    const catalog = createModelCatalog(modelConfiguration);
    const all = new Map((catalog.all?.() ?? catalog.available()).map((model) => [modelId(model), model]));
    const available = new Set(catalog.available().map(modelId));
    assertExecutionModels(execution, all, available, sandboxMode);
    const state = await saveProjectSettings(cwd, profile, sandboxMode, execution);
    return state.config.profile;
}
function normalizeSandboxMode(value, fallback) {
    if (value === undefined)
        return fallback;
    if (value === "strict" || value === "adaptive" || value === "lenient")
        return value;
    throw new Error("Sandbox mode must be strict, adaptive, or lenient");
}
function assertSandboxModeAvailable(mode) {
    if (mode === "strict")
        return;
    const availability = detectSandboxAvailability();
    if (!availability.available)
        throw new Error(availability.reason ?? "Lenient sandboxing is unavailable");
}
function normalizeExecutionSettings(value, fallback) {
    const rolePolicies = {};
    const source = value.rolePolicies ?? fallback.rolePolicies ?? {};
    for (const [role, raw] of Object.entries(source)) {
        if (!isWorkerRole(role) || !raw || typeof raw !== "object")
            continue;
        const policy = raw;
        if (policy.thinkingLevel !== undefined && !isThinkingLevel(policy.thinkingLevel)) {
            throw new Error(`Invalid thinking level for ${role}`);
        }
        if (policy.maxAttempts !== undefined && (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 2)) {
            throw new Error(`Role ${role} max attempts must be 1 or 2`);
        }
        rolePolicies[role] = {
            ...(Array.isArray(policy.models) ? { models: [...new Set(policy.models)] } : {}),
            ...(policy.thinkingLevel ? { thinkingLevel: policy.thinkingLevel } : {}),
            ...(policy.maxAttempts ? { maxAttempts: policy.maxAttempts } : {}),
        };
    }
    const adaptivePolicy = normalizeAdaptivePolicy(value.adaptivePolicy ?? fallback.adaptivePolicy ?? DEFAULT_ADAPTIVE_POLICY);
    validateAdaptivePolicy(adaptivePolicy);
    return {
        rolePolicies,
        adaptivePolicy,
        backgroundRolePolicy: {
            mechanicalExecutor: (value.backgroundRolePolicy ?? fallback.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY).mechanicalExecutor === true,
        },
    };
}
function validateAdaptivePolicy(policy) {
    const capabilities = new Set([
        "filesystem.read-workspace", "filesystem.write-workspace", "filesystem.write-temp",
        "git.read", "shell.execute", "network.connect",
    ]);
    for (const domain of policy.trustedDomains) {
        if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ||
            domain === "localhost" || /^\d+(?:\.\d+){3}$/.test(domain)) {
            throw new Error(`Invalid trusted domain: ${domain}`);
        }
    }
    if (policy.rules.length > 128)
        throw new Error("Adaptive policy supports at most 128 rules");
    for (const rule of policy.rules) {
        if (!rule || typeof rule.id !== "string" || !rule.id || !["deny", "ask", "allow"].includes(rule.effect) ||
            !capabilities.has(rule.capability)) {
            throw new Error("Adaptive policy rules require an id, valid effect, and capability");
        }
    }
}
function assertExecutionModels(execution, all, available, sandboxMode) {
    const selected = [
        ...Object.values(execution.rolePolicies).flatMap((policy) => policy?.models ?? []),
        ...execution.adaptivePolicy.classifierModels,
    ];
    const unknown = selected.filter((model) => !all.has(model));
    if (unknown.length)
        throw new Error(`Unknown role or classifier model: ${[...new Set(unknown)].join(", ")}`);
    const unavailable = selected.filter((model) => !available.has(model));
    if (unavailable.length)
        throw new Error(`Role or classifier models are not authenticated: ${[...new Set(unavailable)].join(", ")}`);
    if (sandboxMode === "adaptive" && execution.adaptivePolicy.classifierModels.length === 0) {
        throw new Error("Adaptive mode requires at least one classifier model");
    }
}
async function projectDirectoryOptions(cwd, selected) {
    const root = await resolveWorkspaceRoot(cwd);
    const entries = await fs.readdir(root, { withFileTypes: true });
    const discovered = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .map((entry) => entry.name);
    return [...new Set([...discovered, ...selected])].sort((left, right) => left.localeCompare(right));
}
async function normalizeProjectProfile(cwd, submission) {
    if (typeof submission !== "object" || submission === null || Array.isArray(submission)) {
        throw new Error("Project profile must be a JSON object");
    }
    if (typeof submission.goal !== "string" || !submission.goal.trim()) {
        throw new Error("Project goal is required");
    }
    if (submission.goal.length > 4_000)
        throw new Error("Project goal is too long");
    if (!Array.isArray(submission.dirs) || !submission.dirs.every((entry) => typeof entry === "string")) {
        throw new Error("Project directories must be a string array");
    }
    if (!Array.isArray(submission.tasks) || !submission.tasks.every((entry) => typeof entry === "string")) {
        throw new Error("Delegated task types must be a string array");
    }
    if (submission.dirs.length > 128)
        throw new Error("Too many project directories were selected");
    if (submission.tasks.length === 0)
        throw new Error("Choose at least one delegated task type");
    if (submission.tasks.length > 32)
        throw new Error("Too many delegated task types were selected");
    const root = await fs.realpath(await resolveWorkspaceRoot(cwd));
    const dirs = [];
    for (const raw of [...new Set(submission.dirs.map((entry) => entry.trim()).filter(Boolean))]) {
        if (path.isAbsolute(raw))
            throw new Error(`Project directory must be relative: ${raw}`);
        const normalized = path.normalize(raw);
        if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
            throw new Error(`Project directory is outside the workspace: ${raw}`);
        }
        let absolute;
        try {
            absolute = await fs.realpath(path.resolve(root, normalized));
        }
        catch {
            throw new Error(`Project directory does not exist: ${raw}`);
        }
        const relative = path.relative(root, absolute);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Project directory is outside the workspace: ${raw}`);
        }
        if (!(await fs.stat(absolute)).isDirectory())
            throw new Error(`Project scope is not a directory: ${raw}`);
        dirs.push(relative.split(path.sep).join("/"));
    }
    const tasks = [...new Set(submission.tasks.map((entry) => entry.trim()).filter(Boolean))];
    if (tasks.length === 0)
        throw new Error("Choose at least one delegated task type");
    if (tasks.some((entry) => entry.length > 80))
        throw new Error("Delegated task type is too long");
    return {
        goal: submission.goal,
        dirs,
        tasks,
        configuredAt: new Date().toISOString(),
    };
}
function assertNoBuiltInProviderOverride(current, candidate) {
    const currentCustom = new Set(current.configuration.customProviders.map((provider) => provider.id));
    const builtIn = new Set(current.providerCatalog.map((provider) => provider.id));
    for (const provider of candidate.customProviders) {
        if (builtIn.has(provider.id) && !currentCustom.has(provider.id)) {
            throw new Error(`Custom provider may not replace built-in provider: ${provider.id}`);
        }
    }
}
function normalizeCredential(credential) {
    if (!credential)
        return undefined;
    if (typeof credential.provider !== "string" || typeof credential.apiKey !== "string") {
        throw new Error("Credential must contain a provider and API key string");
    }
    const provider = credential.provider.trim();
    const apiKey = credential.apiKey.trim();
    if (!provider || !apiKey)
        return undefined;
    if (apiKey.length > 16_384)
        throw new Error("API key is too long");
    return { provider, apiKey };
}
function normalizeCredentials(submission) {
    const raw = [
        ...(submission.credentials ?? []),
        ...(submission.credential ? [submission.credential] : []),
    ];
    const normalized = raw
        .map((credential) => normalizeCredential(credential))
        .filter((credential) => Boolean(credential));
    const byProvider = new Map(normalized.map((credential) => [credential.provider, credential]));
    return [...byProvider.values()];
}
