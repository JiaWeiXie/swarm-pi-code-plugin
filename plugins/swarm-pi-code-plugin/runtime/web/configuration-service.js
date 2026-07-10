import fs from "node:fs/promises";
import path from "node:path";
import { createPiEnvironment } from "../pi/environment.js";
import { createModelCatalog, describeProviders, modelId } from "../pi/models.js";
import { loadModelConfiguration, modelPriority, parseModelConfiguration, saveModelConfiguration, } from "../state/model-config.js";
import { loadState, resolveWorkspaceRoot, saveProfile, setModelPriority, } from "../state/state.js";
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
    for (const credential of credentials) {
        pi.authStorage.removeRuntimeApiKey(credential.provider);
        pi.authStorage.set(credential.provider, { type: "api_key", key: credential.apiKey });
    }
    const saved = await saveModelConfiguration(cwd, candidate);
    await setModelPriority(cwd, modelPriority(saved));
    if (profile)
        await saveProfile(cwd, profile);
    return loadConfigurationView(cwd, env);
}
export async function saveProjectProfileSubmission(cwd, submission) {
    const profile = await normalizeProjectProfile(cwd, submission);
    const state = await saveProfile(cwd, profile);
    return state.config.profile;
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
