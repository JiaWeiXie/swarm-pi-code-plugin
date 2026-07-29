import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserStateRoot } from "./state.js";
const REGISTRY_DIRECTORY_MODE = 0o700;
const REGISTRY_FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const PROVIDER_PROFILE_NON_CONNECTION_FIELDS = new Set([
    "name",
    "readiness",
    "discoveredAt",
    "verifiedAt",
    "verifiedModel",
]);
const providerRegistryTransactionContext = new AsyncLocalStorage();
export class ProviderRegistryRevisionConflictError extends Error {
    expected;
    actual;
    constructor(expected, actual) {
        super("Provider registry changed in another setup session. Reload before saving.");
        this.expected = expected;
        this.actual = actual;
        this.name = "ProviderRegistryRevisionConflictError";
    }
}
export class ProviderRegistryConflictError extends Error {
    providerId;
    kind;
    constructor(providerId, kind) {
        super(`Legacy project provider ${providerId} conflicts with the global provider registry. Resolve it in Configuration before continuing.`);
        this.providerId = providerId;
        this.kind = kind;
        this.name = "ProviderRegistryConflictError";
    }
}
export function emptyProviderRegistry() {
    return {
        version: 1,
        revision: providerRegistryRevisionFor([], []),
        customProviders: [],
        providerProfiles: [],
        updatedAt: null,
    };
}
export function resolveProviderRegistryFile(env = process.env) {
    return path.join(resolveUserStateRoot(env), "providers.json");
}
export function resolveProviderRegistryRecoveryFile(env = process.env) {
    return path.join(resolveUserStateRoot(env), "recovery", "providers.json");
}
export async function withProviderRegistryTransaction(operation, env = process.env) {
    const file = resolveProviderRegistryFile(env);
    const activeTransactions = providerRegistryTransactionContext.getStore();
    if (activeTransactions?.has(file))
        return operation();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
    await fs.chmod(path.dirname(file), REGISTRY_DIRECTORY_MODE);
    const lock = `${file}.transaction.lock`;
    await acquireLock(lock);
    try {
        return await providerRegistryTransactionContext.run(new Set([...(activeTransactions ?? []), file]), operation);
    }
    finally {
        await fs.rm(lock, { force: true });
    }
}
export async function loadProviderRegistry(env = process.env) {
    const file = resolveProviderRegistryFile(env);
    try {
        return parseProviderRegistry(JSON.parse(await fs.readFile(file, "utf8")));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return emptyProviderRegistry();
        throw error;
    }
}
export async function saveProviderRegistry(value, env = process.env, expectedRevision) {
    return withProviderRegistryTransaction(() => saveProviderRegistryUnderTransaction(value, env, expectedRevision), env);
}
async function saveProviderRegistryUnderTransaction(value, env, expectedRevision) {
    const file = resolveProviderRegistryFile(env);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
    await fs.chmod(path.dirname(file), REGISTRY_DIRECTORY_MODE);
    const lock = `${file}.lock`;
    await acquireLock(lock);
    try {
        const current = await loadProviderRegistry(env);
        if (expectedRevision !== undefined && expectedRevision !== current.revision) {
            throw new ProviderRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        const updatedAt = new Date().toISOString();
        const saved = parseProviderRegistry({
            version: 1,
            revision: providerRegistryRevisionFor(value.customProviders, value.providerProfiles),
            customProviders: value.customProviders,
            providerProfiles: value.providerProfiles,
            updatedAt,
        });
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, {
                mode: REGISTRY_FILE_MODE,
            });
            await fs.rename(temporary, file);
            await fs.chmod(file, REGISTRY_FILE_MODE);
        }
        finally {
            await fs.rm(temporary, { force: true });
        }
        return saved;
    }
    finally {
        await fs.rm(lock, { force: true });
    }
}
export async function mergeLegacyProviderRegistry(customProviders, providerProfiles, env = process.env) {
    const current = await loadProviderRegistry(env);
    const custom = new Map(current.customProviders.map((provider) => [provider.id, provider]));
    const profiles = new Map(current.providerProfiles.map((profile) => [profile.provider, profile]));
    let changed = false;
    for (const provider of customProviders) {
        const existing = custom.get(provider.id);
        if (existing && canonicalJson(existing) !== canonicalJson(provider)) {
            throw new ProviderRegistryConflictError(provider.id, "custom-provider");
        }
        if (!existing) {
            custom.set(provider.id, structuredClone(provider));
            changed = true;
        }
    }
    for (const profile of providerProfiles) {
        const existing = profiles.get(profile.provider);
        if (existing &&
            providerProfileConnectionConfiguration(existing) !==
                providerProfileConnectionConfiguration(profile)) {
            throw new ProviderRegistryConflictError(profile.provider, "provider-profile");
        }
        if (!existing) {
            profiles.set(profile.provider, structuredClone(profile));
            changed = true;
        }
    }
    if (!changed)
        return current;
    return saveProviderRegistry({
        customProviders: [...custom.values()],
        providerProfiles: [...profiles.values()],
    }, env, current.revision);
}
function providerProfileConnectionConfiguration(profile) {
    return canonicalJson(Object.fromEntries(Object.entries(profile).filter(([field]) => !PROVIDER_PROFILE_NON_CONNECTION_FIELDS.has(field))));
}
export function parseProviderRegistry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("provider registry must contain a JSON object");
    }
    const record = value;
    if (record.version !== 1)
        throw new Error("provider registry version must be 1");
    if (!Array.isArray(record.customProviders) || !Array.isArray(record.providerProfiles)) {
        throw new Error("provider registry providers and profiles must be arrays");
    }
    const computedRevision = providerRegistryRevisionFor(record.customProviders, record.providerProfiles);
    if (typeof record.revision === "string" && record.revision !== computedRevision) {
        throw new Error("provider registry revision does not match its contents");
    }
    return {
        version: 1,
        revision: computedRevision,
        customProviders: structuredClone(record.customProviders),
        providerProfiles: structuredClone(record.providerProfiles),
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    };
}
export function providerRegistryRevisionFor(customProviders, providerProfiles) {
    return createHash("sha256")
        .update(canonicalJson({ customProviders, providerProfiles }))
        .digest("hex")
        .slice(0, 24);
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        return `{${Object.entries(value)
            .filter(([, nested]) => nested !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
async function acquireLock(lock) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
        try {
            const handle = await fs.open(lock, "wx", REGISTRY_FILE_MODE);
            await handle.close();
            return;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const existing = await fs.stat(lock).catch(() => undefined);
            if (existing && Date.now() - existing.mtimeMs > LOCK_STALE_MS) {
                await fs.rm(lock, { force: true });
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out waiting for provider registry: ${lock}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
}
