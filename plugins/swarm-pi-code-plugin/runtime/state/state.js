import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export function defaultState() {
    return {
        version: 1,
        config: { modelPriority: [], availableModels: [], availableModelsCheckedAt: null },
        jobs: [],
    };
}
export async function resolveWorkspaceRoot(cwd) {
    try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            encoding: "utf8",
        });
        return await fs.realpath(stdout.trim());
    }
    catch {
        return path.resolve(cwd);
    }
}
export async function resolveSharedWorkspaceRoot(cwd) {
    const workspace = await resolveWorkspaceRoot(cwd);
    try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspace, encoding: "utf8" });
        const commonDir = await fs.realpath(stdout.trim());
        return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : workspace;
    }
    catch {
        return workspace;
    }
}
export async function resolveStateDir(cwd, env = process.env) {
    if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR) {
        return path.resolve(cwd, env.SWARM_PI_CODE_PLUGIN_DATA_DIR);
    }
    return path.join(await resolveSharedWorkspaceRoot(cwd), ".swarm-pi-code-plugin");
}
export async function resolveStateFile(cwd) {
    return path.join(await resolveStateDir(cwd), "state.json");
}
export async function loadState(cwd) {
    const current = await readJson(await resolveStateFile(cwd));
    if (current)
        return normalizeState(current);
    const migrated = await readLegacyState(cwd);
    if (migrated) {
        await writeState(cwd, migrated);
        return migrated;
    }
    return defaultState();
}
export async function writeState(cwd, state) {
    const stateFile = await resolveStateFile(cwd);
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(tempFile, stateFile);
    }
    finally {
        await fs.rm(tempFile, { force: true });
    }
}
export async function updateState(cwd, update) {
    return withStateLock(cwd, async () => {
        const state = structuredClone(await loadState(cwd));
        const updated = update(state) ?? state;
        await writeState(cwd, updated);
        return updated;
    });
}
export async function setModelPriority(cwd, models) {
    return updateState(cwd, (state) => {
        state.config.modelPriority = [...models];
    });
}
export async function setAvailableModels(cwd, models) {
    return updateState(cwd, (state) => {
        state.config.availableModels = [...models];
        state.config.availableModelsCheckedAt = new Date().toISOString();
    });
}
export async function saveProfile(cwd, profile) {
    return updateState(cwd, (state) => {
        state.config.profile = { ...profile, configuredAt: profile.configuredAt ?? new Date().toISOString() };
    });
}
export async function clearConfiguration(cwd) {
    return updateState(cwd, (state) => {
        state.config = { modelPriority: [], availableModels: [], availableModelsCheckedAt: null };
    });
}
async function readLegacyState(cwd) {
    const sharedRoot = await resolveSharedWorkspaceRoot(cwd);
    const workspaceRoot = await resolveWorkspaceRoot(cwd);
    const previousPiCandidates = new Set([
        path.join(sharedRoot, ".swarm-pi-code", "state.json"),
        path.join(workspaceRoot, ".swarm-pi-code", "state.json"),
    ]);
    for (const candidate of previousPiCandidates) {
        const previous = await readJson(candidate);
        if (!previous)
            continue;
        const state = normalizeState(previous);
        state.migration = { source: ".swarm-pi-code", migratedAt: new Date().toISOString() };
        return state;
    }
    const candidates = new Set([
        path.join(sharedRoot, ".swarm-code", "state.json"),
        path.join(workspaceRoot, ".swarm-code", "state.json"),
    ]);
    for (const candidate of candidates) {
        const legacy = await readJson(candidate);
        if (!legacy)
            continue;
        const config = asRecord(legacy.config);
        const legacyProfile = asRecord(config.swarmProfile);
        const state = defaultState();
        state.config.modelPriority = stringArray(config.modelPriority);
        if (Object.keys(legacyProfile).length > 0) {
            state.config.profile = {
                goal: stringValue(legacyProfile.goal),
                dirs: stringArray(legacyProfile.dirs),
                tasks: stringArray(legacyProfile.tasks),
                configuredAt: stringValue(legacyProfile.configuredAt) ?? new Date().toISOString(),
            };
        }
        state.migration = { source: ".swarm-code", migratedAt: new Date().toISOString() };
        return state;
    }
    return undefined;
}
async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
function normalizeState(value) {
    const config = asRecord(value.config);
    const profile = asRecord(config.profile);
    const state = defaultState();
    state.config.modelPriority = stringArray(config.modelPriority);
    state.config.availableModels = stringArray(config.availableModels);
    state.config.availableModelsCheckedAt = stringValue(config.availableModelsCheckedAt) ?? null;
    if (Object.keys(profile).length > 0) {
        state.config.profile = {
            goal: stringValue(profile.goal),
            dirs: stringArray(profile.dirs),
            tasks: stringArray(profile.tasks),
            configuredAt: stringValue(profile.configuredAt),
        };
    }
    state.jobs = Array.isArray(value.jobs)
        ? value.jobs.filter((job) => typeof job === "object" && job !== null && typeof job.id === "string")
        : [];
    const migration = asRecord(value.migration);
    if ((migration.source === ".swarm-pi-code" || migration.source === ".swarm-code") &&
        typeof migration.migratedAt === "string") {
        state.migration = { source: migration.source, migratedAt: migration.migratedAt };
    }
    return state;
}
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function stringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
async function withStateLock(cwd, run) {
    const directory = await resolveStateDir(cwd);
    await fs.mkdir(directory, { recursive: true });
    const lockFile = path.join(directory, "state.lock");
    const deadline = Date.now() + 5_000;
    let handle;
    while (!handle) {
        try {
            handle = await fs.open(lockFile, "wx", 0o600);
            await handle.writeFile(`${process.pid}\n`);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const stat = await fs.stat(lockFile).catch(() => undefined);
            if (stat && Date.now() - stat.mtimeMs > 30_000) {
                await fs.rm(lockFile, { force: true });
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out waiting for state lock: ${lockFile}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    try {
        return await run();
    }
    finally {
        await handle.close();
        await fs.rm(lockFile, { force: true });
    }
}
