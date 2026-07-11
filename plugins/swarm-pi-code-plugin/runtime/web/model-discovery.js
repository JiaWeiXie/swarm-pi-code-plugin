import { normalizeModelsEndpoint, normalizeProtocolRoot, protocolModelsUrl, runtimeApiForWireProtocol, stableCustomProviderId, } from "../providers/endpoints.js";
import { providerHeaderSecretRef, providerSecretRef } from "../state/model-config.js";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 500;
const MAX_OLLAMA_DETAIL_REQUESTS = 32;
export class EndpointDiscoveryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export async function discoverEndpoint(request, catalogModels = [], options = {}) {
    let normalizedRoot;
    try {
        normalizedRoot = normalizeProtocolRoot(request.baseUrl, request.protocol);
    }
    catch (error) {
        throw new EndpointDiscoveryError("invalid-url", error instanceof Error ? error.message : "Enter a valid API root");
    }
    const base = safeEndpointUrl(normalizedRoot);
    const authMethod = request.authMethod ?? (request.apiKey?.trim() ? "api-key" : "none");
    if (authMethod === "custom-header" && !request.headerName) {
        throw new EndpointDiscoveryError("authentication", "Choose the custom authentication header");
    }
    if (authMethod !== "none" && !request.apiKey?.trim()) {
        throw new EndpointDiscoveryError("authentication", "Enter the credential before loading models");
    }
    if (authMethod !== "none" && base.protocol === "http:" && !isLoopback(base.hostname)) {
        throw new EndpointDiscoveryError("invalid-url", "Credentials may only be sent over HTTPS or to a loopback endpoint");
    }
    let modelsUrl;
    try {
        modelsUrl = request.modelsEndpoint
            ? new URL(normalizeModelsEndpoint(request.modelsEndpoint, normalizedRoot))
            : protocolModelsUrl(normalizedRoot, request.protocol);
    }
    catch (error) {
        throw new EndpointDiscoveryError("invalid-url", error instanceof Error ? error.message : "Enter a valid models endpoint");
    }
    const context = {
        base,
        modelsUrl,
        ...(request.apiKey?.trim() ? { apiKey: request.apiKey.trim() } : {}),
        authMethod,
        ...(request.headerName ? { headerName: request.headerName } : {}),
        fetchImpl: options.fetchImpl ?? fetch,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    };
    const result = await (request.protocol === "anthropic-messages" ? probeAnthropic(context) : probeOpenAi(context));
    const id = stableCustomProviderId(normalizedRoot, request.protocol);
    const secretHeader = authMethod === "custom-header" && request.headerName
        ? [{ name: request.headerName, secretRef: providerHeaderSecretRef(id, request.headerName) }]
        : [];
    return {
        adapter: request.protocol,
        provider: {
            id,
            name: result.name,
            baseUrl: normalizedRoot,
            api: runtimeApiForWireProtocol(request.protocol),
            wireProtocol: request.protocol,
            authHeader: authMethod === "api-key" && request.protocol !== "anthropic-messages",
            requiresApiKey: authMethod !== "none",
            auth: {
                method: authMethod,
                ...(authMethod === "none" ? {} : { secretRef: providerSecretRef(id) }),
                ...(request.headerName ? { headerName: request.headerName } : {}),
            },
            ...(request.modelsEndpoint ? { modelsEndpoint: modelsUrl.toString() } : {}),
            ...(secretHeader.length ? { headers: secretHeader } : {}),
            models: enrichModels(result.models, catalogModels, result.preferredProvider),
        },
    };
}
export async function discoverLocalEndpoints(catalogModels = [], options = {}) {
    const candidates = [
        "http://127.0.0.1:11434",
        "http://127.0.0.1:1234",
        "http://127.0.0.1:1337",
    ];
    const results = await Promise.allSettled(candidates.map((baseUrl) => discoverLocalEndpoint(baseUrl, catalogModels, {
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 1_200, 1_200),
    })));
    return results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
}
async function discoverLocalEndpoint(baseUrl, catalogModels, options) {
    const base = safeEndpointUrl(baseUrl);
    const context = {
        base,
        authMethod: "none",
        fetchImpl: options.fetchImpl ?? fetch,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    };
    const errors = [];
    for (const probe of [probeLmStudio, probeOllama, probeOpenAi]) {
        try {
            const result = await probe(context);
            const root = normalizeProtocolRoot(result.baseUrl, "openai-chat-completions");
            const id = stableCustomProviderId(root, "openai-chat-completions");
            return {
                adapter: result.adapter === "lm-studio" || result.adapter === "ollama"
                    ? result.adapter
                    : "openai-chat-completions",
                provider: {
                    id,
                    name: result.name,
                    baseUrl: root,
                    api: "openai-completions",
                    wireProtocol: "openai-chat-completions",
                    authHeader: false,
                    requiresApiKey: false,
                    auth: { method: "none" },
                    models: enrichModels(result.models, catalogModels, result.preferredProvider),
                },
            };
        }
        catch (error) {
            errors.push(normalizeProbeError(error));
        }
    }
    throw bestDiscoveryError(errors);
}
async function probeLmStudio(context) {
    const url = new URL("/api/v1/models", context.base.origin);
    const payload = await requestJson(context, url, bearerHeaders(context.apiKey));
    const models = arrayField(payload, "models");
    if (!models.some((entry) => stringField(entry, "key")))
        throw unsupported();
    return {
        adapter: "lm-studio",
        id: "lm-studio",
        name: "LM Studio",
        baseUrl: new URL("/v1", context.base.origin).toString().replace(/\/$/, ""),
        api: "openai-completions",
        authHeader: Boolean(context.apiKey),
        models: models.slice(0, MAX_DISCOVERED_MODELS).flatMap((entry) => {
            const id = stringField(entry, "key");
            if (!id || stringField(entry, "type") === "embedding")
                return [];
            const capabilities = objectField(entry, "capabilities");
            const contextWindow = positiveIntegerField(entry, "max_context_length");
            return [model({
                    id,
                    name: stringField(entry, "display_name") ?? id,
                    reasoning: Boolean(objectField(capabilities, "reasoning")),
                    input: booleanField(capabilities, "vision") ? ["text", "image"] : ["text"],
                    contextWindow,
                })];
        }),
    };
}
async function probeOllama(context) {
    const tagsUrl = new URL("/api/tags", context.base.origin);
    const payload = await requestJson(context, tagsUrl, {});
    const entries = arrayField(payload, "models");
    if (!entries.some((entry) => stringField(entry, "model") ?? stringField(entry, "name"))) {
        throw unsupported();
    }
    const selected = entries.slice(0, Math.min(MAX_DISCOVERED_MODELS, MAX_OLLAMA_DETAIL_REQUESTS));
    const details = await Promise.all(selected.map(async (entry) => {
        const id = stringField(entry, "model") ?? stringField(entry, "name");
        if (!id)
            return undefined;
        try {
            const shown = await requestJson(context, new URL("/api/show", context.base.origin), { "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ model: id }) });
            const info = objectField(shown, "model_info");
            const contextWindow = Object.entries(info).find(([key, value]) => key.endsWith(".context_length") && Number.isInteger(value) && Number(value) > 0)?.[1];
            const capabilities = arrayField(shown, "capabilities").filter((value) => typeof value === "string");
            return model({
                id,
                name: id,
                reasoning: capabilities.includes("thinking"),
                input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
                contextWindow,
            });
        }
        catch {
            return model({ id, name: id, reasoning: false, input: ["text"] });
        }
    }));
    return {
        adapter: "ollama",
        id: "ollama",
        name: "Ollama",
        baseUrl: new URL("/v1", context.base.origin).toString().replace(/\/$/, ""),
        api: "openai-completions",
        authHeader: false,
        models: details.filter((entry) => Boolean(entry)),
    };
}
async function probeAnthropic(context) {
    const url = context.modelsUrl ?? versionedEndpoint(context.base, "v1", "models");
    const headers = { "anthropic-version": "2023-06-01" };
    if (context.apiKey) {
        if (context.authMethod === "custom-header" && context.headerName) {
            headers[context.headerName] = context.apiKey;
        }
        else {
            headers["x-api-key"] = context.apiKey;
        }
    }
    const payload = await requestJson(context, url, headers);
    const entries = arrayField(payload, "data");
    if (!entries.some((entry) => stringField(entry, "display_name") || positiveIntegerField(entry, "max_input_tokens"))) {
        throw unsupported();
    }
    return {
        adapter: "anthropic",
        id: context.base.hostname === "api.anthropic.com" ? "anthropic" : slug(context.base.hostname),
        name: context.base.hostname === "api.anthropic.com" ? "Anthropic" : displayHost(context.base),
        baseUrl: apiRoot(context.base, "v1"),
        api: "anthropic-messages",
        authHeader: false,
        preferredProvider: "anthropic",
        models: entries.slice(0, MAX_DISCOVERED_MODELS).flatMap((entry) => {
            const id = stringField(entry, "id");
            if (!id)
                return [];
            const capabilities = objectField(entry, "capabilities");
            return [model({
                    id,
                    name: stringField(entry, "display_name") ?? id,
                    reasoning: booleanField(objectField(capabilities, "thinking"), "supported"),
                    input: booleanField(objectField(capabilities, "image_input"), "supported")
                        ? ["text", "image"]
                        : ["text"],
                    contextWindow: positiveIntegerField(entry, "max_input_tokens"),
                    maxTokens: positiveIntegerField(entry, "max_tokens"),
                })];
        }),
    };
}
async function probeGemini(context) {
    const url = versionedEndpoint(context.base, "v1beta", "models");
    const headers = context.apiKey ? { "x-goog-api-key": context.apiKey } : {};
    const payload = await requestJson(context, url, headers);
    const entries = arrayField(payload, "models");
    if (!entries.some((entry) => stringField(entry, "name")?.startsWith("models/")))
        throw unsupported();
    return {
        adapter: "gemini",
        id: context.base.hostname === "generativelanguage.googleapis.com" ? "google" : slug(context.base.hostname),
        name: context.base.hostname === "generativelanguage.googleapis.com" ? "Google Gemini" : displayHost(context.base),
        baseUrl: apiRoot(context.base, "v1beta"),
        api: "google-generative-ai",
        authHeader: false,
        preferredProvider: "google",
        models: entries.slice(0, MAX_DISCOVERED_MODELS).flatMap((entry) => {
            const rawId = stringField(entry, "name");
            if (!rawId)
                return [];
            const methods = arrayField(entry, "supportedGenerationMethods");
            if (methods.length > 0 && !methods.includes("generateContent"))
                return [];
            const id = rawId.replace(/^models\//, "");
            return [model({
                    id,
                    name: stringField(entry, "displayName") ?? id,
                    reasoning: id.includes("thinking"),
                    input: ["text", "image"],
                    contextWindow: positiveIntegerField(entry, "inputTokenLimit"),
                    maxTokens: positiveIntegerField(entry, "outputTokenLimit"),
                })];
        }),
    };
}
async function probeOpenAi(context) {
    const url = context.modelsUrl ?? versionedEndpoint(context.base, "v1", "models");
    const headers = context.apiKey && context.authMethod === "custom-header" && context.headerName
        ? { [context.headerName]: context.apiKey }
        : bearerHeaders(context.apiKey);
    const payload = await requestJson(context, url, headers);
    const entries = arrayField(payload, "data");
    if (!entries.some((entry) => stringField(entry, "id")))
        throw unsupported();
    const hostname = context.base.hostname;
    const isOpenRouter = hostname === "openrouter.ai";
    const isOpenAi = hostname === "api.openai.com";
    return {
        adapter: "openai-compatible",
        id: isOpenAi ? "openai" : isOpenRouter ? "openrouter" : slug(displayHost(context.base)),
        name: isOpenAi ? "OpenAI" : isOpenRouter ? "OpenRouter" : displayHost(context.base),
        baseUrl: apiRoot(context.base, "v1"),
        api: "openai-completions",
        authHeader: Boolean(context.apiKey),
        preferredProvider: isOpenAi ? "openai" : isOpenRouter ? "openrouter" : undefined,
        models: entries.slice(0, MAX_DISCOVERED_MODELS).flatMap((entry) => {
            const id = stringField(entry, "id");
            if (!id)
                return [];
            const architecture = objectField(entry, "architecture");
            const modalities = arrayField(architecture, "input_modalities");
            const parameters = arrayField(entry, "supported_parameters");
            const topProvider = objectField(entry, "top_provider");
            return [model({
                    id,
                    name: stringField(entry, "name") ?? id,
                    reasoning: parameters.includes("reasoning") || parameters.includes("include_reasoning"),
                    input: modalities.includes("image") ? ["text", "image"] : ["text"],
                    contextWindow: positiveIntegerField(entry, "context_length"),
                    maxTokens: positiveIntegerField(topProvider, "max_completion_tokens"),
                })];
        }),
    };
}
function enrichModels(models, catalogModels, preferredProvider) {
    return models.map((entry) => {
        const matches = catalogModels.filter((candidate) => candidate.id === entry.id);
        const preferred = matches.find((candidate) => candidate.provider === preferredProvider);
        const contextWindow = entry.contextWindow ?? preferred?.contextWindow ?? consensus(matches, "contextWindow");
        const maxTokens = entry.maxTokens ?? preferred?.maxTokens ?? consensus(matches, "maxTokens");
        const capabilitySource = preferred ?? (matches.length === 1 ? matches[0] : undefined);
        return {
            ...entry,
            name: entry.name === entry.id && capabilitySource?.name ? capabilitySource.name : entry.name,
            reasoning: entry.reasoning || capabilitySource?.reasoning || false,
            input: entry.input.includes("image") || !capabilitySource?.input.includes("image")
                ? entry.input
                : ["text", "image"],
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxTokens ? { maxTokens } : {}),
            ...((contextWindow || maxTokens) ? {
                metadata: {
                    ...(contextWindow ? {
                        contextWindow: entry.contextWindow ? "endpoint" : "pi-catalog",
                    } : {}),
                    ...(maxTokens ? {
                        maxTokens: entry.maxTokens ? "endpoint" : "pi-catalog",
                    } : {}),
                },
            } : {}),
        };
    });
}
function consensus(models, field) {
    const values = [...new Set(models.map((entry) => entry[field]).filter((value) => Number.isInteger(value)))];
    return values.length === 1 ? values[0] : undefined;
}
function model(value) {
    return {
        ...value,
        ...(value.contextWindow || value.maxTokens ? {
            metadata: {
                ...(value.contextWindow ? { contextWindow: "endpoint" } : {}),
                ...(value.maxTokens ? { maxTokens: "endpoint" } : {}),
            },
        } : {}),
    };
}
async function requestJson(context, url, headers, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), context.timeoutMs);
    try {
        const response = await context.fetchImpl(url, {
            ...init,
            headers: { accept: "application/json", ...headers },
            redirect: "manual",
            signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
            throw new EndpointDiscoveryError("redirect", "The endpoint redirected the discovery request");
        }
        if (response.status === 401 || response.status === 403) {
            throw new EndpointDiscoveryError("authentication", "The endpoint rejected the API key");
        }
        if (response.status === 404 || response.status === 405)
            throw unsupported();
        if (!response.ok)
            throw new EndpointDiscoveryError("unsupported", `The endpoint returned HTTP ${response.status}`);
        const text = await boundedText(response, context.maxResponseBytes);
        try {
            return object(JSON.parse(text));
        }
        catch {
            throw new EndpointDiscoveryError("malformed-response", "The endpoint did not return a recognized JSON model list");
        }
    }
    catch (error) {
        if (error instanceof EndpointDiscoveryError)
            throw error;
        if (controller.signal.aborted) {
            throw new EndpointDiscoveryError("timeout", "The endpoint did not respond before the timeout");
        }
        throw new EndpointDiscoveryError("unreachable", "The server could not be reached");
    }
    finally {
        clearTimeout(timer);
    }
}
async function boundedText(response, maximum) {
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > maximum) {
            await reader.cancel();
            throw new EndpointDiscoveryError("malformed-response", "The model list response is too large");
        }
        chunks.push(value);
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}
function safeEndpointUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new EndpointDiscoveryError("invalid-url", "Enter a valid server URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new EndpointDiscoveryError("invalid-url", "The server URL must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
        throw new EndpointDiscoveryError("invalid-url", "The server URL may not contain credentials");
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "metadata.google.internal" ||
        hostname === "100.100.100.200" ||
        hostname === "fd00:ec2::254" ||
        hostname.startsWith("169.254.")) {
        throw new EndpointDiscoveryError("invalid-url", "Cloud metadata addresses cannot be used as model endpoints");
    }
    url.hash = "";
    url.search = "";
    return url;
}
function apiRoot(base, version) {
    const path = base.pathname.replace(/\/$/, "");
    if (path.endsWith(`/${version}`))
        return `${base.origin}${path}`;
    return `${base.origin}${path}/${version}`.replace(/([^:]\/)\/+/, "$1");
}
function versionedEndpoint(base, version, resource) {
    return new URL(`${apiRoot(base, version)}/${resource}`);
}
function bearerHeaders(apiKey) {
    return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function objectField(value, key) {
    return object(key ? object(value)[key] : value);
}
function arrayField(value, key) {
    const result = object(value)[key];
    return Array.isArray(result) ? result : [];
}
function stringField(value, key) {
    const result = object(value)[key];
    return typeof result === "string" && result.trim() ? result.trim() : undefined;
}
function positiveIntegerField(value, key) {
    const result = object(value)[key];
    return Number.isInteger(result) && Number(result) > 0 ? Number(result) : undefined;
}
function booleanField(value, key) {
    const result = key ? object(value)[key] : value;
    return result === true;
}
function unsupported() {
    return new EndpointDiscoveryError("unsupported", "This endpoint does not expose a supported model list");
}
function normalizeProbeError(error) {
    return error instanceof EndpointDiscoveryError
        ? error
        : new EndpointDiscoveryError("unsupported", "The endpoint could not be identified");
}
function bestDiscoveryError(errors) {
    const priorities = [
        "authentication",
        "timeout",
        "unreachable",
        "malformed-response",
        "redirect",
        "unsupported",
    ];
    for (const code of priorities) {
        const match = errors.find((error) => error.code === code);
        if (match)
            return match;
    }
    return unsupported();
}
function uniqueProviderId(base, reserved) {
    const ids = new Set(reserved);
    if (!ids.has(base))
        return base;
    let suffix = 2;
    while (ids.has(`${base}-${suffix}`))
        suffix++;
    return `${base}-${suffix}`;
}
function slug(value) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return (normalized || "custom-endpoint").slice(0, 64);
}
function displayHost(url) {
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}
function isLoopback(hostname) {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}
