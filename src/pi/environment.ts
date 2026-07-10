import {
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import type { ModelConfiguration } from "../state/model-config.js";

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
      apiKey: `$${customProviderApiKeyVariable(provider.id)}`,
      api: provider.api,
      authHeader: provider.authHeader,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    };
    registry.registerProvider(provider.id, input);
  }
}

export function customProviderApiKeyVariable(provider: string): string {
  return `SWARM_PI_CODE_PLUGIN_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
