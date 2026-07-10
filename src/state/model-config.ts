import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "./state.js";

export const SUPPORTED_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type SupportedProviderApi = (typeof SUPPORTED_PROVIDER_APIS)[number];

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_TOKENS = 16_384;

export const MODEL_METADATA_SOURCES = [
  "endpoint",
  "pi-catalog",
  "models-dev",
  "compatibility-default",
  "user",
] as const;

export type ModelMetadataSource = (typeof MODEL_METADATA_SOURCES)[number];

export interface CustomModelMetadata {
  contextWindow?: ModelMetadataSource | undefined;
  maxTokens?: ModelMetadataSource | undefined;
}

export interface CustomModelConfiguration {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  metadata?: CustomModelMetadata | undefined;
}

export interface CustomProviderConfiguration {
  id: string;
  name: string;
  baseUrl: string;
  api: SupportedProviderApi;
  authHeader: boolean;
  requiresApiKey: boolean;
  models: CustomModelConfiguration[];
}

export interface ModelConfiguration {
  version: 1;
  primary: string | null;
  fallbacks: string[];
  customProviders: CustomProviderConfiguration[];
  updatedAt: string | null;
}

export function defaultModelConfiguration(priority: string[] = []): ModelConfiguration {
  return {
    version: 1,
    primary: priority[0] ?? null,
    fallbacks: unique(priority.slice(1)),
    customProviders: [],
    updatedAt: null,
  };
}

export async function resolveModelConfigurationFile(cwd: string): Promise<string> {
  return path.join(await resolveStateDir(cwd), "model.json");
}

export async function loadModelConfiguration(
  cwd: string,
  legacyPriority: string[] = [],
): Promise<ModelConfiguration> {
  const file = await resolveModelConfigurationFile(cwd);
  try {
    return parseModelConfiguration(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultModelConfiguration(legacyPriority);
    }
    throw error;
  }
}

export async function saveModelConfiguration(
  cwd: string,
  value: Omit<ModelConfiguration, "version" | "updatedAt"> &
    Partial<Pick<ModelConfiguration, "version" | "updatedAt">>,
): Promise<ModelConfiguration> {
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
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return normalized;
}

export async function saveModelPriority(
  cwd: string,
  current: ModelConfiguration,
  priority: string[],
): Promise<ModelConfiguration> {
  const normalizedPriority = unique(priority.map((entry) => modelReference(entry)));
  return saveModelConfiguration(cwd, {
    primary: normalizedPriority[0] ?? null,
    fallbacks: normalizedPriority.slice(1),
    customProviders: current.customProviders,
  });
}

export async function clearModelConfiguration(cwd: string): Promise<void> {
  await fs.rm(await resolveModelConfigurationFile(cwd), { force: true });
}

export function modelPriority(configuration: ModelConfiguration): string[] {
  return configuration.primary
    ? unique([configuration.primary, ...configuration.fallbacks])
    : [];
}

export function parseModelConfiguration(value: unknown): ModelConfiguration {
  const record = asRecord(value, "model configuration");
  if (record.version !== 1) throw new Error("model configuration version must be 1");
  const primary = record.primary === null ? null : modelReference(record.primary);
  const fallbacks = unique(stringArray(record.fallbacks, "fallbacks").map(modelReference));
  const filteredFallbacks = primary ? fallbacks.filter((entry) => entry !== primary) : [];
  const customProviders = arrayValue(record.customProviders, "customProviders").map(
    parseCustomProvider,
  );
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

function parseCustomProvider(value: unknown): CustomProviderConfiguration {
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
  if (!SUPPORTED_PROVIDER_APIS.includes(api as SupportedProviderApi)) {
    throw new Error(`unsupported API type for ${id}: ${api}`);
  }
  const models = arrayValue(record.models, `models for ${id}`).map((model) =>
    parseCustomModel(model, id),
  );
  if (models.length === 0) throw new Error(`custom provider ${id} requires at least one model`);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error(`custom provider ${id} model identifiers must be unique`);
  }
  return {
    id,
    name: optionalString(record.name, `name for ${id}`) ?? id,
    baseUrl: parsedUrl.toString().replace(/\/$/, ""),
    api: api as SupportedProviderApi,
    authHeader: optionalBoolean(record.authHeader, `authHeader for ${id}`) ?? false,
    requiresApiKey: optionalBoolean(record.requiresApiKey, `requiresApiKey for ${id}`) ?? true,
    models,
  };
}

function parseCustomModel(value: unknown, provider: string): CustomModelConfiguration {
  const record = asRecord(value, `model for ${provider}`);
  const id = requiredString(record.id, `model id for ${provider}`);
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(`invalid model id for ${provider}: ${id}`);
  }
  const input = record.input === undefined
    ? ["text" as const]
    : stringArray(record.input, `input for ${provider}/${id}`).map((entry) => {
        if (entry !== "text" && entry !== "image") {
          throw new Error(`invalid input type for ${provider}/${id}: ${entry}`);
        }
        return entry;
      });
  if (!input.includes("text")) input.unshift("text");
  const contextWindow = optionalInteger(
    record.contextWindow,
    `contextWindow for ${provider}/${id}`,
    1024,
    10_000_000,
  );
  const maxTokens = optionalInteger(
    record.maxTokens,
    `maxTokens for ${provider}/${id}`,
    1,
    contextWindow ?? 10_000_000,
  );
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

function parseModelMetadata(
  value: unknown,
  provider: string,
  model: string,
): CustomModelMetadata | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, `metadata for ${provider}/${model}`);
  const contextWindow = metadataSource(record.contextWindow, `contextWindow metadata for ${provider}/${model}`);
  const maxTokens = metadataSource(record.maxTokens, `maxTokens metadata for ${provider}/${model}`);
  if (!contextWindow && !maxTokens) return undefined;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

function metadataSource(value: unknown, label: string): ModelMetadataSource | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MODEL_METADATA_SOURCES.includes(value as ModelMetadataSource)) {
    throw new Error(`${label} must be a supported metadata source`);
  }
  return value as ModelMetadataSource;
}

function modelReference(value: unknown): string {
  const reference = requiredString(value, "model reference");
  const separator = reference.indexOf("/");
  if (separator < 1 || separator === reference.length - 1) {
    throw new Error(`model reference must use provider/model: ${reference}`);
  }
  if (/\s/.test(reference)) throw new Error(`model reference may not contain whitespace: ${reference}`);
  return reference;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  const array = arrayValue(value, label);
  if (!array.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must contain only strings`);
  }
  return array;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.length > 2048) throw new Error(`${label} is too long`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
