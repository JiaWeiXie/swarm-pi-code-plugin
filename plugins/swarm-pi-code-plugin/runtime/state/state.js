import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_ADAPTIVE_POLICY, DEFAULT_BACKGROUND_ROLE_POLICY, isWorkerRole, normalizeAdaptivePolicy, defaultAdvisorPolicy, defaultHostAssistancePolicy, WORKFLOW_BOUNDS, } from "../orchestration/roles.js";
const execFileAsync = promisify(execFile);
export class StateMigrationConflictError extends Error {
    legacyDir;
    destinationDir;
    constructor(legacyDir, destinationDir) {
        super(`Runtime state exists in both ${legacyDir} and ${destinationDir}`);
        this.legacyDir = legacyDir;
        this.destinationDir = destinationDir;
        this.name = "StateMigrationConflictError";
    }
}
export class StateMigrationActiveJobsError extends Error {
    sourceDir;
    constructor(sourceDir) {
        super(`Runtime state migration is blocked by active jobs in ${sourceDir}`);
        this.sourceDir = sourceDir;
        this.name = "StateMigrationActiveJobsError";
    }
}
export class StateMigrationAmbiguousError extends Error {
    sources;
    constructor(sources) {
        super(`Runtime state migration has multiple possible sources: ${sources.join(", ")}`);
        this.sources = sources;
        this.name = "StateMigrationAmbiguousError";
    }
}
export class StateMigrationError extends Error {
    sourceDir;
    destinationDir;
    constructor(sourceDir, destinationDir, cause) {
        super(`Runtime state migration failed from ${sourceDir} to ${destinationDir}`, { cause });
        this.sourceDir = sourceDir;
        this.destinationDir = destinationDir;
        this.name = "StateMigrationError";
    }
}
export function defaultState() {
    return {
        version: 1,
        config: {
            modelPriority: [],
            availableModels: [],
            availableModelsCheckedAt: null,
            sandboxMode: "adaptive",
            rolePolicies: {},
            adaptivePolicy: structuredClone(DEFAULT_ADAPTIVE_POLICY),
            backgroundRolePolicy: structuredClone(DEFAULT_BACKGROUND_ROLE_POLICY),
            decisionMode: "balance",
            hostAssistance: defaultHostAssistancePolicy(),
            contextBudget: 4,
            advisor: defaultAdvisorPolicy(),
            hostActions: defaultHostActionPolicy(),
        },
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
    const commonDir = await resolveGitCommonDir(cwd);
    if (commonDir)
        return path.join(commonDir, "swarm-pi-code-plugin");
    const workspace = await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
    const key = createHash("sha256").update(workspace).digest("hex");
    return path.join(userStateRoot(env), "workspaces", key);
}
export async function resolveStateFile(cwd, env = process.env) {
    return path.join(await resolveStateDir(cwd, env), "state.json");
}
export async function prepareConfigurationStorage(cwd, env = process.env, options = {}) {
    const destinationDir = await resolveStateDir(cwd, env);
    const result = {
        directory: destinationDir,
        modelConfigurationFile: path.join(destinationDir, "model.json"),
        stateFile: path.join(destinationDir, "state.json"),
        migrationStatus: "none",
    };
    if (options.migrate !== true) {
        const pending = await findMigrationSources(cwd, env, destinationDir);
        if (pending.length > 1)
            return { ...result, migrationStatus: "conflict" };
        if (pending.length === 1 && !(await fs.stat(destinationDir).catch(() => undefined))) {
            const source = pending[0];
            if (await migrationSourceHasActiveJobs(source)) {
                return { ...result, migrationStatus: "blocked", migratedFrom: source };
            }
            return { ...result, migrationStatus: "pending", migratedFrom: source };
        }
        if (pending.length === 1) {
            return { ...result, migrationStatus: "conflict", migratedFrom: pending[0] };
        }
        return result;
    }
    if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR || !(await resolveGitCommonDir(cwd)))
        return result;
    const currentLegacyMigrated = await migrateCurrentStateDirectory(cwd, env);
    if (currentLegacyMigrated)
        return {
            ...result,
            migrationStatus: "migrated",
            migratedFrom: path.join(await resolveWorkspaceRoot(cwd), ".swarm-pi-code-plugin"),
        };
    const existing = await findMigrationSources(cwd, env, destinationDir);
    if (existing.length > 1)
        throw new StateMigrationAmbiguousError(existing);
    if (!existing.length)
        return result;
    result.migrationStatus = "pending";
    if (await fs.stat(destinationDir).catch(() => undefined))
        throw new StateMigrationConflictError(existing[0], destinationDir);
    const sourceDir = existing[0];
    const parent = path.dirname(destinationDir);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const lockFiles = [
        path.join(parent, `${path.basename(destinationDir)}.migration.lock`),
        path.join(path.dirname(sourceDir), `${path.basename(sourceDir)}.migration.lock`),
    ];
    const locks = [];
    try {
        for (const lockFile of [...new Set(lockFiles)].sort()) {
            locks.push({ file: lockFile, handle: await acquireFileLock(lockFile) });
        }
        if (await fs.stat(destinationDir).catch(() => undefined))
            throw new StateMigrationConflictError(sourceDir, destinationDir);
        let sourceState;
        try {
            sourceState = await readJson(path.join(sourceDir, "state.json"));
        }
        catch (error) {
            throw new StateMigrationError(sourceDir, destinationDir, error);
        }
        if (sourceState) {
            const jobs = Array.isArray(sourceState.jobs) ? sourceState.jobs : [];
            if (jobs.some((job) => !isTerminalMigrationJob(job)))
                throw new StateMigrationActiveJobsError(sourceDir);
        }
        await writeMigrationProvenance(sourceDir, "user-state-workspace");
        try {
            await fs.rename(sourceDir, destinationDir);
        }
        catch (error) {
            if (error.code !== "EXDEV")
                throw new StateMigrationError(sourceDir, destinationDir, error);
            const staging = path.join(parent, `.${path.basename(destinationDir)}.migration-${randomUUID()}`);
            try {
                await fs.cp(sourceDir, staging, {
                    recursive: true,
                    errorOnExist: true,
                    preserveTimestamps: true,
                });
                await validateStateTree(sourceDir, staging);
                await fs.rename(staging, destinationDir);
                await fs.rm(sourceDir, { recursive: true, force: true });
            }
            catch (copyError) {
                await fs.rm(staging, { recursive: true, force: true });
                throw new StateMigrationError(sourceDir, destinationDir, copyError);
            }
        }
        return {
            ...result,
            migrationStatus: "migrated",
            migratedFrom: sourceDir,
        };
    }
    finally {
        for (const lock of locks.reverse()) {
            await lock.handle.close();
            await fs.rm(lock.file, { force: true });
        }
    }
}
async function findMigrationSources(cwd, env, destinationDir) {
    if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR || !(await resolveGitCommonDir(cwd)))
        return [];
    const workspace = await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
    const root = await resolveWorkspaceRoot(cwd);
    const candidates = [...new Set([workspace, root])].map((directory) => {
        const key = createHash("sha256").update(directory).digest("hex");
        return path.join(userStateRoot(env), "workspaces", key);
    });
    const existing = [];
    for (const candidate of candidates) {
        if (path.resolve(candidate) === path.resolve(destinationDir))
            continue;
        if ((await fs.stat(candidate).catch(() => undefined))?.isDirectory())
            existing.push(candidate);
    }
    return existing;
}
async function migrationSourceHasActiveJobs(sourceDir) {
    try {
        const state = await readJson(path.join(sourceDir, "state.json"));
        const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
        return jobs.some((job) => !isTerminalMigrationJob(job));
    }
    catch {
        // A source that cannot be read is unsafe to move; status must fail closed without mutating it.
        return true;
    }
}
function isTerminalMigrationJob(job) {
    if (!job || typeof job !== "object")
        return true;
    const status = job.status;
    return (typeof status === "string" &&
        [
            "succeeded",
            "failed",
            "cancelled",
            "timed-out",
            "orphaned",
            "not-implemented",
            "completed",
            "rejected",
        ].includes(status));
}
export async function loadState(cwd, options = {}) {
    const env = options.env ?? process.env;
    if (options.migrateLegacy !== false)
        await migrateCurrentStateDirectory(cwd, env);
    const current = await readJson(await resolveStateFile(cwd, env));
    if (current)
        return normalizeState(current);
    if (options.migrateLegacy !== false) {
        const migrated = await readLegacyState(cwd);
        if (migrated) {
            await writeState(cwd, migrated, env);
            return migrated;
        }
    }
    return defaultState();
}
export async function migrateCurrentStateDirectory(cwd, env = process.env) {
    if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR)
        return false;
    const workspace = await resolveWorkspaceRoot(cwd);
    const legacyDir = path.join(workspace, ".swarm-pi-code-plugin");
    const destinationDir = await resolveStateDir(cwd, env);
    if (path.resolve(legacyDir) === path.resolve(destinationDir))
        return false;
    const legacy = await fs.stat(legacyDir).catch(() => undefined);
    if (!legacy?.isDirectory())
        return false;
    const parent = path.dirname(destinationDir);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const lock = path.join(parent, `${path.basename(destinationDir)}.migration.lock`);
    const handle = await acquireFileLock(lock);
    try {
        const lockedLegacy = await fs.stat(legacyDir).catch(() => undefined);
        if (!lockedLegacy?.isDirectory())
            return false;
        const destination = await fs.stat(destinationDir).catch(() => undefined);
        if (destination)
            throw new StateMigrationConflictError(legacyDir, destinationDir);
        if (await migrationSourceHasActiveJobs(legacyDir))
            throw new StateMigrationActiveJobsError(legacyDir);
        await writeMigrationProvenance(legacyDir, ".swarm-pi-code-plugin");
        try {
            await fs.rename(legacyDir, destinationDir);
        }
        catch (error) {
            if (error.code !== "EXDEV")
                throw error;
            const staging = path.join(parent, `.${path.basename(destinationDir)}.migration-${randomUUID()}`);
            try {
                await fs.cp(legacyDir, staging, {
                    recursive: true,
                    errorOnExist: true,
                    preserveTimestamps: true,
                });
                await validateStateTree(legacyDir, staging);
                await fs.rename(staging, destinationDir);
                await fs.rm(legacyDir, { recursive: true, force: true });
            }
            catch (copyError) {
                await fs.rm(staging, { recursive: true, force: true });
                throw copyError;
            }
        }
        return true;
    }
    finally {
        await handle.close();
        await fs.rm(lock, { force: true });
    }
}
export async function writeState(cwd, state, env = process.env) {
    const stateFile = await resolveStateFile(cwd, env);
    await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(tempFile, stateFile);
    }
    finally {
        await fs.rm(tempFile, { force: true });
    }
}
export async function updateState(cwd, update, env = process.env) {
    return withStateLock(cwd, async () => {
        const state = structuredClone(await loadState(cwd, { env }));
        const updated = update(state) ?? state;
        await writeState(cwd, updated, env);
        return updated;
    }, env);
}
export async function setModelPriority(cwd, models, env = process.env) {
    return updateState(cwd, (state) => {
        state.config.modelPriority = [...models];
    }, env);
}
export async function setAvailableModels(cwd, models) {
    return updateState(cwd, (state) => {
        state.config.availableModels = [...models];
        state.config.availableModelsCheckedAt = new Date().toISOString();
    });
}
export async function saveProfile(cwd, profile) {
    return updateState(cwd, (state) => {
        state.config.profile = {
            ...profile,
            configuredAt: profile.configuredAt ?? new Date().toISOString(),
        };
    });
}
export async function saveProjectSettings(cwd, profile, sandboxMode, execution, env = process.env) {
    return updateState(cwd, (state) => {
        state.config.profile = {
            ...profile,
            configuredAt: profile.configuredAt ?? new Date().toISOString(),
        };
        state.config.sandboxMode = sandboxMode;
        if (execution?.rolePolicies)
            state.config.rolePolicies = structuredClone(execution.rolePolicies);
        if (execution?.adaptivePolicy)
            state.config.adaptivePolicy = normalizeAdaptivePolicy(execution.adaptivePolicy);
        if (execution?.backgroundRolePolicy) {
            state.config.backgroundRolePolicy = {
                mechanicalExecutor: execution.backgroundRolePolicy.mechanicalExecutor === true,
            };
        }
        applyWorkflowSettings(state.config, execution);
    }, env);
}
export async function setSandboxMode(cwd, sandboxMode) {
    return updateState(cwd, (state) => {
        state.config.sandboxMode = sandboxMode;
    });
}
export async function saveExecutionSettings(cwd, sandboxMode, execution, env = process.env) {
    return updateState(cwd, (state) => {
        state.config.sandboxMode = sandboxMode;
        state.config.rolePolicies = structuredClone(execution.rolePolicies ?? {});
        state.config.adaptivePolicy = normalizeAdaptivePolicy(execution.adaptivePolicy);
        state.config.backgroundRolePolicy = {
            mechanicalExecutor: execution.backgroundRolePolicy?.mechanicalExecutor === true,
        };
        applyWorkflowSettings(state.config, execution);
    }, env);
}
function applyWorkflowSettings(config, settings) {
    if (!settings)
        return;
    if (settings.decisionMode)
        config.decisionMode = settings.decisionMode;
    if (settings.hostAssistance)
        config.hostAssistance = normalizeHostAssistancePolicy(settings.hostAssistance);
    if (settings.contextBudget !== undefined)
        config.contextBudget = Math.min(WORKFLOW_BOUNDS.contextBudget.max, Math.max(WORKFLOW_BOUNDS.contextBudget.min, Math.trunc(settings.contextBudget)));
    if (settings.advisor)
        config.advisor = normalizeAdvisorPolicy(settings.advisor);
    if (settings.hostActions)
        config.hostActions = normalizeHostActionPolicy(settings.hostActions);
    if (settings.doctrine === "first-principles-qds-v1")
        config.doctrine = settings.doctrine;
    else if (settings.doctrine === null)
        delete config.doctrine;
}
export async function clearConfiguration(cwd, env = process.env) {
    return updateState(cwd, (state) => {
        state.config = {
            modelPriority: [],
            availableModels: [],
            availableModelsCheckedAt: null,
            sandboxMode: "adaptive",
            rolePolicies: {},
            adaptivePolicy: structuredClone(DEFAULT_ADAPTIVE_POLICY),
            backgroundRolePolicy: structuredClone(DEFAULT_BACKGROUND_ROLE_POLICY),
            decisionMode: "balance",
            hostAssistance: defaultHostAssistancePolicy(),
            contextBudget: 4,
            advisor: defaultAdvisorPolicy(),
            hostActions: defaultHostActionPolicy(),
        };
    }, env);
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
                ...(Object.hasOwn(legacyProfile, "dirs") ? { dirs: stringArray(legacyProfile.dirs) } : {}),
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
async function writeMigrationProvenance(directory, source) {
    const stateFile = path.join(directory, "state.json");
    const current = await readJson(stateFile);
    if (!current)
        return;
    current.migration = { source, migratedAt: new Date().toISOString() };
    await writeJsonAtomic(stateFile, current);
}
async function validateStateTree(source, destination) {
    const sourceEntries = await fs.readdir(source, { withFileTypes: true });
    const destinationEntries = await fs.readdir(destination, { withFileTypes: true });
    const sourceNames = sourceEntries.map((entry) => entry.name).sort();
    const destinationNames = destinationEntries.map((entry) => entry.name).sort();
    if (JSON.stringify(sourceNames) !== JSON.stringify(destinationNames)) {
        throw new Error("Migrated state tree failed entry validation");
    }
    for (const entry of sourceEntries) {
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            if (!(await fs.lstat(destinationPath)).isDirectory())
                throw new Error(`Migrated state entry is not a directory: ${entry.name}`);
            await validateStateTree(sourcePath, destinationPath);
            continue;
        }
        if (entry.isSymbolicLink()) {
            const [sourceTarget, destinationTarget] = await Promise.all([
                fs.readlink(sourcePath),
                fs.readlink(destinationPath),
            ]);
            if (sourceTarget !== destinationTarget)
                throw new Error(`Migrated state symlink failed validation: ${entry.name}`);
            continue;
        }
        const [sourceStat, destinationStat] = await Promise.all([
            fs.stat(sourcePath),
            fs.stat(destinationPath),
        ]);
        if (!destinationStat.isFile() || sourceStat.size !== destinationStat.size)
            throw new Error(`Migrated state file failed validation: ${entry.name}`);
    }
}
function normalizeState(value) {
    const config = asRecord(value.config);
    const profile = asRecord(config.profile);
    const state = defaultState();
    state.config.modelPriority = stringArray(config.modelPriority);
    state.config.availableModels = stringArray(config.availableModels);
    state.config.availableModelsCheckedAt = stringValue(config.availableModelsCheckedAt) ?? null;
    state.config.sandboxMode = sandboxModeValue(config.sandboxMode);
    state.config.rolePolicies = rolePolicyOverrides(config.rolePolicies);
    state.config.adaptivePolicy = normalizeAdaptivePolicy(asRecord(config.adaptivePolicy));
    const background = asRecord(config.backgroundRolePolicy);
    state.config.backgroundRolePolicy = {
        mechanicalExecutor: background.mechanicalExecutor === true,
    };
    const decisionMode = config.decisionMode;
    state.config.decisionMode =
        decisionMode === "cost" || decisionMode === "power" ? decisionMode : "balance";
    state.config.hostAssistance = normalizeHostAssistancePolicy(config.hostAssistance);
    state.config.contextBudget = Number.isInteger(config.contextBudget)
        ? Math.min(64, Math.max(0, config.contextBudget))
        : 4;
    state.config.advisor = normalizeAdvisorPolicy(config.advisor);
    state.config.hostActions = normalizeHostActionPolicy(config.hostActions);
    if (config.doctrine === "first-principles-qds-v1")
        state.config.doctrine = config.doctrine;
    if (Object.keys(profile).length > 0) {
        state.config.profile = {
            goal: stringValue(profile.goal),
            ...(Object.hasOwn(profile, "dirs") ? { dirs: stringArray(profile.dirs) } : {}),
            tasks: stringArray(profile.tasks),
            configuredAt: stringValue(profile.configuredAt),
        };
    }
    state.jobs = Array.isArray(value.jobs)
        ? value.jobs.filter((job) => typeof job === "object" && job !== null && typeof job.id === "string")
        : [];
    const migration = asRecord(value.migration);
    if ((migration.source === ".swarm-pi-code-plugin" ||
        migration.source === ".swarm-pi-code" ||
        migration.source === ".swarm-code" ||
        migration.source === "user-state-workspace") &&
        typeof migration.migratedAt === "string") {
        state.migration = { source: migration.source, migratedAt: migration.migratedAt };
    }
    return state;
}
function normalizeHostAssistancePolicy(value) {
    const defaults = defaultHostAssistancePolicy();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
            ...defaults,
            reviewMode: "user-only",
            autoApprovalScope: "context-only",
            autoApproveDiscoveryGates: false,
        };
    }
    const candidate = value;
    const mode = candidate.mode === "off" || candidate.mode === "inherit" ? candidate.mode : "on";
    const maxRequests = Number.isInteger(candidate.maxRequests)
        ? Math.min(WORKFLOW_BOUNDS.hostAssistance.requests.max, Math.max(WORKFLOW_BOUNDS.hostAssistance.requests.min, candidate.maxRequests))
        : defaults.maxRequests;
    const maxFanOut = Number.isInteger(candidate.maxFanOut)
        ? Math.min(maxRequests, WORKFLOW_BOUNDS.hostAssistance.fanOut.max, Math.max(WORKFLOW_BOUNDS.hostAssistance.fanOut.min, candidate.maxFanOut))
        : Math.min(defaults.maxFanOut, maxRequests);
    return {
        enabled: mode === "off" ? false : candidate.enabled !== false,
        mode,
        contextClasses: Array.isArray(candidate.contextClasses)
            ? candidate.contextClasses.filter((item) => ["workspace", "web", "docs", "paper", "connector", "skill"].includes(item))
            : defaults.contextClasses,
        privateConnector: candidate.privateConnector === "deny" ? "deny" : "ask",
        maxRequests,
        maxFanOut,
        reviewMode: candidate.reviewMode === "host-first" ? "host-first" : "user-only",
        autoApprovalScope: candidate.autoApprovalScope === "read-only" || candidate.autoApprovalScope === "reversible"
            ? candidate.autoApprovalScope
            : "context-only",
        autoApproveDiscoveryGates: candidate.autoApproveDiscoveryGates === true,
    };
}
function normalizeAdvisorPolicy(value) {
    const defaults = defaultAdvisorPolicy();
    if (!value || typeof value !== "object" || Array.isArray(value))
        return defaults;
    const candidate = value;
    return {
        enabled: candidate.enabled === true,
        targets: Array.isArray(candidate.targets)
            ? candidate.targets.filter((item) => [
                "ask",
                "review",
                "plan",
                "implement",
                "orchestrate",
                "scaffold",
                "setup",
                "discover",
            ].includes(item))
            : defaults.targets,
        maxRequests: Number.isInteger(candidate.maxRequests)
            ? Math.min(WORKFLOW_BOUNDS.advisor.requests.max, Math.max(WORKFLOW_BOUNDS.advisor.requests.min, candidate.maxRequests))
            : defaults.maxRequests,
        maxPerspectives: Number.isInteger(candidate.maxPerspectives)
            ? Math.min(WORKFLOW_BOUNDS.advisor.perspectives.max, Math.max(WORKFLOW_BOUNDS.advisor.perspectives.min, candidate.maxPerspectives))
            : defaults.maxPerspectives,
    };
}
export function defaultHostActionPolicy() {
    return {
        enabled: true,
        allowedActionClasses: ["local-mutation", "draft"],
        remoteActionsEnabled: false,
        maxUses: 1,
        maxCost: 1,
        ttlMs: 30 * 60_000,
    };
}
function normalizeHostActionPolicy(value) {
    const defaults = defaultHostActionPolicy();
    if (!value || typeof value !== "object" || Array.isArray(value))
        return defaults;
    const candidate = value;
    const classes = Array.isArray(candidate.allowedActionClasses)
        ? candidate.allowedActionClasses.filter((item) => ["local-mutation", "draft", "remote-write", "message", "deploy", "transaction"].includes(item))
        : defaults.allowedActionClasses;
    return {
        enabled: candidate.enabled !== false,
        allowedActionClasses: classes,
        remoteActionsEnabled: candidate.remoteActionsEnabled === true,
        maxUses: Number.isInteger(candidate.maxUses)
            ? Math.min(100, Math.max(1, candidate.maxUses))
            : defaults.maxUses,
        maxCost: typeof candidate.maxCost === "number" && Number.isFinite(candidate.maxCost)
            ? Math.max(0, candidate.maxCost)
            : defaults.maxCost,
        ttlMs: Number.isInteger(candidate.ttlMs)
            ? Math.min(24 * 60 * 60_000, Math.max(60_000, candidate.ttlMs))
            : defaults.ttlMs,
    };
}
async function resolveGitCommonDir(cwd) {
    try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
        return await fs.realpath(stdout.trim());
    }
    catch {
        return undefined;
    }
}
function userStateRoot(env) {
    if (env.SWARM_PI_CODE_PLUGIN_USER_STATE_DIR)
        return path.resolve(env.SWARM_PI_CODE_PLUGIN_USER_STATE_DIR);
    if (process.platform === "darwin")
        return path.join(os.homedir(), "Library", "Application Support", "swarm-pi-code-plugin");
    if (process.platform === "win32")
        return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "swarm-pi-code-plugin");
    return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "swarm-pi-code-plugin");
}
async function writeJsonAtomic(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
async function acquireFileLock(file) {
    const deadline = Date.now() + 5_000;
    while (true) {
        try {
            return await fs.open(file, "wx", 0o600);
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const existing = await fs.stat(file).catch(() => undefined);
            if (existing && Date.now() - existing.mtimeMs > 30_000) {
                await fs.rm(file, { force: true });
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out waiting for migration lock: ${file}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
}
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function sandboxModeValue(value) {
    return value === "adaptive" || value === "lenient" ? value : "strict";
}
function rolePolicyOverrides(value) {
    const record = asRecord(value);
    const result = {};
    for (const [key, raw] of Object.entries(record)) {
        if (!isWorkerRole(key))
            continue;
        const candidate = asRecord(raw);
        result[key] = {
            ...(stringArray(candidate.models).length ? { models: stringArray(candidate.models) } : {}),
            ...(typeof candidate.thinkingLevel === "string"
                ? { thinkingLevel: candidate.thinkingLevel }
                : {}),
            ...(typeof candidate.maxAttempts === "number" ? { maxAttempts: candidate.maxAttempts } : {}),
        };
    }
    return result;
}
async function withStateLock(cwd, run, env = process.env) {
    const directory = await resolveStateDir(cwd, env);
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
