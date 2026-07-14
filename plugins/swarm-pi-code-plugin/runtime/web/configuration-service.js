import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ADAPTIVE_POLICY, DEFAULT_BACKGROUND_ROLE_POLICY, isThinkingLevel, isWorkerRole, normalizeAdaptivePolicy, normalizeAdaptivePolicyStrict, listDefaultRoles, defaultHostAssistancePolicy, defaultAdvisorPolicy, WORKFLOW_BOUNDS, } from "../orchestration/roles.js";
import { createPiEnvironment, customProviderHeaderVariable } from "../pi/environment.js";
import { executeSession } from "../pi/execute.js";
import { createWorkerSession } from "../pi/runtime.js";
import { createModelCatalog, describeProviders, modelId } from "../pi/models.js";
import { getProviderDefinition, listProviderDefinitions, unknownProviderIds, } from "../providers/capabilities.js";
import { CredentialDraftVault } from "../providers/credentials.js";
import { normalizeModelsEndpoint, normalizeProtocolRoot, stableCustomProviderId, } from "../providers/endpoints.js";
import { detectSandboxAvailability } from "../sandbox/availability.js";
import { assessWorkspace } from "../git/worktree.js";
import { normalizeDelegatedTaskSelections } from "../policy/project-policy.js";
import { loadModelConfiguration, modelPriority, parseModelConfiguration, saveModelConfiguration, resolveModelConfigurationFile, providerHeaderSecretRef, providerSecretRef, } from "../state/model-config.js";
import { loadState, resolveStateDir, resolveStateFile, resolveWorkspaceRoot, saveProjectSettings, saveExecutionSettings, setModelPriority, defaultHostActionPolicy, } from "../state/state.js";
import { discoverEndpoint, discoverLocalEndpoints, } from "./model-discovery.js";
export async function configureBuiltInProvider(cwd, request, credentialVault, env = process.env) {
    const definition = getProviderDefinition(request.provider);
    if (!definition || definition.id === "custom" || !definition.configurable) {
        throw new Error(`Unknown configurable provider: ${request.provider}`);
    }
    if (!definition.authMethods.includes(request.authMethod)) {
        throw new Error(`${definition.name} does not support ${request.authMethod} authentication`);
    }
    const persistentAuth = AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
    const { settings, secret } = normalizeProviderFields(definition, request.authMethod, request.fields);
    let credentialDraft;
    if (request.authMethod === "api-key" && secret) {
        credentialDraft = credentialVault.stageApiKey(definition.id, secret);
    }
    else if (request.credentialDraftId) {
        credentialDraft = credentialVault.summary(definition.id, request.credentialDraftId);
        if (credentialDraft.authMethod !== request.authMethod) {
            throw new Error("Credential draft does not match the selected authentication method");
        }
    }
    if ((request.authMethod === "api-key" || request.authMethod === "oauth") &&
        !credentialDraft &&
        !persistentAuth.hasAuth(definition.id)) {
        throw new Error(`${definition.name} requires a credential`);
    }
    const profile = providerProfile(definition, request.authMethod, settings, "configured");
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const candidate = parseModelConfiguration({
        ...configuration,
        providerProfiles: upsertProviderProfile(configuration.providerProfiles, profile),
    });
    const stagingAuth = AuthStorage.inMemory(persistentAuth.getAll());
    if (credentialDraft)
        stagingAuth.set(definition.id, credentialVault.resolve(definition.id, credentialDraft.id));
    const pi = createPiEnvironment(candidate, env, { authStorage: stagingAuth });
    const all = pi.modelRegistry.getAll();
    const providerModels = all.filter((model) => model.provider === definition.id);
    if (providerModels.length === 0)
        throw new Error(`Pi has no models for ${definition.name}`);
    const available = new Set(pi.modelRegistry.getAvailable().map(modelId));
    const models = providerModels.map((model) => browserModel(model, available.has(modelId(model)), candidate));
    const authStatus = pi.modelRegistry.getProviderAuthStatus(definition.id);
    return {
        provider: {
            id: definition.id,
            name: definition.name,
            ready: models.some((model) => model.available),
            modelCount: models.length,
            availableModelCount: models.filter((model) => model.available).length,
            auth: {
                source: credentialDraft ? "runtime" : (authStatus.source ?? request.authMethod),
                label: credentialDraft
                    ? request.authMethod === "oauth"
                        ? "Subscription sign-in pending save"
                        : "Credential pending save"
                    : (authStatus.label ?? authMethodLabel(request.authMethod)),
            },
            selection: null,
            custom: false,
        },
        models,
        profile,
        ...(credentialDraft ? { credentialDraft } : {}),
    };
}
export async function discoverConfigurationEndpoint(cwd, request, credentialVault, env = process.env) {
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const catalog = createModelCatalog(configuration, env);
    const all = catalog.all?.() ?? catalog.available();
    const root = normalizeProtocolRoot(request.baseUrl, request.protocol);
    const expectedProvider = stableCustomProviderId(root, request.protocol);
    const existingProvider = configuration.customProviders.find((provider) => provider.id === request.provider &&
        provider.wireProtocol === request.protocol &&
        normalizeProtocolRoot(provider.baseUrl, request.protocol) === root);
    if (request.provider !== expectedProvider && !existingProvider) {
        throw new Error("Custom provider identifier does not match its endpoint policy");
    }
    const authMethod = request.authMethod ?? "none";
    const credential = request.credentialDraftId
        ? credentialVault.resolve(request.provider, request.credentialDraftId)
        : AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE).get(request.provider);
    const apiKey = credentialSecret(credential, request.provider, authMethod, request.headerName);
    if (authMethod !== "none" && !apiKey)
        throw new Error("Credential draft is missing or expired");
    const result = await discoverEndpoint({
        ...request,
        ...(apiKey ? { apiKey } : {}),
    }, all, {
        reservedProviderIds: [
            ...all.map((model) => model.provider),
            ...(request.reservedProviderIds ?? []),
        ],
    });
    if (existingProvider && result.provider.id !== request.provider) {
        result.provider.id = request.provider;
        if (result.provider.auth && result.provider.auth.method !== "none") {
            result.provider.auth.secretRef = providerSecretRef(request.provider);
        }
        for (const header of result.provider.headers ?? []) {
            if (header.secretRef)
                header.secretRef = providerHeaderSecretRef(request.provider, header.name);
        }
    }
    const now = new Date().toISOString();
    const profile = {
        id: result.provider.id,
        provider: result.provider.id,
        name: result.provider.name,
        connectionKind: "custom",
        auth: result.provider.auth ?? { method: authMethod },
        protocol: request.protocol,
        runtimeApi: result.provider.api,
        readiness: "discovered",
        settings: {},
        headers: result.provider.headers ?? [],
        ...(result.provider.modelsEndpoint ? { modelsEndpoint: result.provider.modelsEndpoint } : {}),
        discoveredAt: now,
    };
    return { ...result, profile };
}
export async function stageCustomProviderCredential(cwd, credentialVault, request, env = process.env) {
    const root = normalizeProtocolRoot(request.baseUrl, request.protocol);
    let provider = stableCustomProviderId(root, request.protocol);
    if (request.existingProvider) {
        const state = await loadState(cwd, { env });
        const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
        const existing = configuration.customProviders.find((candidate) => candidate.id === request.existingProvider &&
            candidate.wireProtocol === request.protocol &&
            normalizeProtocolRoot(candidate.baseUrl, request.protocol) === root);
        if (!existing)
            throw new Error("Existing custom provider does not match this endpoint and protocol");
        provider = existing.id;
    }
    if (request.authMethod === "none")
        return { provider };
    if (!request.secret)
        throw new Error("Credential is required");
    const credentialDraft = request.authMethod === "custom-header"
        ? credentialVault.stageCustomHeader(provider, requireSecretHeader(request.headerName), request.secret)
        : credentialVault.stageApiKey(provider, request.secret);
    return { provider, credentialDraft };
}
async function assertExistingCustomProvider(cwd, providerId, root, protocol, env = process.env) {
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const existing = configuration.customProviders.find((candidate) => candidate.id === providerId &&
        candidate.wireProtocol === protocol &&
        normalizeProtocolRoot(candidate.baseUrl, protocol) === root);
    if (!existing)
        throw new Error("Existing custom provider does not match this endpoint and protocol");
    return existing;
}
export async function createManualCustomProvider(cwd, request, env = process.env) {
    const root = normalizeProtocolRoot(request.baseUrl, request.protocol);
    const provider = request.existingProvider
        ? (await assertExistingCustomProvider(cwd, request.existingProvider, root, request.protocol, env)).id
        : stableCustomProviderId(root, request.protocol);
    const modelsEndpoint = request.modelsEndpoint
        ? normalizeModelsEndpoint(request.modelsEndpoint, root)
        : undefined;
    const modelIds = [...new Set(request.modelIds.map((model) => model.trim()).filter(Boolean))];
    if (modelIds.length === 0 || modelIds.length > 500)
        throw new Error("Enter between 1 and 500 model identifiers");
    // oxlint-disable-next-line no-control-regex -- intentionally rejects ASCII control characters in model ids
    if (modelIds.some((model) => model.length > 512 || /[\u0000-\u001f\u007f]/.test(model))) {
        throw new Error("Manual model identifiers contain unsupported characters");
    }
    const auth = {
        method: request.authMethod,
        ...(request.authMethod === "none" ? {} : { secretRef: providerSecretRef(provider) }),
        ...(request.headerName ? { headerName: request.headerName } : {}),
    };
    const headers = request.authMethod === "custom-header"
        ? [
            {
                name: requireSecretHeader(request.headerName),
                secretRef: providerHeaderSecretRef(provider, requireSecretHeader(request.headerName)),
            },
        ]
        : [];
    const customProvider = {
        id: provider,
        name: request.name?.trim() || new URL(root).hostname,
        baseUrl: root,
        api: request.protocol === "openai-chat-completions"
            ? "openai-completions"
            : request.protocol === "openai-responses"
                ? "openai-responses"
                : "anthropic-messages",
        wireProtocol: request.protocol,
        authHeader: request.authMethod === "api-key" && request.protocol !== "anthropic-messages",
        requiresApiKey: request.authMethod !== "none",
        auth,
        ...(modelsEndpoint ? { modelsEndpoint } : {}),
        ...(headers.length ? { headers } : {}),
        models: modelIds.map((id) => ({ id, name: id, reasoning: false, input: ["text"] })),
    };
    const profile = {
        id: provider,
        provider,
        name: customProvider.name,
        connectionKind: "custom",
        auth,
        protocol: request.protocol,
        runtimeApi: customProvider.api,
        readiness: "configured",
        settings: {},
        headers,
        ...(modelsEndpoint ? { modelsEndpoint } : {}),
    };
    return { adapter: request.protocol, provider: customProvider, profile };
}
export async function verifyProviderConnection(cwd, request, credentialVault, env = process.env) {
    const state = await loadState(cwd, { env });
    const current = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const candidate = parseModelConfiguration({
        ...current,
        customProviders: request.customProviders,
        providerProfiles: request.providerProfiles,
    });
    assertProviderProfilePolicies(candidate);
    const drafts = normalizeCredentialDrafts(request.credentialDrafts, credentialVault);
    const persistentAuth = AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
    const stagingAuth = AuthStorage.inMemory(persistentAuth.getAll());
    for (const draft of drafts)
        stagingAuth.set(draft.provider, credentialVault.resolve(draft.provider, draft.draftId));
    const pi = createPiEnvironment(candidate, env, { authStorage: stagingAuth });
    const model = pi.modelRegistry.getAll().find((entry) => modelId(entry) === request.model);
    if (!model)
        throw new Error(`Unknown model selection: ${request.model}`);
    if (!pi.modelRegistry.getAvailable().some((entry) => modelId(entry) === request.model)) {
        throw new Error(`Model is not authenticated: ${request.model}`);
    }
    const { session } = await createWorkerSession({
        cwd,
        mode: "readonly",
        model,
        modelConfiguration: candidate,
        authStorage: pi.authStorage,
        modelRegistry: pi.modelRegistry,
        // Lowest reasoning effort accepted by both OpenAI and Azure responses models.
        // "minimal" is OpenAI-only; Azure gpt-5.x rejects it, and map-less custom
        // providers pass the level through verbatim, so use the safe intersection.
        thinkingLevel: "low",
    });
    const result = await executeSession({
        kind: "ask",
        model: request.model,
        prompt: "Reply with exactly READY.",
        session,
        timeoutMs: 15_000,
    });
    if (!result.success)
        throw new Error(`API verification failed: ${result.error ?? result.output}`);
    const provider = request.model.slice(0, request.model.indexOf("/"));
    const profile = candidate.providerProfiles.find((entry) => entry.provider === provider);
    if (!profile)
        throw new Error(`Provider profile is missing for ${provider}`);
    const verifiedAt = new Date().toISOString();
    return {
        profile: {
            ...profile,
            readiness: "verified",
            verifiedAt,
            verifiedModel: request.model,
        },
        verifiedAt,
        model: request.model,
    };
}
export async function signOutProvider(cwd, provider, env = process.env) {
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    if (!getProviderDefinition(provider) &&
        !configuration.customProviders.some((candidate) => candidate.id === provider)) {
        throw new Error(`Unknown provider: ${provider}`);
    }
    AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE).logout(provider);
}
export async function discoverLocalConfigurationEndpoints(cwd, env = process.env) {
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const catalog = createModelCatalog(configuration, env);
    const all = catalog.all?.() ?? catalog.available();
    return discoverLocalEndpoints(all, {
        reservedProviderIds: all.map((model) => model.provider),
    });
}
export async function loadConfigurationView(cwd, env = process.env) {
    const state = await loadState(cwd, { env });
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority, env);
    const catalog = createModelCatalog(configuration, env);
    const all = catalog.all?.() ?? catalog.available();
    const availableModels = catalog.available();
    const available = new Set(availableModels.map(modelId));
    const rolePolicies = structuredClone(state.config.rolePolicies ?? {});
    const adaptivePolicy = normalizeAdaptivePolicy(state.config.adaptivePolicy);
    const backgroundRolePolicy = structuredClone(state.config.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY);
    const storedHostAssistance = structuredClone(state.config.hostAssistance ?? defaultHostAssistancePolicy());
    const hostAssistance = {
        ...storedHostAssistance,
        mode: storedHostAssistance.enabled === false ? "off" : "on",
        enabled: storedHostAssistance.enabled !== false,
    };
    const selected = new Set([
        ...modelPriority(configuration),
        ...Object.values(rolePolicies).flatMap((policy) => policy.models ?? []),
        ...adaptivePolicy.classifierModels,
    ]);
    const custom = new Set(configuration.customProviders.map((provider) => provider.id));
    const relevant = all.filter((model) => available.has(modelId(model)) || selected.has(modelId(model)) || custom.has(model.provider));
    const providerIds = [...new Set(all.map((model) => model.provider))];
    const unknownProviders = unknownProviderIds(providerIds.filter((id) => !custom.has(id)));
    const registryProblems = [
        catalog.error?.(),
        unknownProviders.length
            ? `Pinned Pi exposes providers missing from ProviderCapabilityRegistry: ${unknownProviders.join(", ")}`
            : undefined,
    ].filter((entry) => Boolean(entry));
    return {
        configuration,
        profile: state.config.profile ?? null,
        directoryOptions: await projectDirectoryOptions(cwd, state.config.profile?.dirs ?? []),
        providers: describeProviders(catalog, configuration),
        providerCatalog: listProviderDefinitions().map((definition) => {
            const status = definition.id === "custom"
                ? { configured: false }
                : (catalog.authStatus?.(definition.id) ?? { configured: false });
            return {
                ...definition,
                auth: {
                    configured: status.configured,
                    source: status.source ?? null,
                    label: status.label ?? null,
                },
            };
        }),
        models: relevant.map((model) => browserModel(model, available.has(modelId(model)), configuration)),
        registryError: registryProblems.length ? registryProblems.join("\n") : null,
        sandboxMode: state.config.sandboxMode ?? "strict",
        sandboxAvailability: detectSandboxAvailability(),
        rolePolicies,
        adaptivePolicy,
        backgroundRolePolicy,
        roles: listDefaultRoles(),
        workspace: await assessWorkspace(cwd),
        workspaceId: createHash("sha256")
            .update(await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd)))
            .digest("hex")
            .slice(0, 24),
        configurationRevision: createHash("sha256")
            .update(JSON.stringify({
            primary: configuration.primary,
            fallbacks: configuration.fallbacks,
            profile: state.config.profile ?? null,
            sandboxMode: state.config.sandboxMode ?? "strict",
            rolePolicies,
            adaptivePolicy,
            backgroundRolePolicy,
            decisionMode: state.config.decisionMode ?? "balance",
            hostAssistance,
            contextBudget: state.config.contextBudget ?? WORKFLOW_BOUNDS.contextBudget.default,
            advisor: state.config.advisor ?? defaultAdvisorPolicy(),
            doctrine: state.config.doctrine ?? null,
            hostActions: state.config.hostActions ?? defaultHostActionPolicy(),
        }))
            .digest("hex")
            .slice(0, 24),
        decisionMode: state.config.decisionMode ?? "balance",
        hostAssistance,
        contextBudget: state.config.contextBudget ?? WORKFLOW_BOUNDS.contextBudget.default,
        advisor: structuredClone(state.config.advisor ?? defaultAdvisorPolicy()),
        doctrine: state.config.doctrine ?? null,
        hostActions: structuredClone(state.config.hostActions ?? defaultHostActionPolicy()),
        workflowBounds: structuredClone(WORKFLOW_BOUNDS),
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
        contextWindow: isCustomModel
            ? (configured.contextWindow ?? null)
            : (model.contextWindow ?? null),
        maxTokens: isCustomModel ? (configured.maxTokens ?? null) : (model.maxTokens ?? null),
        metadata: {
            contextWindow: isCustomModel
                ? (configured.metadata?.contextWindow ?? null)
                : model.contextWindow
                    ? "pi-catalog"
                    : null,
            maxTokens: isCustomModel
                ? (configured.metadata?.maxTokens ?? null)
                : model.maxTokens
                    ? "pi-catalog"
                    : null,
        },
    };
}
export async function saveConfigurationSubmission(cwd, submission, env = process.env, options = {}) {
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
        providerProfiles: submission.providerProfiles ?? current.configuration.providerProfiles,
        updatedAt: null,
    });
    assertNoBuiltInProviderOverride(current, candidate);
    assertProviderProfilePolicies(candidate);
    const persistentAuth = AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
    const credentialDrafts = normalizeCredentialDrafts(submission.credentialDrafts, options.credentialVault);
    const credentials = credentialDrafts.map((draft) => ({
        provider: draft.provider,
        draftId: draft.draftId,
        credential: options.credentialVault.resolve(draft.provider, draft.draftId),
    }));
    const stagingAuth = AuthStorage.inMemory(persistentAuth.getAll());
    for (const credential of credentials)
        stagingAuth.set(credential.provider, credential.credential);
    const pi = createPiEnvironment(candidate, env, { authStorage: stagingAuth });
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
    applyAdaptiveClassifierDefault(execution, sandboxMode, candidate.primary);
    assertExecutionModels(execution, all, available, sandboxMode, Boolean(candidate.primary));
    if (env.SWARM_PI_CODE_PLUGIN_SKIP_SMOKE_TEST !== "1") {
        const smokeModels = [
            ...new Set([
                ...(candidate.primary ? [candidate.primary] : []),
                ...(sandboxMode === "adaptive" ? execution.adaptivePolicy.classifierModels : []),
            ]),
        ];
        for (const reference of smokeModels) {
            const model = all.get(reference);
            const { session } = await createWorkerSession({
                cwd,
                mode: "readonly",
                model,
                modelConfiguration: candidate,
                authStorage: pi.authStorage,
                modelRegistry: pi.modelRegistry,
                // See verifyProviderConnection: "low" is the OpenAI/Azure-safe floor.
                thinkingLevel: "low",
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
            const provider = reference.slice(0, reference.indexOf("/"));
            const profile = candidate.providerProfiles.find((entry) => entry.provider === provider);
            if (profile) {
                profile.readiness = "verified";
                profile.verifiedAt = new Date().toISOString();
                profile.verifiedModel = reference;
            }
        }
    }
    for (const credential of credentials) {
        const refreshed = stagingAuth.get(credential.provider);
        if (refreshed)
            credential.credential = refreshed;
    }
    const modelFile = await resolveModelConfigurationFile(cwd, env);
    const stateFile = await resolveStateFile(cwd, env);
    const fileSnapshots = await Promise.all([snapshotFile(modelFile), snapshotFile(stateFile)]);
    const credentialSnapshots = credentials.map((credential) => ({
        provider: credential.provider,
        value: persistentAuth.get(credential.provider),
    }));
    try {
        for (const credential of credentials) {
            persistentAuth.set(credential.provider, credential.credential);
        }
        const saved = await saveModelConfiguration(cwd, candidate, env);
        await setModelPriority(cwd, modelPriority(saved), env);
        if (profile)
            await saveProjectSettings(cwd, profile, sandboxMode, execution, env);
        else
            await saveExecutionSettings(cwd, sandboxMode, execution, env);
    }
    catch (error) {
        const rollbackErrors = [];
        for (const snapshot of credentialSnapshots) {
            try {
                if (snapshot.value)
                    persistentAuth.set(snapshot.provider, snapshot.value);
                else
                    persistentAuth.remove(snapshot.provider);
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
            await writeRecoveryJournal(cwd, rollbackErrors, env);
            throw new Error("Configuration failed and could not be fully rolled back; run doctor (configuration-recovery-required)");
        }
        throw error;
    }
    for (const credential of credentials)
        options.credentialVault?.remove(credential.draftId);
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
async function writeRecoveryJournal(cwd, errors, env = process.env) {
    const directory = path.join(await resolveStateDir(cwd, env), "recovery");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, "configuration.json"), `${JSON.stringify({
        code: "configuration-recovery-required",
        createdAt: new Date().toISOString(),
        errors: errors.map((error) => error.replace(/(?:sk-|key=)[^\s:]+/gi, "[redacted]")),
    }, null, 2)}\n`, { mode: 0o600 });
}
export async function saveProjectProfileSubmission(cwd, submission, env = process.env) {
    const current = await loadState(cwd, { env });
    const settings = "profile" in submission ? submission : { profile: submission };
    const profile = await normalizeProjectProfile(cwd, settings.profile);
    const sandboxMode = normalizeSandboxMode(settings.sandboxMode, current.config.sandboxMode ?? "strict");
    const execution = normalizeExecutionSettings(settings, {
        rolePolicies: current.config.rolePolicies ?? {},
        adaptivePolicy: normalizeAdaptivePolicy(current.config.adaptivePolicy),
        backgroundRolePolicy: current.config.backgroundRolePolicy ?? DEFAULT_BACKGROUND_ROLE_POLICY,
        decisionMode: current.config.decisionMode ?? "balance",
        hostAssistance: current.config.hostAssistance ?? defaultHostAssistancePolicy(),
        contextBudget: current.config.contextBudget ?? 4,
        advisor: current.config.advisor ?? defaultAdvisorPolicy(),
        doctrine: current.config.doctrine ?? null,
        hostActions: current.config.hostActions ?? defaultHostActionPolicy(),
    });
    assertSandboxModeAvailable(sandboxMode);
    const modelConfiguration = await loadModelConfiguration(cwd, current.config.modelPriority, env);
    const catalog = createModelCatalog(modelConfiguration, env);
    const all = new Map((catalog.all?.() ?? catalog.available()).map((model) => [modelId(model), model]));
    const available = new Set(catalog.available().map(modelId));
    applyAdaptiveClassifierDefault(execution, sandboxMode, modelConfiguration.primary);
    assertExecutionModels(execution, all, available, sandboxMode, Boolean(modelConfiguration.primary));
    const state = await saveProjectSettings(cwd, profile, sandboxMode, execution, env);
    return state.config.profile;
}
function normalizeSandboxMode(value, fallback) {
    if (value === undefined)
        return fallback;
    if (value === "strict" || value === "adaptive" || value === "lenient")
        return value;
    throw new Error("Sandbox mode must be strict, adaptive, or lenient");
}
function normalizeDecisionMode(value, fallback) {
    if (value === undefined)
        return fallback;
    if (value === "cost" || value === "balance" || value === "power")
        return value;
    throw new Error("Decision mode must be cost, balance, or power");
}
function normalizeBoundedInteger(value, fallback, min, max, label) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer from ${min} to ${max}`);
    }
    return value;
}
function normalizeHostAssistance(value, fallback) {
    if (value === undefined)
        return structuredClone(fallback);
    if (value.maxRequests === undefined || value.maxFanOut === undefined)
        throw new Error("Host Assistance requests and fan-out are required when the section is submitted");
    const reviewMode = value.reviewMode ?? fallback.reviewMode ?? "user-only";
    const autoApprovalScope = value.autoApprovalScope ?? fallback.autoApprovalScope ?? "context-only";
    const autoApproveDiscoveryGates = value.autoApproveDiscoveryGates ?? fallback.autoApproveDiscoveryGates ?? false;
    const allowedContextClasses = ["workspace", "web", "docs", "paper", "connector", "skill"];
    if (!Array.isArray(value.contextClasses) ||
        value.contextClasses.some((item) => !allowedContextClasses.includes(item)))
        throw new Error("Host Assistance context classes contain an unsupported value");
    const contextClasses = [...new Set(value.contextClasses)];
    if (value.mode === "inherit")
        throw new Error("Project configuration cannot inherit Host Assistance; choose On or Off. CLI job overrides may still use inherit.");
    if (value.mode !== "on" && value.mode !== "off")
        throw new Error("Invalid Host Assistance mode");
    if (value.privateConnector !== "ask" && value.privateConnector !== "deny")
        throw new Error("Invalid private connector policy");
    if (reviewMode !== "user-only" && reviewMode !== "host-first")
        throw new Error("Invalid Host Assistance review mode");
    if (autoApprovalScope !== "context-only" &&
        autoApprovalScope !== "read-only" &&
        autoApprovalScope !== "reversible")
        throw new Error("Invalid Host Assistance auto-approval scope");
    const maxRequests = normalizeBoundedInteger(value.maxRequests, fallback.maxRequests, WORKFLOW_BOUNDS.hostAssistance.requests.min, WORKFLOW_BOUNDS.hostAssistance.requests.max, "Host Assistance request limit");
    const maxFanOut = normalizeBoundedInteger(value.maxFanOut, fallback.maxFanOut, WORKFLOW_BOUNDS.hostAssistance.fanOut.min, WORKFLOW_BOUNDS.hostAssistance.fanOut.max, "Host Assistance fan-out");
    if (maxFanOut > maxRequests)
        throw new Error("Host Assistance fan-out cannot exceed its request limit");
    return {
        enabled: value.mode === "off" ? false : value.enabled !== false,
        mode: value.mode,
        contextClasses,
        privateConnector: value.privateConnector,
        maxRequests,
        maxFanOut,
        reviewMode,
        autoApprovalScope,
        autoApproveDiscoveryGates,
    };
}
function normalizeAdvisor(value, fallback) {
    if (value === undefined)
        return structuredClone(fallback);
    if (value.maxRequests === undefined || value.maxPerspectives === undefined)
        throw new Error("Advisor consultations and perspectives are required when the section is submitted");
    const allowedTargets = [
        "ask",
        "review",
        "plan",
        "implement",
        "orchestrate",
        "scaffold",
        "setup",
        "discover",
    ];
    if (!Array.isArray(value.targets) || value.targets.some((item) => !allowedTargets.includes(item)))
        throw new Error("Advisor targets contain an unsupported task kind");
    const targets = [...new Set(value.targets)];
    const maxRequests = normalizeBoundedInteger(value.maxRequests, fallback.maxRequests, WORKFLOW_BOUNDS.advisor.requests.min, WORKFLOW_BOUNDS.advisor.requests.max, "Advisor request limit");
    const maxPerspectives = normalizeBoundedInteger(value.maxPerspectives, fallback.maxPerspectives, WORKFLOW_BOUNDS.advisor.perspectives.min, WORKFLOW_BOUNDS.advisor.perspectives.max, "Advisor perspective limit");
    if (value.enabled === true &&
        (targets.length === 0 || maxRequests === 0 || maxPerspectives === 0))
        throw new Error("Enabled Advisor requires a target, at least one consultation, and one perspective");
    return {
        enabled: value.enabled === true,
        targets,
        maxRequests,
        maxPerspectives,
    };
}
function normalizeHostActions(value, fallback) {
    if (value === undefined)
        return structuredClone(fallback);
    if (value.maxUses === undefined || value.maxCost === undefined || value.ttlMs === undefined)
        throw new Error("Host Action uses, cost metadata, and lease TTL are required when submitted");
    const actionClasses = [
        "local-mutation",
        "draft",
        "remote-write",
        "message",
        "deploy",
        "transaction",
    ];
    if (!Array.isArray(value.allowedActionClasses) ||
        value.allowedActionClasses.some((item) => !actionClasses.includes(item)))
        throw new Error("Host Action classes contain an unsupported value");
    const allowedActionClasses = [...new Set(value.allowedActionClasses)];
    if (value.remoteActionsEnabled === true &&
        !allowedActionClasses.some((item) => ["remote-write", "message", "deploy", "transaction"].includes(item)))
        throw new Error("Remote Host Actions require at least one remote action class");
    return {
        enabled: value.enabled === true,
        allowedActionClasses,
        remoteActionsEnabled: value.remoteActionsEnabled === true,
        maxUses: normalizeBoundedInteger(value.maxUses, fallback.maxUses, 1, 100, "Host Action use limit"),
        maxCost: typeof value.maxCost === "number" && Number.isFinite(value.maxCost) && value.maxCost >= 0
            ? value.maxCost
            : (() => {
                throw new Error("Host Action recommendation cost metadata must be non-negative");
            })(),
        ttlMs: normalizeBoundedInteger(value.ttlMs, fallback.ttlMs, 60_000, 86_400_000, "Host Action TTL"),
    };
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
        if (policy.maxAttempts !== undefined &&
            (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 2)) {
            throw new Error(`Role ${role} max attempts must be 1 or 2`);
        }
        rolePolicies[role] = {
            ...(Array.isArray(policy.models) ? { models: [...new Set(policy.models)] } : {}),
            ...(policy.thinkingLevel ? { thinkingLevel: policy.thinkingLevel } : {}),
            ...(policy.maxAttempts ? { maxAttempts: policy.maxAttempts } : {}),
        };
    }
    const adaptivePolicy = normalizeAdaptivePolicyStrict(value.adaptivePolicy ?? fallback.adaptivePolicy ?? DEFAULT_ADAPTIVE_POLICY);
    validateTrustedDomains(adaptivePolicy);
    return {
        rolePolicies,
        adaptivePolicy,
        backgroundRolePolicy: {
            mechanicalExecutor: (value.backgroundRolePolicy ??
                fallback.backgroundRolePolicy ??
                DEFAULT_BACKGROUND_ROLE_POLICY).mechanicalExecutor === true,
        },
        decisionMode: normalizeDecisionMode(value.decisionMode, fallback.decisionMode),
        hostAssistance: normalizeHostAssistance(value.hostAssistance, fallback.hostAssistance),
        contextBudget: normalizeBoundedInteger(value.contextBudget, fallback.contextBudget, WORKFLOW_BOUNDS.contextBudget.min, WORKFLOW_BOUNDS.contextBudget.max, "Context budget"),
        advisor: normalizeAdvisor(value.advisor, fallback.advisor),
        doctrine: value.doctrine === undefined
            ? fallback.doctrine
            : value.doctrine === null || value.doctrine === "first-principles-qds-v1"
                ? value.doctrine
                : (() => {
                    throw new Error("Unknown decision doctrine");
                })(),
        hostActions: normalizeHostActions(value.hostActions, fallback.hostActions),
    };
}
function validateTrustedDomains(policy) {
    for (const domain of policy.trustedDomains) {
        if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ||
            domain === "localhost" ||
            /^\d+(?:\.\d+){3}$/.test(domain)) {
            throw new Error(`Invalid trusted domain: ${domain}`);
        }
    }
}
function assertExecutionModels(execution, all, available, sandboxMode, requireAdaptiveClassifier = true) {
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
    if (requireAdaptiveClassifier &&
        sandboxMode === "adaptive" &&
        execution.adaptivePolicy.classifierModels.length === 0) {
        throw new Error("Adaptive mode requires at least one classifier model");
    }
}
function applyAdaptiveClassifierDefault(execution, sandboxMode, primary) {
    if (sandboxMode === "adaptive" &&
        execution.adaptivePolicy.classifierModels.length === 0 &&
        primary) {
        execution.adaptivePolicy.classifierModels = [primary];
    }
}
function normalizeProviderFields(definition, authMethod, value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Provider fields must be an object");
    }
    const known = new Set(definition.fields.map((field) => field.id));
    for (const key of Object.keys(value)) {
        if (!known.has(key))
            throw new Error(`Unknown field for ${definition.name}: ${key}`);
    }
    const settings = {};
    let secret;
    for (const field of definition.fields) {
        const visible = (!field.visibleWhen ||
            field.visibleWhen.field !== "authMethod" ||
            field.visibleWhen.equals === authMethod) &&
            (!field.secret || authMethod === "api-key");
        const raw = value[field.id];
        if (raw !== undefined && typeof raw !== "string")
            throw new Error(`${field.label} must be text`);
        const normalized = raw?.trim() ?? "";
        if (field.type === "select" &&
            normalized &&
            !field.options?.some((option) => option.value === normalized)) {
            throw new Error(`${field.label} has an invalid option`);
        }
        if (!visible) {
            if (field.type === "select" && normalized)
                throw new Error(`${field.label} is unavailable for ${authMethod}`);
            continue;
        }
        if (normalized.length > 16_384)
            throw new Error(`${field.label} is too long`);
        if (field.required && !field.secret && !normalized)
            throw new Error(`${field.label} is required`);
        if (!normalized)
            continue;
        if (field.secret)
            secret = normalized;
        else if (field.type === "url")
            settings[field.id] = normalizeProviderUrl(normalized, field.label, authMethod);
        else {
            settings[field.id] = normalized;
        }
    }
    if (definition.id === "azure-openai-responses" && !settings.baseUrl && !settings.resourceName) {
        throw new Error("Azure OpenAI requires an endpoint or resource name");
    }
    if (settings.deploymentNameMap &&
        !settings.deploymentNameMap
            .split(",")
            .every((entry) => /^[^=,\s]+=[^=,\s]+$/.test(entry.trim()))) {
        throw new Error("Azure deployment mapping must use model=deployment entries separated by commas");
    }
    return { settings, ...(secret ? { secret } : {}) };
}
function normalizeProviderUrl(value, label, authMethod) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`${label} must be a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(`${label} must use HTTP or HTTPS`);
    if (url.username || url.password)
        throw new Error(`${label} may not contain credentials`);
    if (authMethod !== "none" &&
        url.protocol === "http:" &&
        !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        throw new Error(`${label} must use HTTPS when credentials are configured`);
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
function providerProfile(definition, authMethod, settings, readiness) {
    const runtimeApi = definition.protocolMode === "managed-per-model"
        ? "managed-per-model"
        : definition.runtimeApis[0];
    if (!runtimeApi)
        throw new Error(`Provider has no runtime API: ${definition.id}`);
    return {
        id: definition.id,
        provider: definition.id,
        name: definition.name,
        connectionKind: "builtin",
        auth: {
            method: authMethod,
            ...(authMethod === "api-key" || authMethod === "oauth"
                ? { secretRef: providerSecretRef(definition.id) }
                : {}),
        },
        ...(definition.wireProtocol ? { protocol: definition.wireProtocol } : {}),
        runtimeApi,
        readiness,
        settings,
        headers: [],
    };
}
function upsertProviderProfile(profiles, profile) {
    return [...profiles.filter((candidate) => candidate.id !== profile.id), profile];
}
function authMethodLabel(method) {
    switch (method) {
        case "api-key":
            return "Stored API key";
        case "oauth":
            return "Subscription OAuth";
        case "ambient":
            return "Ambient cloud identity";
        case "none":
            return "No credential";
        case "custom-header":
            return "API key plus custom secret header";
    }
}
function credentialSecret(credential, provider, authMethod, headerName) {
    if (!credential || credential.type !== "api_key")
        return undefined;
    if (authMethod !== "custom-header")
        return credential.key;
    if (!headerName)
        return undefined;
    return credential.env?.[customProviderHeaderVariable(provider, headerName)];
}
function requireSecretHeader(value) {
    if (value !== "authorization" && value !== "x-api-key" && value !== "api-key") {
        throw new Error("Choose a supported secret header");
    }
    return value;
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
    if (submission.dirs !== undefined &&
        (!Array.isArray(submission.dirs) ||
            !submission.dirs.every((entry) => typeof entry === "string"))) {
        throw new Error("Project directories must be a string array");
    }
    if (!Array.isArray(submission.tasks) ||
        !submission.tasks.every((entry) => typeof entry === "string")) {
        throw new Error("Delegated task types must be a string array");
    }
    if ((submission.dirs?.length ?? 0) > 128)
        throw new Error("Too many project directories were selected");
    if (submission.tasks.length === 0)
        throw new Error("Choose at least one delegated task type");
    if (submission.tasks.length > 32)
        throw new Error("Too many delegated task types were selected");
    const root = await fs.realpath(await resolveWorkspaceRoot(cwd));
    const dirs = [];
    for (const raw of new Set((submission.dirs ?? []).map((entry) => entry.trim()).filter(Boolean))) {
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
    const tasks = normalizeDelegatedTaskSelections(submission.tasks.map((entry) => entry.trim()).filter(Boolean));
    if (tasks.length === 0)
        throw new Error("Choose at least one delegated task type");
    if (tasks.some((entry) => entry.length > 80))
        throw new Error("Delegated task type is too long");
    return {
        goal: submission.goal,
        ...(submission.dirs === undefined ? {} : { dirs }),
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
function assertProviderProfilePolicies(configuration) {
    for (const profile of configuration.providerProfiles) {
        if (profile.connectionKind === "builtin") {
            const definition = getProviderDefinition(profile.provider);
            if (!definition || definition.id === "custom")
                throw new Error(`Unknown built-in provider profile: ${profile.provider}`);
            profile.settings = normalizeProviderFields(definition, profile.auth.method, profile.settings).settings;
            continue;
        }
        const provider = configuration.customProviders.find((candidate) => candidate.id === profile.provider);
        if (!provider)
            throw new Error(`Missing custom provider for profile: ${profile.provider}`);
        if (profile.protocol !== provider.wireProtocol || profile.runtimeApi !== provider.api) {
            throw new Error(`Custom provider profile does not match runtime adapter: ${profile.provider}`);
        }
        if (profile.auth.method !== provider.auth?.method) {
            throw new Error(`Custom provider profile does not match authentication policy: ${profile.provider}`);
        }
    }
}
function normalizeCredentialDrafts(value, vault) {
    if (value === undefined)
        return [];
    if (!vault)
        throw new Error("Credential drafts are unavailable for this configuration session");
    if (!Array.isArray(value) || value.length > 64)
        throw new Error("Credential drafts must be an array");
    const byProvider = new Map();
    for (const entry of value) {
        if (!entry || typeof entry.provider !== "string" || typeof entry.draftId !== "string") {
            throw new Error("Credential draft references require provider and draftId strings");
        }
        const provider = entry.provider.trim();
        const draftId = entry.draftId.trim();
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) || !/^[0-9a-f-]{36}$/.test(draftId)) {
            throw new Error("Credential draft reference is invalid");
        }
        vault.summary(provider, draftId);
        byProvider.set(provider, { provider, draftId });
    }
    return [...byProvider.values()];
}
