import { createPiEnvironment } from "../pi/environment.js";
import { createModelCatalog, describeModels, describeProviders, modelId } from "../pi/models.js";
import { loadModelConfiguration, modelPriority, parseModelConfiguration, saveModelConfiguration, } from "../state/model-config.js";
import { loadState, setModelPriority } from "../state/state.js";
export async function loadConfigurationView(cwd, env = process.env) {
    const state = await loadState(cwd);
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const catalog = createModelCatalog(configuration, env);
    const available = new Set(catalog.available().map(modelId));
    return {
        configuration,
        providers: describeProviders(catalog, configuration),
        models: describeModels(catalog.all?.() ?? catalog.available()).map((model) => ({
            ...model,
            available: available.has(model.id),
        })),
        registryError: catalog.error?.() ?? null,
    };
}
export async function saveConfigurationSubmission(cwd, submission, env = process.env) {
    const current = await loadConfigurationView(cwd, env);
    const candidate = parseModelConfiguration({
        version: 1,
        primary: submission.primary,
        fallbacks: submission.fallbacks,
        customProviders: submission.customProviders,
        updatedAt: null,
    });
    assertNoBuiltInProviderOverride(current, candidate);
    const pi = createPiEnvironment(candidate, env);
    const credential = normalizeCredential(submission.credential);
    if (credential)
        pi.authStorage.setRuntimeApiKey(credential.provider, credential.apiKey);
    const all = new Map(pi.modelRegistry.getAll().map((model) => [modelId(model), model]));
    const priority = modelPriority(candidate);
    const missing = priority.filter((reference) => !all.has(reference));
    if (missing.length > 0) {
        throw new Error(`Unknown model selection: ${missing.join(", ")}`);
    }
    if (credential && ![...all.values()].some((model) => model.provider === credential.provider)) {
        throw new Error(`Unknown credential provider: ${credential.provider}`);
    }
    const available = new Set(pi.modelRegistry.getAvailable().map(modelId));
    const unavailable = priority.filter((reference) => !available.has(reference));
    if (unavailable.length > 0) {
        throw new Error(`Selected models are not authenticated: ${unavailable.join(", ")}`);
    }
    if (credential) {
        pi.authStorage.removeRuntimeApiKey(credential.provider);
        pi.authStorage.set(credential.provider, { type: "api_key", key: credential.apiKey });
    }
    const saved = await saveModelConfiguration(cwd, candidate);
    await setModelPriority(cwd, modelPriority(saved));
    return loadConfigurationView(cwd, env);
}
function assertNoBuiltInProviderOverride(current, candidate) {
    const currentCustom = new Set(current.configuration.customProviders.map((provider) => provider.id));
    const builtIn = new Set(current.providers.filter((provider) => !provider.custom).map((provider) => provider.id));
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
