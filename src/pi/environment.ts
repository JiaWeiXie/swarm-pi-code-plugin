import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { getProviderDefinition } from "../providers/capabilities.js";
import { wireProtocolForRuntimeApi } from "../providers/endpoints.js";
import {
  CONTROLLED_SECRET_HEADER_NAMES,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  type ControlledProviderHeader,
  type CustomProviderConfiguration,
  type ModelConfiguration,
  type ProviderProfile,
} from "../state/model-config.js";

// Pi's thinking-level vocabulary (off/minimal/low/medium/high/xhigh/max) is
// wider than any single provider's accepted reasoning.effort set. Custom
// providers carry no thinkingLevelMap, so Pi levels pass through verbatim and
// mismatched values 400 (e.g. Azure gpt-5.x rejects "minimal"). We clamp every
// level into {low, medium, high} — the set BOTH OpenAI-responses and Azure
// OpenAI-responses accept — so a request can never 400 on either. (Azure loses
// xhigh -> high; OpenAI loses minimal -> low. Real delegation uses
// medium/high/xhigh, which are unaffected apart from xhigh -> high.)
// Only applied to OpenAI-family wire protocols; anthropic-messages is excluded
// because Claude takes effort through output_config.effort + a native thinking
// config that the SDK manages, not a reasoning.effort string.
const OPENAI_SAFE_EFFORT_MAP: Readonly<Record<string, string>> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

function customProviderEffortMap(
  provider: CustomProviderConfiguration,
): Readonly<Record<string, string>> | undefined {
  const wire = provider.wireProtocol ?? wireProtocolForRuntimeApi(provider.api);
  return wire === "openai-responses" || wire === "openai-chat-completions"
    ? OPENAI_SAFE_EFFORT_MAP
    : undefined;
}

export interface PiEnvironment {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export interface PiEnvironmentOptions {
  authStorage?: AuthStorage | undefined;
}

export function createPiEnvironment(
  configuration: ModelConfiguration,
  env: NodeJS.ProcessEnv = process.env,
  options: PiEnvironmentOptions = {},
): PiEnvironment {
  const persistentAuth =
    options.authStorage ?? AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  const authStorage = withProviderEnvironment(
    persistentAuth,
    providerEnvironmentOverlays(configuration),
  );
  const modelRegistry = ModelRegistry.create(authStorage, env.SWARM_PI_CODE_PLUGIN_MODELS_FILE);
  applyProviderProfiles(modelRegistry, configuration);
  applyCustomProviders(modelRegistry, configuration);
  return { authStorage, modelRegistry };
}

export function applyProviderProfiles(
  registry: ModelRegistry,
  configuration: ModelConfiguration,
): void {
  for (const profile of configuration.providerProfiles) {
    if (profile.connectionKind !== "builtin") continue;
    const headers = profileHeaders(profile);
    if (Object.keys(headers).length === 0) continue;
    registry.registerProvider(profile.provider, { headers });
  }
}

export function applyCustomProviders(
  registry: ModelRegistry,
  configuration: ModelConfiguration,
): void {
  for (const provider of configuration.customProviders) {
    const authMethod = provider.auth?.method ?? (provider.requiresApiKey ? "api-key" : "none");
    const headers = resolvedHeaders(provider.id, provider.headers ?? []);
    const effortMap = customProviderEffortMap(provider);
    const input: Parameters<ModelRegistry["registerProvider"]>[1] = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey:
        authMethod !== "none" ? `$${customProviderApiKeyVariable(provider.id)}` : "local-no-auth",
      api: provider.api,
      authHeader: authMethod === "api-key" && provider.authHeader,
      ...(Object.keys(headers).length ? { headers } : {}),
      models: provider.models.map((model) => {
        const contextWindow = model.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW;
        return {
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: Math.min(model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS, contextWindow),
          // Reasoning models on OpenAI-family protocols get a clamped effort map
          // so Pi's thinking levels never emit an unsupported reasoning.effort.
          // Non-reasoning models omit it (no effort is sent for them).
          ...(model.reasoning && effortMap ? { thinkingLevelMap: effortMap } : {}),
        };
      }),
    };
    registry.registerProvider(provider.id, input);
  }
}

export function customProviderApiKeyVariable(provider: string): string {
  return `SWARM_PI_CODE_PLUGIN_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function customProviderHeaderVariable(provider: string, header: string): string {
  return `SWARM_PI_CODE_PLUGIN_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_HEADER_${header.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export function providerEnvironmentOverlays(
  configuration: ModelConfiguration,
): Map<string, Record<string, string>> {
  const overlays = new Map<string, Record<string, string>>();
  for (const profile of configuration.providerProfiles) {
    const definition = getProviderDefinition(profile.provider);
    if (!definition) continue;
    const overlay: Record<string, string> = {};
    for (const field of definition.fields) {
      const destination = field.destination;
      if (
        !destination?.key ||
        (destination.kind !== "profile" && destination.kind !== "credential-env")
      ) {
        continue;
      }
      if (
        field.visibleWhen?.field === "authMethod" &&
        field.visibleWhen.equals !== profile.auth.method
      ) {
        continue;
      }
      const value = profile.settings[field.id];
      if (value) overlay[destination.key] = value;
    }
    if (Object.keys(overlay).length) overlays.set(profile.provider, overlay);
  }
  return overlays;
}

function withProviderEnvironment(
  storage: AuthStorage,
  overlays: Map<string, Record<string, string>>,
): AuthStorage {
  if (overlays.size === 0) return storage;
  return new Proxy(storage, {
    get(target, property) {
      if (property === "getProviderEnv") {
        return (provider: string): Record<string, string> | undefined => {
          const stored = target.getProviderEnv(provider);
          const overlay = overlays.get(provider);
          if (!stored && !overlay) return undefined;
          return { ...stored, ...overlay };
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function profileHeaders(profile: ProviderProfile): Record<string, string> {
  const headers = resolvedHeaders(profile.provider, profile.headers);
  const definition = getProviderDefinition(profile.provider);
  for (const field of definition?.fields ?? []) {
    if (field.destination?.kind !== "header-literal" || !field.destination.key) continue;
    const value = profile.settings[field.id];
    if (value) headers[field.destination.key] = configLiteral(value);
  }
  if (profile.provider === "openai") {
    if (profile.settings.organization)
      headers["OpenAI-Organization"] = configLiteral(profile.settings.organization);
    if (profile.settings.project)
      headers["OpenAI-Project"] = configLiteral(profile.settings.project);
  }
  return headers;
}

function resolvedHeaders(
  provider: string,
  definitions: ControlledProviderHeader[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of definitions) {
    if (header.value) {
      headers[canonicalHeaderName(header.name)] = configLiteral(header.value);
      continue;
    }
    if (header.secretRef && CONTROLLED_SECRET_HEADER_NAMES.includes(header.name as never)) {
      headers[canonicalHeaderName(header.name)] =
        `$${customProviderHeaderVariable(provider, header.name)}`;
    }
  }
  return headers;
}

function canonicalHeaderName(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
    .join("-");
}

function configLiteral(value: string): string {
  const escaped = value.split("$").join("$$");
  return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
}
