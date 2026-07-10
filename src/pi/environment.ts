import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  type ModelConfiguration,
} from "../state/model-config.js";

export interface PiEnvironment {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

export function createPiEnvironment(
  configuration: ModelConfiguration,
  env: NodeJS.ProcessEnv = process.env,
): PiEnvironment {
  const authStorage = AuthStorage.create(env.SWARM_PI_CODE_PLUGIN_AUTH_FILE);
  const modelRegistry = ModelRegistry.create(
    authStorage,
    env.SWARM_PI_CODE_PLUGIN_MODELS_FILE,
  );
  applyCustomProviders(modelRegistry, configuration);
  return { authStorage, modelRegistry };
}

export function applyCustomProviders(
  registry: ModelRegistry,
  configuration: ModelConfiguration,
): void {
  for (const provider of configuration.customProviders) {
    const input: Parameters<ModelRegistry["registerProvider"]>[1] = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.requiresApiKey
        ? `$${customProviderApiKeyVariable(provider.id)}`
        : "local-no-auth",
      api: provider.api,
      authHeader: provider.authHeader,
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
        };
      }),
    };
    registry.registerProvider(provider.id, input);
  }
}

export function customProviderApiKeyVariable(provider: string): string {
  return `SWARM_PI_CODE_PLUGIN_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
