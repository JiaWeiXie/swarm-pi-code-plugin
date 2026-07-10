import {
  AuthStorage,
  ModelRegistry,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import type { AvailableModel } from "../core/contracts.js";

export interface ModelCatalog {
  available(): PiModel[];
}

export type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

export function modelId(model: Pick<PiModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function describeModels(models: PiModel[]): AvailableModel[] {
  return models.map((model) => ({
    id: modelId(model),
    provider: model.provider,
    model: model.id,
    name: model.name,
  }));
}

export function createModelCatalog(): ModelCatalog {
  const authStorage = AuthStorage.create();
  const registry = ModelRegistry.create(authStorage);

  return {
    available: () => registry.getAvailable(),
  };
}

export function selectModel(models: PiModel[], requested?: string): PiModel | undefined {
  if (!requested) {
    return models[0];
  }

  return models.find((model) => modelId(model) === requested);
}
