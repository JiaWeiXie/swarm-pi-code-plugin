import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "./state.js";
export const SUPPORTED_PROVIDER_APIS = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];
export function defaultModelConfiguration(priority = []) {
    return {
        version: 1,
        primary: priority[0] ?? null,
        fallbacks: unique(priority.slice(1)),
        customProviders: [],
        updatedAt: null,
    };
}
export async function resolveModelConfigurationFile(cwd) {
    return path.join(await resolveStateDir(cwd), "model.json");
}
export async function loadModelConfiguration(cwd, legacyPriority = []) {
    const file = await resolveModelConfigurationFile(cwd);
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
export async function saveModelConfiguration(cwd, value) {
    const normalized = parseModelConfiguration({
        ...value,
        version: 1,
        updatedAt: new Date().toISOString(),
    });
    const file = await resolveModelConfigurationFile(cwd);
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
export async function saveModelPriority(cwd, current, priority) {
    const normalizedPriority = unique(priority.map((entry) => modelReference(entry)));
    return saveModelConfiguration(cwd, {
        primary: normalizedPriority[0] ?? null,
        fallbacks: normalizedPriority.slice(1),
        customProviders: current.customProviders,
    });
}
export async function clearModelConfiguration(cwd) {
    await fs.rm(await resolveModelConfigurationFile(cwd), { force: true });
}
export function modelPriority(configuration) {
    return configuration.primary
        ? unique([configuration.primary, ...configuration.fallbacks])
        : [];
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
    return {
        version: 1,
        primary,
        fallbacks: filteredFallbacks,
        customProviders,
        updatedAt: record.updatedAt === null ? null : optionalString(record.updatedAt, "updatedAt") ?? null,
    };
}
function parseCustomProvider(value) {
    const record = asRecord(value, "custom provider");
    for (const forbidden of ["apiKey", "headers", "oauth", "env", "command"]) {
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
    const models = arrayValue(record.models, `models for ${id}`).map((model) => parseCustomModel(model, id));
    if (models.length === 0)
        throw new Error(`custom provider ${id} requires at least one model`);
    if (new Set(models.map((model) => model.id)).size !== models.length) {
        throw new Error(`custom provider ${id} model identifiers must be unique`);
    }
    return {
        id,
        name: optionalString(record.name, `name for ${id}`) ?? id,
        baseUrl: parsedUrl.toString().replace(/\/$/, ""),
        api: api,
        authHeader: optionalBoolean(record.authHeader, `authHeader for ${id}`) ?? false,
        models,
    };
}
function parseCustomModel(value, provider) {
    const record = asRecord(value, `model for ${provider}`);
    const id = requiredString(record.id, `model id for ${provider}`);
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
    const contextWindow = integer(record.contextWindow, `contextWindow for ${provider}/${id}`, 1024, 10_000_000, 128_000);
    const maxTokens = integer(record.maxTokens, `maxTokens for ${provider}/${id}`, 1, contextWindow, 16_384);
    return {
        id,
        name: optionalString(record.name, `name for ${provider}/${id}`) ?? id,
        reasoning: optionalBoolean(record.reasoning, `reasoning for ${provider}/${id}`) ?? false,
        input: unique(input),
        contextWindow,
        maxTokens,
    };
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
function optionalString(value, label) {
    if (value === undefined)
        return undefined;
    return requiredString(value, label);
}
function optionalBoolean(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean")
        throw new Error(`${label} must be a boolean`);
    return value;
}
function integer(value, label, minimum, maximum, defaultValue) {
    if (value === undefined)
        return defaultValue;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}
function unique(values) {
    return [...new Set(values)];
}
