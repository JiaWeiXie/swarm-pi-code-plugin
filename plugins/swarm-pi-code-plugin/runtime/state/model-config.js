import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getProviderDefinition, } from "../providers/capabilities.js";
import { normalizeModelsEndpoint, normalizeProtocolRoot, runtimeApiForWireProtocol, wireProtocolForRuntimeApi, } from "../providers/endpoints.js";
import { resolveStateDir } from "./state.js";
export const SUPPORTED_PROVIDER_APIS = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];
export const CONTROLLED_LITERAL_HEADER_NAMES = [
    "anthropic-beta",
    "http-referer",
    "openai-organization",
    "openai-project",
    "x-title",
];
export const CONTROLLED_SECRET_HEADER_NAMES = ["api-key", "authorization", "x-api-key"];
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_TOKENS = 16_384;
export const MODEL_METADATA_SOURCES = [
    "endpoint",
    "pi-catalog",
    "models-dev",
    "compatibility-default",
    "user",
];
export function defaultModelConfiguration(priority = []) {
    return {
        version: 1,
        primary: priority[0] ?? null,
        fallbacks: unique(priority.slice(1)),
        customProviders: [],
        providerProfiles: [],
        updatedAt: null,
    };
}
export async function resolveModelConfigurationFile(cwd, env = process.env) {
    return path.join(await resolveStateDir(cwd, env), "model.json");
}
export async function loadModelConfiguration(cwd, legacyPriority = [], env = process.env) {
    const file = await resolveModelConfigurationFile(cwd, env);
    try {
        return parseModelConfiguration(JSON.parse(await fs.readFile(file, "utf8")));
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return defaultModelConfiguration(legacyPriority);
        }
        throw error;
    }
}
export async function saveModelConfiguration(cwd, value, env = process.env) {
    const normalized = parseModelConfiguration({
        ...value,
        version: 1,
        updatedAt: new Date().toISOString(),
    });
    const file = await resolveModelConfigurationFile(cwd, env);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
    return normalized;
}
export async function saveModelPriority(cwd, current, priority, env = process.env) {
    const normalizedPriority = unique(priority.map((entry) => modelReference(entry)));
    return saveModelConfiguration(cwd, {
        primary: normalizedPriority[0] ?? null,
        fallbacks: normalizedPriority.slice(1),
        customProviders: current.customProviders,
        providerProfiles: current.providerProfiles,
    }, env);
}
export async function clearModelConfiguration(cwd, env = process.env) {
    await fs.rm(await resolveModelConfigurationFile(cwd, env), { force: true });
}
export function modelPriority(configuration) {
    return configuration.primary ? unique([configuration.primary, ...configuration.fallbacks]) : [];
}
export function parseModelConfiguration(value) {
    const record = asRecord(value, "model configuration");
    if (record.version !== 1)
        throw new Error("model configuration version must be 1");
    const primary = record.primary === null ? null : modelReference(record.primary);
    const fallbacks = unique(stringArray(record.fallbacks, "fallbacks").map(modelReference));
    const filteredFallbacks = primary ? fallbacks.filter((entry) => entry !== primary) : [];
    const customProviders = arrayValue(record.customProviders, "customProviders").map(parseCustomProvider);
    const providerIds = customProviders.map((provider) => provider.id);
    if (new Set(providerIds).size !== providerIds.length) {
        throw new Error("custom provider identifiers must be unique");
    }
    const providerProfiles = optionalArrayValue(record.providerProfiles, "providerProfiles").map(parseProviderProfile);
    const profileIds = providerProfiles.map((profile) => profile.id);
    if (new Set(profileIds).size !== profileIds.length) {
        throw new Error("provider profile identifiers must be unique");
    }
    const profiledProviders = providerProfiles.map((profile) => profile.provider);
    if (new Set(profiledProviders).size !== profiledProviders.length) {
        throw new Error("each provider may have only one provider profile");
    }
    const customIds = new Set(providerIds);
    for (const profile of providerProfiles) {
        if (profile.connectionKind === "custom" && !customIds.has(profile.provider)) {
            throw new Error(`provider profile references an unknown custom provider: ${profile.provider}`);
        }
    }
    return {
        version: 1,
        primary,
        fallbacks: filteredFallbacks,
        customProviders,
        providerProfiles,
        updatedAt: record.updatedAt === null ? null : (optionalString(record.updatedAt, "updatedAt") ?? null),
    };
}
function parseCustomProvider(value) {
    const record = asRecord(value, "custom provider");
    for (const forbidden of ["apiKey", "oauth", "env", "command"]) {
        if (forbidden in record) {
            throw new Error(`custom provider configuration may not contain ${forbidden}`);
        }
    }
    const id = requiredString(record.id, "custom provider id");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
        throw new Error(`invalid custom provider id: ${id}`);
    }
    const parsedUrl = new URL(requiredString(record.baseUrl, `base URL for ${id}`));
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`custom provider ${id} must use an http or https URL`);
    }
    if (parsedUrl.username || parsedUrl.password) {
        throw new Error(`custom provider ${id} URL may not contain credentials`);
    }
    const api = requiredString(record.api, `API type for ${id}`);
    if (!SUPPORTED_PROVIDER_APIS.includes(api)) {
        throw new Error(`unsupported API type for ${id}: ${api}`);
    }
    const wireProtocol = record.wireProtocol === undefined
        ? wireProtocolForRuntimeApi(api)
        : parseWireProtocol(record.wireProtocol, `wireProtocol for ${id}`);
    if (wireProtocol && runtimeApiForWireProtocol(wireProtocol) !== api) {
        throw new Error(`wireProtocol for ${id} does not match API type ${api}`);
    }
    const baseUrl = wireProtocol
        ? normalizeProtocolRoot(parsedUrl.toString(), wireProtocol)
        : parsedUrl.toString().replace(/\/$/, "");
    const modelsEndpoint = optionalString(record.modelsEndpoint, `modelsEndpoint for ${id}`);
    const legacyRequiresApiKey = optionalBoolean(record.requiresApiKey, `requiresApiKey for ${id}`) ?? true;
    const auth = parseProviderAuth(record.auth, id, legacyRequiresApiKey
        ? { method: "api-key", secretRef: providerSecretRef(id) }
        : { method: "none" });
    if (auth.method === "oauth" || auth.method === "ambient") {
        throw new Error(`custom provider ${id} cannot use ${auth.method} authentication`);
    }
    const headers = optionalArrayValue(record.headers, `headers for ${id}`).map((header) => parseControlledHeader(header, id));
    const models = arrayValue(record.models, `models for ${id}`).map((model) => parseCustomModel(model, id));
    if (models.length === 0)
        throw new Error(`custom provider ${id} requires at least one model`);
    if (new Set(models.map((model) => model.id)).size !== models.length) {
        throw new Error(`custom provider ${id} model identifiers must be unique`);
    }
    return {
        id,
        name: optionalString(record.name, `name for ${id}`) ?? id,
        baseUrl,
        api: api,
        authHeader: optionalBoolean(record.authHeader, `authHeader for ${id}`) ?? false,
        requiresApiKey: auth.method !== "none",
        auth,
        ...(wireProtocol ? { wireProtocol } : {}),
        ...(modelsEndpoint ? { modelsEndpoint: normalizeModelsEndpoint(modelsEndpoint, baseUrl) } : {}),
        ...(headers.length ? { headers } : {}),
        models,
    };
}
function parseProviderProfile(value) {
    const record = asRecord(value, "provider profile");
    const id = providerIdentifier(record.id, "provider profile id");
    const provider = providerIdentifier(record.provider, `provider for ${id}`);
    const connectionKind = record.connectionKind;
    if (connectionKind !== "builtin" && connectionKind !== "custom") {
        throw new Error(`connectionKind for ${id} must be builtin or custom`);
    }
    const definition = getProviderDefinition(provider);
    if (connectionKind === "builtin" && !definition) {
        throw new Error(`unknown built-in provider profile: ${provider}`);
    }
    const auth = parseProviderAuth(record.auth, provider, {
        method: definition?.defaultAuthMethod ?? "api-key",
        secretRef: providerSecretRef(provider),
    });
    if (definition && !definition.authMethods.includes(auth.method)) {
        throw new Error(`provider ${provider} does not support ${auth.method} authentication`);
    }
    const protocol = record.protocol === undefined
        ? definition?.wireProtocol
        : parseWireProtocol(record.protocol, `protocol for ${id}`);
    const runtimeApi = requiredString(record.runtimeApi, `runtimeApi for ${id}`);
    if (runtimeApi !== "managed-per-model" && !isProviderRuntimeApi(runtimeApi)) {
        throw new Error(`unsupported runtime API for ${id}: ${runtimeApi}`);
    }
    if (definition &&
        !definition.runtimeApis.includes(runtimeApi) &&
        runtimeApi !== "managed-per-model") {
        throw new Error(`runtime API for ${id} is not supported by ${provider}`);
    }
    const readiness = record.readiness;
    if (readiness !== "configured" &&
        readiness !== "discovered" &&
        readiness !== "verified" &&
        readiness !== "blocked") {
        throw new Error(`invalid readiness for ${id}`);
    }
    const settings = stringRecord(record.settings, `settings for ${id}`);
    for (const key of Object.keys(settings)) {
        if (/(?:api.?key|secret|token|password|credential)/i.test(key)) {
            throw new Error(`provider profile settings may not contain secrets: ${key}`);
        }
        if (definition) {
            const field = definition.fields.find((candidate) => candidate.id === key);
            if (!field || field.secret)
                throw new Error(`unsupported setting for ${provider}: ${key}`);
            if (field.type === "select" &&
                !field.options?.some((option) => option.value === settings[key])) {
                throw new Error(`invalid option for ${provider}: ${key}`);
            }
            if (field.visibleWhen?.field === "authMethod" && field.visibleWhen.equals !== auth.method) {
                throw new Error(`setting ${key} is unavailable for ${provider} authentication method ${auth.method}`);
            }
            if (field.type === "url")
                settings[key] = safeProfileUrl(settings[key], provider, auth.method);
        }
    }
    const headers = optionalArrayValue(record.headers, `headers for ${id}`).map((header) => parseControlledHeader(header, provider));
    const modelsEndpoint = optionalString(record.modelsEndpoint, `modelsEndpoint for ${id}`);
    const discoveredAt = optionalIsoDate(record.discoveredAt, `discoveredAt for ${id}`);
    const verifiedAt = optionalIsoDate(record.verifiedAt, `verifiedAt for ${id}`);
    const verifiedModel = optionalString(record.verifiedModel, `verifiedModel for ${id}`);
    return {
        id,
        provider,
        name: optionalString(record.name, `name for ${id}`) ?? definition?.name ?? provider,
        connectionKind,
        auth,
        ...(protocol ? { protocol } : {}),
        runtimeApi: runtimeApi,
        readiness,
        settings,
        headers,
        ...(modelsEndpoint ? { modelsEndpoint } : {}),
        ...(discoveredAt ? { discoveredAt } : {}),
        ...(verifiedAt ? { verifiedAt } : {}),
        ...(verifiedModel ? { verifiedModel } : {}),
    };
}
function parseProviderAuth(value, provider, fallback) {
    if (value === undefined)
        return { ...fallback };
    const record = asRecord(value, `auth for ${provider}`);
    const method = requiredString(record.method, `auth method for ${provider}`);
    if (!["api-key", "oauth", "ambient", "none", "custom-header"].includes(method)) {
        throw new Error(`unsupported auth method for ${provider}: ${method}`);
    }
    const secretRef = optionalString(record.secretRef, `secretRef for ${provider}`);
    if (secretRef && !/^auth:[a-z0-9][a-z0-9._-]{0,63}(?::header:[a-z0-9-]+)?$/.test(secretRef)) {
        throw new Error(`invalid secretRef for ${provider}`);
    }
    const rawHeaderName = optionalString(record.headerName, `headerName for ${provider}`)?.toLowerCase();
    if (rawHeaderName &&
        !CONTROLLED_SECRET_HEADER_NAMES.includes(rawHeaderName)) {
        throw new Error(`unsupported secret header for ${provider}: ${rawHeaderName}`);
    }
    if (method === "custom-header" && !rawHeaderName) {
        throw new Error(`custom-header authentication for ${provider} requires headerName`);
    }
    return {
        method,
        ...(secretRef ? { secretRef } : {}),
        ...(rawHeaderName ? { headerName: rawHeaderName } : {}),
    };
}
function parseControlledHeader(value, provider) {
    const record = asRecord(value, `controlled header for ${provider}`);
    const name = requiredString(record.name, `header name for ${provider}`).toLowerCase();
    if (![...CONTROLLED_LITERAL_HEADER_NAMES, ...CONTROLLED_SECRET_HEADER_NAMES].includes(name)) {
        throw new Error(`unsupported controlled header for ${provider}: ${name}`);
    }
    const literal = optionalString(record.value, `header value for ${provider}`);
    const secretRef = optionalString(record.secretRef, `header secretRef for ${provider}`);
    if (Boolean(literal) === Boolean(secretRef)) {
        throw new Error(`controlled header for ${provider} requires exactly one value or secretRef`);
    }
    // oxlint-disable-next-line no-control-regex -- intentionally rejects ASCII control characters in header values
    if (literal && /[\u0000-\u001f\u007f]/.test(literal)) {
        throw new Error(`controlled header for ${provider} contains control characters`);
    }
    if (literal && name === "http-referer")
        safeProfileUrl(literal, provider, "none");
    const secret = CONTROLLED_SECRET_HEADER_NAMES.includes(name);
    if (secret && literal)
        throw new Error(`secret header ${name} for ${provider} must use secretRef`);
    if (!secret && secretRef)
        throw new Error(`literal header ${name} for ${provider} may not use secretRef`);
    if (secretRef && !/^auth:[a-z0-9][a-z0-9._-]{0,63}:header:[a-z0-9-]+$/.test(secretRef)) {
        throw new Error(`invalid header secretRef for ${provider}`);
    }
    return {
        name: name,
        ...(literal ? { value: literal } : {}),
        ...(secretRef ? { secretRef } : {}),
    };
}
function parseCustomModel(value, provider) {
    const record = asRecord(value, `model for ${provider}`);
    const id = requiredString(record.id, `model id for ${provider}`);
    // oxlint-disable-next-line no-control-regex -- intentionally rejects ASCII control characters in model id
    if (/[\u0000-\u001f\u007f]/.test(id)) {
        throw new Error(`invalid model id for ${provider}: ${id}`);
    }
    const input = record.input === undefined
        ? ["text"]
        : stringArray(record.input, `input for ${provider}/${id}`).map((entry) => {
            if (entry !== "text" && entry !== "image") {
                throw new Error(`invalid input type for ${provider}/${id}: ${entry}`);
            }
            return entry;
        });
    if (!input.includes("text"))
        input.unshift("text");
    const contextWindow = optionalInteger(record.contextWindow, `contextWindow for ${provider}/${id}`, 1024, 10_000_000);
    const maxTokens = optionalInteger(record.maxTokens, `maxTokens for ${provider}/${id}`, 1, contextWindow ?? 10_000_000);
    const metadata = parseModelMetadata(record.metadata, provider, id);
    return {
        id,
        name: optionalString(record.name, `name for ${provider}/${id}`) ?? id,
        reasoning: optionalBoolean(record.reasoning, `reasoning for ${provider}/${id}`) ?? false,
        input: unique(input),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(metadata === undefined ? {} : { metadata }),
    };
}
function parseModelMetadata(value, provider, model) {
    if (value === undefined)
        return undefined;
    const record = asRecord(value, `metadata for ${provider}/${model}`);
    const contextWindow = metadataSource(record.contextWindow, `contextWindow metadata for ${provider}/${model}`);
    const maxTokens = metadataSource(record.maxTokens, `maxTokens metadata for ${provider}/${model}`);
    if (!contextWindow && !maxTokens)
        return undefined;
    return {
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
    };
}
function metadataSource(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !MODEL_METADATA_SOURCES.includes(value)) {
        throw new Error(`${label} must be a supported metadata source`);
    }
    return value;
}
function modelReference(value) {
    const reference = requiredString(value, "model reference");
    const separator = reference.indexOf("/");
    if (separator < 1 || separator === reference.length - 1) {
        throw new Error(`model reference must use provider/model: ${reference}`);
    }
    if (/\s/.test(reference))
        throw new Error(`model reference may not contain whitespace: ${reference}`);
    return reference;
}
function asRecord(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }
    return value;
}
function arrayValue(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
    return value;
}
function optionalArrayValue(value, label) {
    return value === undefined ? [] : arrayValue(value, label);
}
function stringArray(value, label) {
    const array = arrayValue(value, label);
    if (!array.every((entry) => typeof entry === "string")) {
        throw new Error(`${label} must contain only strings`);
    }
    return array;
}
function requiredString(value, label) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${label} must be a non-empty string`);
    if (value.length > 2048)
        throw new Error(`${label} is too long`);
    return value.trim();
}
function providerIdentifier(value, label) {
    const id = requiredString(value, label);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))
        throw new Error(`invalid ${label}: ${id}`);
    return id;
}
function optionalString(value, label) {
    if (value === undefined)
        return undefined;
    return requiredString(value, label);
}
function optionalIsoDate(value, label) {
    const result = optionalString(value, label);
    if (result === undefined)
        return undefined;
    if (!Number.isFinite(Date.parse(result)))
        throw new Error(`${label} must be an ISO date`);
    return result;
}
function stringRecord(value, label) {
    if (value === undefined)
        return {};
    const record = asRecord(value, label);
    const result = {};
    for (const [key, raw] of Object.entries(record)) {
        if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key))
            throw new Error(`invalid key in ${label}: ${key}`);
        result[key] = requiredString(raw, `${label}.${key}`);
    }
    return result;
}
function parseWireProtocol(value, label) {
    const protocol = requiredString(value, label);
    if (protocol !== "openai-chat-completions" &&
        protocol !== "openai-responses" &&
        protocol !== "anthropic-messages") {
        throw new Error(`${label} must be a supported wire protocol`);
    }
    return protocol;
}
function isProviderRuntimeApi(value) {
    return [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
        "azure-openai-responses",
        "bedrock-converse-stream",
        "google-vertex",
        "mistral-conversations",
        "openai-codex-responses",
    ].includes(value);
}
function safeProfileUrl(value, provider, authMethod) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error(`URL setting for ${provider} must use HTTP or HTTPS`);
    if (url.username || url.password)
        throw new Error(`URL setting for ${provider} may not contain credentials`);
    if (authMethod !== "none" &&
        url.protocol === "http:" &&
        !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        throw new Error(`URL setting for ${provider} must use HTTPS with credentials`);
    }
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
export function providerSecretRef(provider) {
    return `auth:${provider}`;
}
export function providerHeaderSecretRef(provider, header) {
    return `auth:${provider}:header:${header.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}
function optionalBoolean(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw new Error(`${label} must be a boolean`);
    return value;
}
function optionalInteger(value, label, minimum, maximum) {
    if (value === undefined)
        return undefined;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}
function unique(values) {
    return [...new Set(values)];
}
