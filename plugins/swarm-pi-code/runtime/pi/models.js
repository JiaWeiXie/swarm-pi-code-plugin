import { AuthStorage, ModelRegistry, } from "@earendil-works/pi-coding-agent";
export function modelId(model) {
    return `${model.provider}/${model.id}`;
}
export function describeModels(models) {
    return models.map((model) => ({
        id: modelId(model),
        provider: model.provider,
        model: model.id,
        name: model.name,
    }));
}
export function createModelCatalog() {
    const authStorage = AuthStorage.create();
    const registry = ModelRegistry.create(authStorage);
    return {
        available: () => registry.getAvailable(),
    };
}
export function selectModel(models, requested) {
    if (!requested) {
        return models[0];
    }
    return models.find((model) => modelId(model) === requested);
}
export function orderModels(models, options = {}) {
    if (options.requested) {
        const selected = selectModel(models, options.requested);
        return selected ? [selected] : [];
    }
    const byId = new Map(models.map((model) => [modelId(model), model]));
    const ordered = [];
    for (const id of options.priority ?? []) {
        const model = byId.get(id);
        if (model && !ordered.includes(model))
            ordered.push(model);
    }
    if ((options.priority?.length ?? 0) === 0 && ordered.length === 0 && models[0]) {
        ordered.push(models[0]);
    }
    return ordered;
}
