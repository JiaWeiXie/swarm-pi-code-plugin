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
  JobStatus,
  NotificationStatus,
  SandboxMode,
  TaskKind,
  WorkerRoleId,
} from "../core/contracts.js";
import {
  DEFAULT_ADAPTIVE_POLICY,
  DEFAULT_BACKGROUND_ROLE_POLICY,
  isWorkerRole,
  normalizeAdaptivePolicy,
  type RolePolicyOverrides,
} from "../orchestration/roles.js";

const execFileAsync = promisify(execFile);

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
  generation?: number;
  pendingApprovalId?: string;
  approvals?: ApprovalRequest[];
  leases?: CapabilityLease[];
  notifications?: JobNotification[];
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  notification?: NotificationStatus;
  [key: string]: unknown;
}

export interface SwarmState {
  version: 1;
  config: SwarmConfig;
  jobs: JobRecord[];
  migration?: { source: ".swarm-pi-code-plugin" | ".swarm-pi-code" | ".swarm-code"; migratedAt: string };
}

export class StateMigrationConflictError extends Error {
  constructor(readonly legacyDir: string, readonly destinationDir: string) {
    super(`Runtime state exists in both ${legacyDir} and ${destinationDir}`);
    this.name = "StateMigrationConflictError";
  }
}

export function defaultState(): SwarmState {
  return {
    version: 1,
    config: {
      modelPriority: [],
      availableModels: [],
      availableModelsCheckedAt: null,
      sandboxMode: "strict",
      rolePolicies: {},
      adaptivePolicy: structuredClone(DEFAULT_ADAPTIVE_POLICY),
      backgroundRolePolicy: structuredClone(DEFAULT_BACKGROUND_ROLE_POLICY),
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

export async function resolveStateFile(cwd: string): Promise<string> {
  return path.join(await resolveStateDir(cwd), "state.json");
}

export async function loadState(cwd: string): Promise<SwarmState> {
  await migrateCurrentStateDirectory(cwd);
  const current = await readJson(await resolveStateFile(cwd));
  if (current) return normalizeState(current);
  const migrated = await readLegacyState(cwd);
  if (migrated) {
    await writeState(cwd, migrated);
    return migrated;
  }
  return defaultState();
}

export async function migrateCurrentStateDirectory(cwd: string): Promise<boolean> {
  if (process.env.SWARM_PI_CODE_PLUGIN_DATA_DIR) return false;
  const workspace = await resolveWorkspaceRoot(cwd);
  const legacyDir = path.join(workspace, ".swarm-pi-code-plugin");
  const destinationDir = await resolveStateDir(cwd);
  if (path.resolve(legacyDir) === path.resolve(destinationDir)) return false;
  const parent = path.dirname(destinationDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const lock = path.join(parent, `${path.basename(destinationDir)}.migration.lock`);
  const handle = await acquireFileLock(lock);
  try {
    const legacy = await fs.stat(legacyDir).catch(() => undefined);
    if (!legacy?.isDirectory()) return false;
    const destination = await fs.stat(destinationDir).catch(() => undefined);
    if (destination) throw new StateMigrationConflictError(legacyDir, destinationDir);
    try {
      await fs.rename(legacyDir, destinationDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.cp(legacyDir, destinationDir, { recursive: true, errorOnExist: true });
      await fs.rm(legacyDir, { recursive: true, force: true });
    }
    const stateFile = path.join(destinationDir, "state.json");
    const current = await readJson(stateFile);
    if (current) {
      const state = normalizeState(current);
      state.migration = { source: ".swarm-pi-code-plugin", migratedAt: new Date().toISOString() };
      await writeJsonAtomic(stateFile, state);
    }
    return true;
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

export async function writeState(cwd: string, state: SwarmState): Promise<void> {
  const stateFile = await resolveStateFile(cwd);
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
): Promise<SwarmState> {
  return withStateLock(cwd, async () => {
    const state = structuredClone(await loadState(cwd));
    const updated = update(state) ?? state;
    await writeState(cwd, updated);
    return updated;
  });
}

export async function setModelPriority(cwd: string, models: string[]): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.modelPriority = [...models];
  });
}

export async function setAvailableModels(cwd: string, models: string[]): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.availableModels = [...models];
    state.config.availableModelsCheckedAt = new Date().toISOString();
  });
}

export async function saveProfile(cwd: string, profile: SwarmProfile): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.profile = { ...profile, configuredAt: profile.configuredAt ?? new Date().toISOString() };
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
  },
): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.profile = {
      ...profile,
      configuredAt: profile.configuredAt ?? new Date().toISOString(),
    };
    state.config.sandboxMode = sandboxMode;
    if (execution?.rolePolicies) state.config.rolePolicies = structuredClone(execution.rolePolicies);
    if (execution?.adaptivePolicy) state.config.adaptivePolicy = normalizeAdaptivePolicy(execution.adaptivePolicy);
    if (execution?.backgroundRolePolicy) {
      state.config.backgroundRolePolicy = {
        mechanicalExecutor: execution.backgroundRolePolicy.mechanicalExecutor === true,
      };
    }
  });
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
  },
): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config.sandboxMode = sandboxMode;
    state.config.rolePolicies = structuredClone(execution.rolePolicies ?? {});
    state.config.adaptivePolicy = normalizeAdaptivePolicy(execution.adaptivePolicy);
    state.config.backgroundRolePolicy = {
      mechanicalExecutor: execution.backgroundRolePolicy?.mechanicalExecutor === true,
    };
  });
}

export async function clearConfiguration(cwd: string): Promise<SwarmState> {
  return updateState(cwd, (state) => {
    state.config = {
      modelPriority: [],
      availableModels: [],
      availableModelsCheckedAt: null,
      sandboxMode: "strict",
      rolePolicies: {},
      adaptivePolicy: structuredClone(DEFAULT_ADAPTIVE_POLICY),
      backgroundRolePolicy: structuredClone(DEFAULT_BACKGROUND_ROLE_POLICY),
    };
  });
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

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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
  state.config.backgroundRolePolicy = { mechanicalExecutor: background.mechanicalExecutor === true };
  if (Object.keys(profile).length > 0) {
    state.config.profile = {
      goal: stringValue(profile.goal),
      dirs: stringArray(profile.dirs),
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
    (migration.source === ".swarm-pi-code-plugin" || migration.source === ".swarm-pi-code" || migration.source === ".swarm-code") &&
    typeof migration.migratedAt === "string"
  ) {
    state.migration = { source: migration.source, migratedAt: migration.migratedAt };
  }
  return state;
}

async function resolveGitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" },
    );
    return await fs.realpath(stdout.trim());
  } catch {
    return undefined;
  }
}

function userStateRoot(env: NodeJS.ProcessEnv): string {
  if (env.SWARM_PI_CODE_PLUGIN_USER_STATE_DIR) return path.resolve(env.SWARM_PI_CODE_PLUGIN_USER_STATE_DIR);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "swarm-pi-code-plugin");
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "swarm-pi-code-plugin");
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "swarm-pi-code-plugin");
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sandboxModeValue(value: unknown): SandboxMode {
  return value === "adaptive" || value === "lenient" ? value : "strict";
}

function rolePolicyOverrides(value: unknown): RolePolicyOverrides {
  const record = asRecord(value);
  const result: RolePolicyOverrides = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!isWorkerRole(key)) continue;
    const candidate = asRecord(raw);
    result[key] = {
      ...(stringArray(candidate.models).length ? { models: stringArray(candidate.models) } : {}),
      ...(typeof candidate.thinkingLevel === "string" ? { thinkingLevel: candidate.thinkingLevel as never } : {}),
      ...(typeof candidate.maxAttempts === "number" ? { maxAttempts: candidate.maxAttempts } : {}),
    };
  }
  return result;
}

async function withStateLock<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const directory = await resolveStateDir(cwd);
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
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for state lock: ${lockFile}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await run();
  } finally {
    await handle.close();
    await fs.rm(lockFile, { force: true });
  }
}
