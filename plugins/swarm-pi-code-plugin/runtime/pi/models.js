import { modelPriority } from "../state/model-config.js";
import { createPiEnvironment } from "./environment.js";
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
export function describeProviders(catalog, configuration) {
    const all = catalog.all?.() ?? catalog.available();
    const availableModels = catalog.available();
    const available = new Set(availableModels.map(modelId));
    const priority = modelPriority(configuration);
    const custom = new Set(configuration.customProviders.map((provider) => provider.id));
    const selectedProviders = priority.map((reference) => reference.slice(0, reference.indexOf("/")));
    const providerIds = [
        ...new Set([
            ...availableModels.map((model) => model.provider),
            ...custom,
            ...selectedProviders,
            ...configuration.providerProfiles.map((profile) => profile.provider),
        ]),
    ].sort((left, right) => (catalog.displayName?.(left) ?? left).localeCompare(catalog.displayName?.(right) ?? right));
    return providerIds.map((id) => {
        const models = all.filter((model) => model.provider === id);
        const availableModelCount = models.filter((model) => available.has(modelId(model))).length;
        const status = catalog.authStatus?.(id) ?? { configured: availableModelCount > 0 };
        const priorityIndex = priority.findIndex((model) => model.startsWith(`${id}/`));
        return {
            id,
            name: catalog.displayName?.(id) ?? id,
            ready: availableModelCount > 0,
            modelCount: models.length,
            availableModelCount,
            auth: { source: status.source ?? null, label: status.label ?? null },
            selection: priorityIndex === 0 ? "primary" : priorityIndex > 0 ? "fallback" : null,
            custom: custom.has(id),
        };
    });
}
export function createModelCatalog(configuration, env = process.env, options = {}) {
    return createPiEnvironment(configuration, env).then(async ({ modelRuntime: runtime }) => {
        const catalog = {
            all: () => [...runtime.getModels()],
            available: () => [...runtime.getAvailableSnapshot()],
            refresh: async () => {
                await runtime.refresh({ allowNetwork: true });
            },
            displayName: (provider) => runtime.getProvider(provider)?.name ?? provider,
            authStatus: (provider) => runtime.getProviderAuthStatus(provider),
            error: () => runtime.getError(),
        };
        if (options.refresh)
            await catalog.refresh();
        return catalog;
    });
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
