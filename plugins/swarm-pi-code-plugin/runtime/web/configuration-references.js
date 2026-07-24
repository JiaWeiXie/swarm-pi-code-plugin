export function providerForModelReference(reference) {
    return reference.slice(0, reference.indexOf("/"));
}
export function modelReferences(configuration, rolePolicies, adaptivePolicy) {
    return new Set([
        ...(configuration.primary ? [configuration.primary] : []),
        ...configuration.fallbacks,
        ...Object.values(rolePolicies).flatMap((policy) => policy?.models ?? []),
        ...adaptivePolicy.classifierModels,
    ]);
}
export function removedCustomModelReferences(current, candidate) {
    const next = new Map(candidate.customProviders.map((provider) => [provider.id, provider]));
    const removed = new Set();
    for (const provider of current.customProviders) {
        const replacement = next.get(provider.id);
        const nextModels = new Set(replacement?.models.map((model) => model.id) ?? []);
        for (const model of provider.models) {
            if (!nextModels.has(model.id))
                removed.add(`${provider.id}/${model.id}`);
        }
    }
    return removed;
}
export function removedCustomProviderIds(current, candidate) {
    const next = new Set(candidate.customProviders.map((provider) => provider.id));
    return new Set(current.customProviders
        .map((provider) => provider.id)
        .filter((provider) => !next.has(provider)));
}
export function reconcileRemovedModelReferences(configuration, rolePolicies, adaptivePolicy, removed, removedProviders = new Set()) {
    const nextConfiguration = structuredClone(configuration);
    const nextRolePolicies = structuredClone(rolePolicies);
    const nextAdaptivePolicy = structuredClone(adaptivePolicy);
    const changes = [];
    if (nextConfiguration.primary && removed.has(nextConfiguration.primary)) {
        const previous = nextConfiguration.primary;
        const replacement = nextConfiguration.fallbacks.find((reference) => !removed.has(reference)) ?? null;
        nextConfiguration.primary = replacement;
        changes.push({
            path: "primary",
            previous,
            next: replacement,
            reason: replacement ? "fallback-promoted" : removalReason(previous, removedProviders),
        });
    }
    const previousFallbacks = nextConfiguration.fallbacks;
    nextConfiguration.fallbacks = unique(previousFallbacks.filter((reference) => !removed.has(reference) && reference !== nextConfiguration.primary));
    for (const reference of previousFallbacks) {
        if (removed.has(reference)) {
            changes.push({
                path: "fallbacks",
                previous: reference,
                next: null,
                reason: removalReason(reference, removedProviders),
            });
        }
    }
    for (const [role, policy] of Object.entries(nextRolePolicies)) {
        if (!policy?.models)
            continue;
        const models = policy.models.filter((reference) => !removed.has(reference));
        if (models.length > 0) {
            policy.models = models;
            continue;
        }
        delete policy.models;
        changes.push({
            path: `rolePolicies.${role}.models`,
            previous: "removed-model-chain",
            next: null,
            reason: "inherited",
        });
    }
    const classifierModels = nextAdaptivePolicy.classifierModels.filter((reference) => !removed.has(reference));
    if (classifierModels.length > 0) {
        nextAdaptivePolicy.classifierModels = classifierModels;
    }
    else if (nextAdaptivePolicy.classifierModels.length > 0 && nextConfiguration.primary) {
        nextAdaptivePolicy.classifierModels = [nextConfiguration.primary];
        changes.push({
            path: "adaptivePolicy.classifierModels",
            previous: "removed-model-chain",
            next: nextConfiguration.primary,
            reason: "primary-default",
        });
    }
    else if (nextAdaptivePolicy.classifierModels.length > 0) {
        nextAdaptivePolicy.classifierModels = [];
        changes.push({
            path: "adaptivePolicy.classifierModels",
            previous: "removed-model-chain",
            next: null,
            reason: "model-removed",
        });
    }
    for (const profile of nextConfiguration.providerProfiles) {
        if (!profile.verifiedModel || !removed.has(profile.verifiedModel))
            continue;
        const previous = profile.verifiedModel;
        delete profile.verifiedModel;
        delete profile.verifiedAt;
        if (profile.readiness === "verified")
            profile.readiness = "configured";
        changes.push({
            path: `providerProfiles.${profile.provider}.verifiedModel`,
            previous,
            next: null,
            reason: removalReason(previous, removedProviders),
        });
    }
    return {
        configuration: nextConfiguration,
        rolePolicies: nextRolePolicies,
        adaptivePolicy: nextAdaptivePolicy,
        changes,
    };
}
function removalReason(reference, removedProviders) {
    const provider = providerForModelReference(reference);
    return removedProviders.has(provider) ? "provider-removed" : "model-removed";
}
function unique(values) {
    return [...new Set(values)];
}
