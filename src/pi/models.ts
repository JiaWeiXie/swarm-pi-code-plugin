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

export function orderModels(
  models: PiModel[],
  options: { requested?: string | undefined; priority?: string[] | undefined } = {},
): PiModel[] {
  if (options.requested) {
    const selected = selectModel(models, options.requested);
    return selected ? [selected] : [];
  }
  const byId = new Map(models.map((model) => [modelId(model), model]));
  const ordered: PiModel[] = [];
  for (const id of options.priority ?? []) {
    const model = byId.get(id);
    if (model && !ordered.includes(model)) ordered.push(model);
  }
  if ((options.priority?.length ?? 0) === 0 && ordered.length === 0 && models[0]) {
    ordered.push(models[0]);
  }
  return ordered;
}
