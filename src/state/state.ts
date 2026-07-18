import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AdaptivePolicyConfig,
  ApprovalRequest,
  BackgroundRolePolicy,
  CapabilityLease,
  ExecutionMode,
  Host,
  JobNotification,
  JobPhase,
  JobStatus,
  NotificationStatus,
  SandboxMode,
  TaskKind,
  WorkerRoleId,
  AdvisorPolicy,
  DecisionMode,
  HostAssistancePolicy,
  HostAssistanceRequestSummary,
  HostActionPolicy,
  DoctrineId,
} from "../core/contracts.js";
import { ProcessLocalQueue } from "./process-queue.js";
import {
  DEFAULT_ADAPTIVE_POLICY,
  DEFAULT_BACKGROUND_ROLE_POLICY,
  isWorkerRole,
  normalizeAdaptivePolicy,
  defaultAdvisorPolicy,
  defaultHostAssistancePolicy,
  WORKFLOW_BOUNDS,
  type RolePolicyOverrides,
} from "../orchestration/roles.js";

const execFileAsync = promisify(execFile);
const stateUpdateQueue = new ProcessLocalQueue();

export interface SwarmProfile {
  goal?: string | undefined;
  dirs?: string[] | undefined;
  tasks?: string[] | undefined;
  configuredAt?: string | undefined;
}

export interface SwarmConfig {
  modelPriority: string[];
  availableModels: string[];
  availableModelsCheckedAt: string | null;
  sandboxMode?: SandboxMode;
  rolePolicies?: RolePolicyOverrides;
  adaptivePolicy?: AdaptivePolicyConfig;
  backgroundRolePolicy?: BackgroundRolePolicy;
  profile?: SwarmProfile;
  decisionMode?: DecisionMode;
  hostAssistance?: HostAssistancePolicy;
  contextBudget?: number;
  advisor?: AdvisorPolicy;
  doctrine?: "first-principles-qds-v1";
  hostActions?: HostActionPolicy;
}

export interface WorkflowSettings {
  decisionMode?: DecisionMode;
  hostAssistance?: HostAssistancePolicy;
  contextBudget?: number;
  advisor?: AdvisorPolicy;
  doctrine?: DoctrineId | null;
  hostActions?: HostActionPolicy;
}

export interface JobRecord {
  id: string;
  status: JobStatus | string;
  host?: Host;
  kind?: TaskKind;
  executionMode?: ExecutionMode;
  sandboxMode?: SandboxMode;
  timeoutMs?: number;
  model?: string;
  pid?: number;
  workerToken?: string;
  role?: WorkerRoleId;
  policyHash?: string;
  parentPolicyHash?: string;
  scopeHash?: string;
  generation?: number;
  pendingApprovalId?: string;
  pendingHostRequestIds?: string[];
  hostAssistanceRequests?: HostAssistanceRequestSummary[];
  approvals?: ApprovalRequest[];
  leases?: CapabilityLease[];
  notifications?: JobNotification[];
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  notification?: NotificationStatus;
  phase?: JobPhase;
  progressMessage?: string;
  lastProgressAt?: string;
  [key: string]: unknown;
}

export interface SwarmState {
  version: 1;
  config: SwarmConfig;
  jobs: JobRecord[];
  migration?: {
    source: ".swarm-pi-code-plugin" | ".swarm-pi-code" | ".swarm-code" | "user-state-workspace";
    migratedAt: string;
  };
}

export type MigrationStatus = "none" | "pending" | "migrated" | "conflict" | "blocked";

export interface ConfigurationStorage {
  directory: string;
  modelConfigurationFile: string;
  stateFile: string;
  migrationStatus: MigrationStatus;
  migratedFrom?: string;
}

export interface StoragePreparationResult extends ConfigurationStorage {
  migrationStatus: MigrationStatus;
  migratedFrom?: string;
}

export class StateMigrationConflictError extends Error {
  constructor(
    readonly legacyDir: string,
    readonly destinationDir: string,
  ) {
    super(`Runtime state exists in both ${legacyDir} and ${destinationDir}`);
    this.name = "StateMigrationConflictError";
  }
}

export class StateMigrationActiveJobsError extends Error {
  constructor(readonly sourceDir: string) {
    super(`Runtime state migration is blocked by active jobs in ${sourceDir}`);
    this.name = "StateMigrationActiveJobsError";
  }
}

export class StateMigrationAmbiguousError extends Error {
  constructor(readonly sources: string[]) {
    super(`Runtime state migration has multiple possible sources: ${sources.join(", ")}`);
    this.name = "StateMigrationAmbiguousError";
  }
}

export class StateMigrationError extends Error {
  constructor(
    readonly sourceDir: string,
    readonly destinationDir: string,
    cause: unknown,
  ) {
    super(`Runtime state migration failed from ${sourceDir} to ${destinationDir}`, { cause });
    this.name = "StateMigrationError";
  }
}

export function defaultState(): SwarmState {
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

export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    return await fs.realpath(stdout.trim());
  } catch {
    return path.resolve(cwd);
  }
}

export async function resolveSharedWorkspaceRoot(cwd: string): Promise<string> {
  const workspace = await resolveWorkspaceRoot(cwd);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: workspace, encoding: "utf8" },
    );
    const commonDir = await fs.realpath(stdout.trim());
    return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : workspace;
  } catch {
    return workspace;
  }
}

export async function resolveStateDir(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR) {
    return path.resolve(cwd, env.SWARM_PI_CODE_PLUGIN_DATA_DIR);
  }
  const commonDir = await resolveGitCommonDir(cwd);
  if (commonDir) return path.join(commonDir, "swarm-pi-code-plugin");
  const workspace = await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
  const key = createHash("sha256").update(workspace).digest("hex");
  return path.join(userStateRoot(env), "workspaces", key);
}

export async function resolveStateFile(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return path.join(await resolveStateDir(cwd, env), "state.json");
}

export async function prepareConfigurationStorage(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { migrate?: boolean } = {},
): Promise<StoragePreparationResult> {
  const destinationDir = await resolveStateDir(cwd, env);
  const result: StoragePreparationResult = {
    directory: destinationDir,
    modelConfigurationFile: path.join(destinationDir, "model.json"),
    stateFile: path.join(destinationDir, "state.json"),
    migrationStatus: "none" as MigrationStatus,
  };
  if (options.migrate !== true) {
    const pending = await findMigrationSources(cwd, env, destinationDir);
    if (pending.length > 1) return { ...result, migrationStatus: "conflict" };
    if (pending.length === 1 && !(await fs.stat(destinationDir).catch(() => undefined))) {
      const source = pending[0]!;
      if (await migrationSourceHasActiveJobs(source)) {
        return { ...result, migrationStatus: "blocked", migratedFrom: source };
      }
      return { ...result, migrationStatus: "pending", migratedFrom: source };
    }
    if (pending.length === 1) {
      return { ...result, migrationStatus: "conflict", migratedFrom: pending[0]! };
    }
    return result;
  }
  if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR || !(await resolveGitCommonDir(cwd))) return result;
  const currentLegacyMigrated = await migrateCurrentStateDirectory(cwd, env);
  if (currentLegacyMigrated)
    return {
      ...result,
      migrationStatus: "migrated",
      migratedFrom: path.join(await resolveWorkspaceRoot(cwd), ".swarm-pi-code-plugin"),
    };
  const existing = await findMigrationSources(cwd, env, destinationDir);
  if (existing.length > 1) throw new StateMigrationAmbiguousError(existing);
  if (!existing.length) return result;
  result.migrationStatus = "pending";
  if (await fs.stat(destinationDir).catch(() => undefined))
    throw new StateMigrationConflictError(existing[0]!, destinationDir);
  const sourceDir = existing[0]!;
  const parent = path.dirname(destinationDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const lockFiles = [
    path.join(parent, `${path.basename(destinationDir)}.migration.lock`),
    path.join(path.dirname(sourceDir), `${path.basename(sourceDir)}.migration.lock`),
  ];
  const locks: Array<{
    file: string;
    handle: Awaited<ReturnType<typeof fs.open>>;
  }> = [];
  try {
    for (const lockFile of [...new Set(lockFiles)].sort()) {
      locks.push({ file: lockFile, handle: await acquireFileLock(lockFile) });
    }
    if (await fs.stat(destinationDir).catch(() => undefined))
      throw new StateMigrationConflictError(sourceDir, destinationDir);
    let sourceState: Record<string, unknown> | undefined;
    try {
      sourceState = await readJson(path.join(sourceDir, "state.json"));
    } catch (error) {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV")
        throw new StateMigrationError(sourceDir, destinationDir, error);
      const staging = path.join(
        parent,
        `.${path.basename(destinationDir)}.migration-${randomUUID()}`,
      );
      try {
        await fs.cp(sourceDir, staging, {
          recursive: true,
          errorOnExist: true,
          preserveTimestamps: true,
        });
        await validateStateTree(sourceDir, staging);
        await fs.rename(staging, destinationDir);
        await fs.rm(sourceDir, { recursive: true, force: true });
      } catch (copyError) {
        await fs.rm(staging, { recursive: true, force: true });
        throw new StateMigrationError(sourceDir, destinationDir, copyError);
      }
    }
    return {
      ...result,
      migrationStatus: "migrated",
      migratedFrom: sourceDir,
    };
  } finally {
    for (const lock of locks.reverse()) {
      await lock.handle.close();
      await fs.rm(lock.file, { force: true });
    }
  }
}

async function findMigrationSources(
  cwd: string,
  env: NodeJS.ProcessEnv,
  destinationDir: string,
): Promise<string[]> {
  if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR || !(await resolveGitCommonDir(cwd))) return [];
  const workspace = await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
  const root = await resolveWorkspaceRoot(cwd);
  const candidates = [...new Set([workspace, root])].map((directory) => {
    const key = createHash("sha256").update(directory).digest("hex");
    return path.join(userStateRoot(env), "workspaces", key);
  });
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(destinationDir)) continue;
    if ((await fs.stat(candidate).catch(() => undefined))?.isDirectory()) existing.push(candidate);
  }
  return existing;
}
async function migrationSourceHasActiveJobs(sourceDir: string): Promise<boolean> {
  try {
    const state = await readJson(path.join(sourceDir, "state.json"));
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    return jobs.some((job) => !isTerminalMigrationJob(job));
  } catch {
    // A source that cannot be read is unsafe to move; status must fail closed without mutating it.
    return true;
  }
}

function isTerminalMigrationJob(job: unknown): boolean {
  if (!job || typeof job !== "object") return true;
  const status = (job as { status?: unknown }).status;
  return (
    typeof status === "string" &&
    [
      "succeeded",
      "failed",
      "cancelled",
      "timed-out",
      "orphaned",
      "not-implemented",
      "completed",
      "rejected",
    ].includes(status)
  );
}

export async function loadState(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; migrateLegacy?: boolean } = {},
): Promise<SwarmState> {
  const env = options.env ?? process.env;
  if (options.migrateLegacy !== false) await migrateCurrentStateDirectory(cwd, env);
  const current = await readJson(await resolveStateFile(cwd, env));
  if (current) return normalizeState(current);
  if (options.migrateLegacy !== false) {
    const migrated = await readLegacyState(cwd);
    if (migrated) {
      await writeState(cwd, migrated, env);
      return migrated;
    }
  }
  return defaultState();
}

export async function migrateCurrentStateDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.SWARM_PI_CODE_PLUGIN_DATA_DIR) return false;
  const workspace = await resolveWorkspaceRoot(cwd);
  const legacyDir = path.join(workspace, ".swarm-pi-code-plugin");
  const destinationDir = await resolveStateDir(cwd, env);
  if (path.resolve(legacyDir) === path.resolve(destinationDir)) return false;
  const legacy = await fs.stat(legacyDir).catch(() => undefined);
  if (!legacy?.isDirectory()) return false;
  const parent = path.dirname(destinationDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const lock = path.join(parent, `${path.basename(destinationDir)}.migration.lock`);
  const handle = await acquireFileLock(lock);
  try {
    const lockedLegacy = await fs.stat(legacyDir).catch(() => undefined);
    if (!lockedLegacy?.isDirectory()) return false;
    const destination = await fs.stat(destinationDir).catch(() => undefined);
    if (destination) throw new StateMigrationConflictError(legacyDir, destinationDir);
    if (await migrationSourceHasActiveJobs(legacyDir))
      throw new StateMigrationActiveJobsError(legacyDir);
    await writeMigrationProvenance(legacyDir, ".swarm-pi-code-plugin");
    try {
      await fs.rename(legacyDir, destinationDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      const staging = path.join(
        parent,
        `.${path.basename(destinationDir)}.migration-${randomUUID()}`,
      );
      try {
        await fs.cp(legacyDir, staging, {
          recursive: true,
          errorOnExist: true,
          preserveTimestamps: true,
        });
        await validateStateTree(legacyDir, staging);
        await fs.rename(staging, destinationDir);
        await fs.rm(legacyDir, { recursive: true, force: true });
      } catch (copyError) {
        await fs.rm(staging, { recursive: true, force: true });
        throw copyError;
      }
    }
    return true;
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

export async function writeState(
  cwd: string,
  state: SwarmState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const stateFile = await resolveStateFile(cwd, env);
  await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempFile, stateFile);
  } finally {
    await fs.rm(tempFile, { force: true });
  }
}

export async function updateState(
  cwd: string,
  update: (state: SwarmState) => SwarmState | void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmState> {
  return withStateLock(
    cwd,
    async () => {
      const state = structuredClone(await loadState(cwd, { env }));
      const updated = update(state) ?? state;
      await writeState(cwd, updated, env);
      return updated;
    },
    env,
  );
}

export async function setModelPriority(
  cwd: string,
  models: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmState> {
  return updateState(
    cwd,
    (state) => {
      state.config.modelPriority = [...models];
    },
    env,
  );
}

export async function setAvailableModels(cwd: string, models: string[]): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.availableModels = [...models];
    state.config.availableModelsCheckedAt = new Date().toISOString();
  });
}

export async function saveProfile(cwd: string, profile: SwarmProfile): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.profile = {
      ...profile,
      configuredAt: profile.configuredAt ?? new Date().toISOString(),
    };
  });
}

export async function saveProjectSettings(
  cwd: string,
  profile: SwarmProfile,
  sandboxMode: SandboxMode,
  execution?: {
    rolePolicies?: RolePolicyOverrides;
    adaptivePolicy?: AdaptivePolicyConfig;
    backgroundRolePolicy?: BackgroundRolePolicy;
  } & WorkflowSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmState> {
  return updateState(
    cwd,
    (state) => {
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
    },
    env,
  );
}

export async function setSandboxMode(cwd: string, sandboxMode: SandboxMode): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.sandboxMode = sandboxMode;
  });
}

export async function saveExecutionSettings(
  cwd: string,
  sandboxMode: SandboxMode,
  execution: {
    rolePolicies?: RolePolicyOverrides;
    adaptivePolicy?: AdaptivePolicyConfig;
    backgroundRolePolicy?: BackgroundRolePolicy;
  } & WorkflowSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmState> {
  return updateState(
    cwd,
    (state) => {
      state.config.sandboxMode = sandboxMode;
      state.config.rolePolicies = structuredClone(execution.rolePolicies ?? {});
      state.config.adaptivePolicy = normalizeAdaptivePolicy(execution.adaptivePolicy);
      state.config.backgroundRolePolicy = {
        mechanicalExecutor: execution.backgroundRolePolicy?.mechanicalExecutor === true,
      };
      applyWorkflowSettings(state.config, execution);
    },
    env,
  );
}

function applyWorkflowSettings(config: SwarmConfig, settings: WorkflowSettings | undefined): void {
  if (!settings) return;
  if (settings.decisionMode) config.decisionMode = settings.decisionMode;
  if (settings.hostAssistance)
    config.hostAssistance = normalizeHostAssistancePolicy(settings.hostAssistance);
  if (settings.contextBudget !== undefined)
    config.contextBudget = Math.min(
      WORKFLOW_BOUNDS.contextBudget.max,
      Math.max(WORKFLOW_BOUNDS.contextBudget.min, Math.trunc(settings.contextBudget)),
    );
  if (settings.advisor) config.advisor = normalizeAdvisorPolicy(settings.advisor);
  if (settings.hostActions) config.hostActions = normalizeHostActionPolicy(settings.hostActions);
  if (settings.doctrine === "first-principles-qds-v1") config.doctrine = settings.doctrine;
  else if (settings.doctrine === null) delete config.doctrine;
}

export async function clearConfiguration(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SwarmState> {
  return updateState(
    cwd,
    (state) => {
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
    },
    env,
  );
}

async function readLegacyState(cwd: string): Promise<SwarmState | undefined> {
  const sharedRoot = await resolveSharedWorkspaceRoot(cwd);
  const workspaceRoot = await resolveWorkspaceRoot(cwd);
  const previousPiCandidates = new Set([
    path.join(sharedRoot, ".swarm-pi-code", "state.json"),
    path.join(workspaceRoot, ".swarm-pi-code", "state.json"),
  ]);
  for (const candidate of previousPiCandidates) {
    const previous = await readJson(candidate);
    if (!previous) continue;
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
    if (!legacy) continue;
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

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeMigrationProvenance(
  directory: string,
  source: ".swarm-pi-code-plugin" | "user-state-workspace",
): Promise<void> {
  const stateFile = path.join(directory, "state.json");
  const current = await readJson(stateFile);
  if (!current) return;
  current.migration = { source, migratedAt: new Date().toISOString() };
  await writeJsonAtomic(stateFile, current);
}

async function validateStateTree(source: string, destination: string): Promise<void> {
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

function normalizeState(value: Record<string, unknown>): SwarmState {
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
    ? Math.min(64, Math.max(0, config.contextBudget as number))
    : 4;
  state.config.advisor = normalizeAdvisorPolicy(config.advisor);
  state.config.hostActions = normalizeHostActionPolicy(config.hostActions);
  if (config.doctrine === "first-principles-qds-v1") state.config.doctrine = config.doctrine;
  if (Object.keys(profile).length > 0) {
    state.config.profile = {
      goal: stringValue(profile.goal),
      ...(Object.hasOwn(profile, "dirs") ? { dirs: stringArray(profile.dirs) } : {}),
      tasks: stringArray(profile.tasks),
      configuredAt: stringValue(profile.configuredAt),
    };
  }
  state.jobs = Array.isArray(value.jobs)
    ? value.jobs.filter(
        (job): job is JobRecord =>
          typeof job === "object" && job !== null && typeof (job as JobRecord).id === "string",
      )
    : [];
  const migration = asRecord(value.migration);
  if (
    (migration.source === ".swarm-pi-code-plugin" ||
      migration.source === ".swarm-pi-code" ||
      migration.source === ".swarm-code" ||
      migration.source === "user-state-workspace") &&
    typeof migration.migratedAt === "string"
  ) {
    state.migration = { source: migration.source, migratedAt: migration.migratedAt };
  }
  return state;
}

function normalizeHostAssistancePolicy(value: unknown): HostAssistancePolicy {
  const defaults = defaultHostAssistancePolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ...defaults,
      reviewMode: "user-only",
      autoApprovalScope: "context-only",
      autoApproveDiscoveryGates: false,
    };
  }
  const candidate = value as Record<string, unknown>;
  const mode = candidate.mode === "off" || candidate.mode === "inherit" ? candidate.mode : "on";
  const maxRequests = Number.isInteger(candidate.maxRequests)
    ? Math.min(
        WORKFLOW_BOUNDS.hostAssistance.requests.max,
        Math.max(WORKFLOW_BOUNDS.hostAssistance.requests.min, candidate.maxRequests as number),
      )
    : defaults.maxRequests;
  const maxFanOut = Number.isInteger(candidate.maxFanOut)
    ? Math.min(
        maxRequests,
        WORKFLOW_BOUNDS.hostAssistance.fanOut.max,
        Math.max(WORKFLOW_BOUNDS.hostAssistance.fanOut.min, candidate.maxFanOut as number),
      )
    : Math.min(defaults.maxFanOut, maxRequests);
  return {
    enabled: mode === "off" ? false : candidate.enabled !== false,
    mode,
    contextClasses: Array.isArray(candidate.contextClasses)
      ? candidate.contextClasses.filter(
          (item): item is HostAssistancePolicy["contextClasses"][number] =>
            ["workspace", "web", "docs", "paper", "connector", "skill"].includes(item as string),
        )
      : defaults.contextClasses,
    privateConnector: candidate.privateConnector === "deny" ? "deny" : "ask",
    maxRequests,
    maxFanOut,
    reviewMode: candidate.reviewMode === "host-first" ? "host-first" : "user-only",
    autoApprovalScope:
      candidate.autoApprovalScope === "read-only" || candidate.autoApprovalScope === "reversible"
        ? candidate.autoApprovalScope
        : "context-only",
    autoApproveDiscoveryGates: candidate.autoApproveDiscoveryGates === true,
    // Autopilot outward-boundary controls. Missing/legacy → stricter defaults.
    outwardApprovalGranularity:
      candidate.outwardApprovalGranularity === "first-then-auto" ? "first-then-auto" : "each-time",
    autoGitWrites: candidate.autoGitWrites === true,
    autoDelivery: candidate.autoDelivery === true,
  };
}

function normalizeAdvisorPolicy(value: unknown): AdvisorPolicy {
  const defaults = defaultAdvisorPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const candidate = value as Record<string, unknown>;
  return {
    enabled: candidate.enabled === true,
    targets: Array.isArray(candidate.targets)
      ? candidate.targets.filter((item): item is TaskKind =>
          [
            "ask",
            "review",
            "plan",
            "implement",
            "orchestrate",
            "scaffold",
            "setup",
            "discover",
          ].includes(item as string),
        )
      : defaults.targets,
    maxRequests: Number.isInteger(candidate.maxRequests)
      ? Math.min(
          WORKFLOW_BOUNDS.advisor.requests.max,
          Math.max(WORKFLOW_BOUNDS.advisor.requests.min, candidate.maxRequests as number),
        )
      : defaults.maxRequests,
    maxPerspectives: Number.isInteger(candidate.maxPerspectives)
      ? Math.min(
          WORKFLOW_BOUNDS.advisor.perspectives.max,
          Math.max(WORKFLOW_BOUNDS.advisor.perspectives.min, candidate.maxPerspectives as number),
        )
      : defaults.maxPerspectives,
  };
}

export function defaultHostActionPolicy(): HostActionPolicy {
  return {
    enabled: true,
    allowedActionClasses: ["local-mutation", "draft"],
    remoteActionsEnabled: false,
    maxUses: 1,
    maxCost: 1,
    ttlMs: 30 * 60_000,
  };
}

function normalizeHostActionPolicy(value: unknown): HostActionPolicy {
  const defaults = defaultHostActionPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const candidate = value as Record<string, unknown>;
  const classes = Array.isArray(candidate.allowedActionClasses)
    ? candidate.allowedActionClasses.filter(
        (item): item is HostActionPolicy["allowedActionClasses"][number] =>
          ["local-mutation", "draft", "remote-write", "message", "deploy", "transaction"].includes(
            item as string,
          ),
      )
    : defaults.allowedActionClasses;
  return {
    enabled: candidate.enabled !== false,
    allowedActionClasses: classes,
    remoteActionsEnabled: candidate.remoteActionsEnabled === true,
    maxUses: Number.isInteger(candidate.maxUses)
      ? Math.min(100, Math.max(1, candidate.maxUses as number))
      : defaults.maxUses,
    maxCost:
      typeof candidate.maxCost === "number" && Number.isFinite(candidate.maxCost)
        ? Math.max(0, candidate.maxCost)
        : defaults.maxCost,
    ttlMs: Number.isInteger(candidate.ttlMs)
      ? Math.min(24 * 60 * 60_000, Math.max(60_000, candidate.ttlMs as number))
      : defaults.ttlMs,
  };
}

async function resolveGitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8" },
    );
    return await fs.realpath(stdout.trim());
  } catch {
    return undefined;
  }
}

function userStateRoot(env: NodeJS.ProcessEnv): string {
  if (env.SWARM_PI_CODE_PLUGIN_USER_STATE_DIR)
    return path.resolve(env.SWARM_PI_CODE_PLUGIN_USER_STATE_DIR);
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "swarm-pi-code-plugin");
  if (process.platform === "win32")
    return path.join(
      env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "swarm-pi-code-plugin",
    );
  return path.join(
    env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "swarm-pi-code-plugin",
  );
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function acquireFileLock(file: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await fs.open(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.stat(file).catch(() => undefined);
      if (existing && Date.now() - existing.mtimeMs > 30_000) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for migration lock: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sandboxModeValue(value: unknown): SandboxMode {
  return value === "adaptive" ||
    value === "lenient" ||
    value === "autopilot" ||
    value === "full-access"
    ? value
    : "strict";
}

function rolePolicyOverrides(value: unknown): RolePolicyOverrides {
  const record = asRecord(value);
  const result: RolePolicyOverrides = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!isWorkerRole(key)) continue;
    const candidate = asRecord(raw);
    result[key] = {
      ...(stringArray(candidate.models).length ? { models: stringArray(candidate.models) } : {}),
      ...(typeof candidate.thinkingLevel === "string"
        ? { thinkingLevel: candidate.thinkingLevel as never }
        : {}),
      ...(typeof candidate.maxAttempts === "number" ? { maxAttempts: candidate.maxAttempts } : {}),
    };
  }
  return result;
}

async function withStateLock<T>(
  cwd: string,
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const directory = await resolveStateDir(cwd, env);
  return stateUpdateQueue.run(directory, async () => {
    await fs.mkdir(directory, { recursive: true });
    const lockFile = path.join(directory, "state.lock");
    const deadline = Date.now() + 5_000;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    while (!handle) {
      try {
        handle = await fs.open(lockFile, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
    } finally {
      await handle.close();
      await fs.rm(lockFile, { force: true });
    }
  });
}
