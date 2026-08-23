import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InMemoryCredentialStore, } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 100;
/**
 * A small CredentialStore compatible with Pi's auth.json format.
 *
 * Pi 0.80.8 deliberately stopped exporting its AuthStorage implementation.
 * Keeping this adapter in the plugin preserves the existing file boundary and
 * lets configuration flows use the same storage contract as ModelRuntime.
 */
export class FileCredentialStore {
    authPath;
    constructor(authPath) {
        this.authPath = authPath;
    }
    async read(providerId, options) {
        const data = await this.readData(options?.signal);
        const credential = data[providerId];
        return credential ? resolveCredential(credential) : undefined;
    }
    async list(options) {
        const data = await this.readData(options?.signal);
        return Object.entries(data).map(([providerId, credential]) => ({
            providerId,
            type: credential.type,
        }));
    }
    async modify(providerId, fn, options) {
        return this.withLock(async (data) => {
            const current = cloneCredential(data[providerId]);
            const next = await fn(current);
            if (next === undefined)
                return { result: current };
            data[providerId] = structuredClone(next);
            return { result: cloneCredential(next), write: true };
        }, options?.signal);
    }
    async delete(providerId, options) {
        await this.withLock(async (data) => {
            delete data[providerId];
            return { result: undefined, write: true };
        }, options?.signal);
    }
    async readData(signal) {
        signal?.throwIfAborted();
        try {
            const content = await readFile(this.authPath, "utf8");
            return parseCredentialData(content);
        }
        catch (error) {
            if (isMissing(error))
                return {};
            throw error;
        }
    }
    async withLock(fn, signal) {
        signal?.throwIfAborted();
        await mkdir(path.dirname(this.authPath), { recursive: true, mode: AUTH_DIRECTORY_MODE });
        const lockPath = `${this.authPath}.lock`;
        await acquireLock(lockPath, signal);
        try {
            let data = {};
            try {
                data = parseCredentialData(await readFile(this.authPath, "utf8"));
            }
            catch (error) {
                if (!isMissing(error))
                    throw error;
            }
            signal?.throwIfAborted();
            const outcome = await fn(data);
            signal?.throwIfAborted();
            // The atomic rename inside writeCredentialData is the commit point; an
            // abort observed after it must not roll the stored credential back.
            if (outcome.write)
                await writeCredentialData(this.authPath, data, signal);
            return outcome.result;
        }
        finally {
            // Lock release always runs, cancelled or not, so a cancelled operation
            // never leaves the store wedged for the next caller.
            await rm(lockPath, { recursive: true, force: true });
        }
    }
}
/** Apply provider-profile environment values without persisting them. */
export class OverlayCredentialStore {
    delegate;
    overlays;
    constructor(delegate, overlays) {
        this.delegate = delegate;
        this.overlays = overlays;
    }
    async read(providerId, options) {
        const credential = await this.delegate.read(providerId, options);
        const overlay = this.overlays.get(providerId);
        if (!credential && overlay)
            return { type: "api_key", env: { ...overlay } };
        if (!credential || !overlay)
            return credential;
        if (credential.type !== "api_key")
            return credential;
        return { ...credential, env: { ...credential.env, ...overlay } };
    }
    async list(options) {
        const entries = [...(await this.delegate.list(options))];
        const known = new Set(entries.map((entry) => entry.providerId));
        for (const providerId of this.overlays.keys()) {
            if (!known.has(providerId))
                entries.push({ providerId, type: "api_key" });
        }
        return entries;
    }
    modify(providerId, fn, options) {
        return this.delegate.modify(providerId, fn, options);
    }
    delete(providerId, options) {
        return this.delegate.delete(providerId, options);
    }
}
export function createFileCredentialStore(authPath) {
    return new FileCredentialStore(authPath ?? path.join(getAgentDir(), "auth.json"));
}
export async function cloneCredentialStore(source) {
    const target = new InMemoryCredentialStore();
    for (const entry of await source.list()) {
        const credential = await source.read(entry.providerId);
        if (credential)
            await target.modify(entry.providerId, async () => structuredClone(credential));
    }
    return target;
}
function parseCredentialData(content) {
    if (!content.trim())
        return {};
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Pi credential store must contain a JSON object");
    }
    return parsed;
}
async function writeCredentialData(authPath, data, signal) {
    const temporaryPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        signal?.throwIfAborted();
        await writeFile(temporaryPath, JSON.stringify(data, null, 2), {
            encoding: "utf8",
            mode: AUTH_FILE_MODE,
        });
        signal?.throwIfAborted();
        await rename(temporaryPath, authPath);
    }
    finally {
        // Unconditional: a cancelled write must not leave a temp file behind.
        await rm(temporaryPath, { force: true });
    }
}
async function acquireLock(lockPath, signal) {
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
        try {
            await mkdir(lockPath);
            return;
        }
        catch (error) {
            if (!isAlreadyExists(error))
                throw error;
            try {
                const age = Date.now() - (await stat(lockPath)).mtimeMs;
                if (age > LOCK_STALE_MS)
                    await rm(lockPath, { recursive: true, force: true });
            }
            catch (statError) {
                if (!isMissing(statError))
                    throw statError;
            }
            // Abortable wait: cancellation surfaces immediately instead of after the
            // full LOCK_RETRIES × 100ms ceiling.
            await delay(100, undefined, { signal });
        }
    }
    throw new Error("Timed out waiting for the Pi credential store lock");
}
function resolveCredential(credential) {
    if (credential.type !== "api_key" || !credential.key)
        return structuredClone(credential);
    const key = resolveEnvironmentTemplate(credential.key, credential.env);
    const resolved = structuredClone(credential);
    if (key === undefined)
        delete resolved.key;
    else
        resolved.key = key;
    return resolved;
}
function resolveEnvironmentTemplate(value, env) {
    let unresolved = false;
    const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
        const name = braced ?? bare;
        const replacement = env?.[name] ?? process.env[name];
        if (replacement === undefined) {
            unresolved = true;
            return "";
        }
        return replacement;
    });
    return unresolved ? undefined : resolved;
}
function cloneCredential(credential) {
    return credential ? structuredClone(credential) : undefined;
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isAlreadyExists(error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST";
}
