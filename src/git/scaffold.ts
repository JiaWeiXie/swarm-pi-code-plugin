import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ScaffoldSpec, WorkerResult } from "../core/contracts.js";
import { assessWorkspace } from "./worktree.js";

const execFileAsync = promisify(execFile);
const ARTIFACT_NAME = "Swarm Pi Control Plane";
const ARTIFACT_EMAIL = "swarm-pi@localhost";

export interface ScaffoldWorkspace {
  worktree: string;
  branch: string;
  base: string;
  target: string;
  targetFingerprint: string;
  targetMode: "empty" | "adopt";
  preservedPaths: string[];
}

export async function prepareScaffoldWorkspace(
  cwd: string,
  target: string,
  jobId: string,
  spec: ScaffoldSpec,
): Promise<ScaffoldWorkspace> {
  const resolvedTarget = path.resolve(cwd, target);
  await assertTargetIsNotLink(resolvedTarget);
  const existingParent = await nearestExistingDirectory(path.dirname(resolvedTarget));
  if (existingParent) {
    const parentGitRoot = await git(existingParent, ["rev-parse", "--show-toplevel"]).then((value) => path.resolve(value.trim())).catch(() => undefined);
    if (parentGitRoot && isInside(parentGitRoot, resolvedTarget) && parentGitRoot !== resolvedTarget) {
      throw new Error("Scaffold target is nested inside an existing Git repository; use that repository or choose an external target");
    }
  }
  const assessment = await assessWorkspace(resolvedTarget);
  if (assessment.git) throw new Error("Scaffold target is already a Git repository; use setup or implement");
  if (spec.targetMode === "empty" && assessment.disposition !== "non-git-empty") {
    throw new Error("Scaffold target contains user files; use an approved adopt specification");
  }
  if (assessment.entries.some((entry) => entry.category === "unsafe")) {
    throw new Error("Scaffold target contains unsafe links or special files");
  }
  const worktree = path.join(os.tmpdir(), "swarm-pi-scaffolds", jobId);
  await fs.rm(worktree, { recursive: true, force: true });
  try {
    await fs.mkdir(worktree, { recursive: true, mode: 0o700 });
    const preservedPaths = assessment.entries
      .filter((entry) => entry.category === "runtime" || entry.category === "ephemeral" || protectedAdoptionPath(entry.path))
      .map((entry) => entry.path);
    if (spec.targetMode === "adopt") {
      await copyAdoptionBaseline(resolvedTarget, worktree, preservedPaths);
    }
    await git(worktree, ["init", "-b", "main"]);
    await git(worktree, ["add", "-A"]);
    await artifactCommit(worktree, spec.targetMode === "adopt" ? `swarm-pi: adoption baseline ${jobId}` : `swarm-pi: bootstrap baseline ${jobId}`, true);
    const base = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    return {
      worktree,
      branch: "main",
      base,
      target: resolvedTarget,
      targetFingerprint: assessment.fingerprint,
      targetMode: spec.targetMode,
      preservedPaths,
    };
  } catch (error) {
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function checkpointScaffold(workspace: ScaffoldWorkspace, jobId: string): Promise<string> {
  await git(workspace.worktree, ["add", "-A"]);
  const status = await git(workspace.worktree, ["status", "--porcelain=v1"]);
  if (status.trim()) await artifactCommit(workspace.worktree, `swarm-pi: scaffold ${jobId}`, false);
  return (await git(workspace.worktree, ["rev-parse", "HEAD"])).trim();
}

export async function materializeScaffold(options: {
  workspace: ScaffoldWorkspace;
  result: WorkerResult;
  target?: string;
  stateDir?: string;
  moveState?: boolean;
  afterSwap?: (target: string) => Promise<void>;
}): Promise<{ target: string; commit: string; stateMoved: boolean; cleanupWarnings: string[] }> {
  if (!options.result.success || !options.result.artifact?.deliverable || !options.result.artifact.commit) {
    throw new Error("Scaffold artifact is not verified and deliverable");
  }
  const target = path.resolve(options.target ?? options.workspace.target);
  if (target !== path.resolve(options.workspace.target)) throw new Error("Materialization target differs from the approved target");
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const releaseLock = await acquireMaterializationLock(parent, target);
  const candidate = path.join(parent, `.swarm-pi-materialize-${path.basename(target)}-${randomUUID()}`);
  const backup = path.join(parent, `.swarm-pi-backup-${path.basename(target)}-${randomUUID()}`);
  let targetExists = false;
  let backupCreated = false;
  let swapped = false;
  const cleanupWarnings: string[] = [];
  try {
    await assertTargetIsNotLink(target);
    await assertTargetFingerprint(target, options.workspace.targetFingerprint);
    if (options.stateDir && options.workspace.preservedPaths.some(isLegacyRuntimeStatePath)) {
      throw new Error("Materialization conflict: target contains legacy runtime state; migrate it before materializing");
    }
    await fs.cp(options.workspace.worktree, candidate, { recursive: true, errorOnExist: true });
    if (options.stateDir) {
      const destinationState = path.join(candidate, ".git", "swarm-pi-code-plugin");
      if (options.moveState) await fs.cp(options.stateDir, destinationState, { recursive: true, errorOnExist: true });
      else await seedProjectState(options.stateDir, destinationState);
    }
    if (options.workspace.preservedPaths.length > 0) {
      await copyPreserved(target, candidate, options.workspace.preservedPaths);
    }
    await assertTargetIsNotLink(target);
    await assertTargetFingerprint(target, options.workspace.targetFingerprint);
    targetExists = Boolean(await fs.lstat(target).catch(() => undefined));
    if (targetExists) {
      await fs.rename(target, backup);
      backupCreated = true;
    }
    await fs.rename(candidate, target);
    swapped = true;
    await options.afterSwap?.(target);
    if (backupCreated) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {
        cleanupWarnings.push(`Previous target retained for recovery: ${backup}`);
      });
    }
    return {
      target,
      commit: options.result.artifact.commit,
      stateMoved: options.moveState === true,
      cleanupWarnings,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (swapped) {
      if (targetExists && backupCreated) {
        try {
          await fs.rename(target, candidate);
          await fs.rename(backup, target);
          backupCreated = false;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      } else {
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      }
    } else if (backupCreated) {
      try {
        await fs.rename(backup, target);
        backupCreated = false;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    await fs.rm(candidate, { recursive: true, force: true }).catch((cleanupError) => {
      rollbackErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    });
    const message = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) {
      throw new Error(`Materialization failed and rollback requires recovery: ${message}`);
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

export function parseScaffoldSpec(value: string): ScaffoldSpec {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (parsed.version !== 1 || typeof parsed.request !== "string" || !parsed.request.trim() ||
      typeof parsed.projectName !== "string" || !parsed.projectName.trim()) {
    throw new Error("Scaffold spec requires version 1, request, and projectName");
  }
  if (parsed.targetMode !== "empty" && parsed.targetMode !== "adopt") throw new Error("Scaffold targetMode must be empty or adopt");
  const strings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : undefined;
  const structure = strings(parsed.structure);
  const dependencies = strings(parsed.dependencies);
  const verificationCommands = strings(parsed.verificationCommands);
  const doneCriteria = strings(parsed.doneCriteria);
  return {
    version: 1,
    request: parsed.request.trim(),
    projectName: parsed.projectName.trim(),
    targetMode: parsed.targetMode,
    ...(typeof parsed.runtime === "string" ? { runtime: parsed.runtime } : {}),
    ...(typeof parsed.packageManager === "string" ? { packageManager: parsed.packageManager } : {}),
    ...(structure ? { structure } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...(verificationCommands ? { verificationCommands } : {}),
    ...(parsed.allowLifecycleScripts === true ? { allowLifecycleScripts: true } : {}),
    ...(doneCriteria ? { doneCriteria } : {}),
  };
}

async function artifactCommit(cwd: string, message: string, allowEmpty: boolean): Promise<void> {
  await git(cwd, [
    "-c", `user.name=${ARTIFACT_NAME}`,
    "-c", `user.email=${ARTIFACT_EMAIL}`,
    "-c", "commit.gpgsign=false",
    "commit", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message,
  ]);
}

async function copyAdoptionBaseline(source: string, destination: string, preserved: string[]): Promise<void> {
  const preservedSet = new Set(preserved);
  async function visit(fromDirectory: string, toDirectory: string, prefix = ""): Promise<void> {
    for (const entry of await fs.readdir(fromDirectory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === ".git" || preservedSet.has(relative)) continue;
      const from = path.join(fromDirectory, entry.name);
      const to = path.join(toDirectory, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(to, { recursive: true });
        await visit(from, to, relative);
      } else {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      }
    }
  }
  await visit(source, destination);
}

async function copyPreserved(source: string, destination: string, paths: string[]): Promise<void> {
  for (const relative of [...new Set(paths)].sort((left, right) => left.split("/").length - right.split("/").length)) {
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    if (await fs.lstat(to).catch(() => undefined)) {
      throw new Error(`Materialization conflict: artifact also contains preserved path ${relative}`);
    }
    if (await fs.stat(from).catch(() => undefined)) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, { recursive: true, errorOnExist: true });
    }
  }
}

async function assertTargetFingerprint(target: string, expected: string): Promise<void> {
  const current = await assessWorkspace(target);
  if (current.fingerprint !== expected) {
    throw new Error("Materialization target changed after scaffold submission");
  }
}

async function assertTargetIsNotLink(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error("Scaffold target cannot be a symbolic link");
}

async function acquireMaterializationLock(parent: string, target: string): Promise<() => Promise<void>> {
  const key = createHash("sha256").update(path.resolve(target)).digest("hex").slice(0, 16);
  const file = path.join(parent, `.swarm-pi-materialize-${key}.lock`);
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, target, createdAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => { await fs.rm(file, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 5 * 60_000) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for materialization lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function protectedAdoptionPath(value: string): boolean {
  const normalized = value.split(path.sep).join("/");
  const basename = path.posix.basename(normalized).toLowerCase();
  return normalized === ".env" || normalized.startsWith(".env.") || normalized === ".npmrc" || normalized === ".pypirc" ||
    normalized.startsWith(".ssh/") || normalized.startsWith(".aws/") ||
    /^(?:id_rsa|id_ed25519|credentials|secrets?\.json|.*\.pem|.*\.key)$/.test(basename);
}

function isLegacyRuntimeStatePath(value: string): boolean {
  const normalized = value.split(path.sep).join("/");
  return [".swarm-pi-code-plugin", ".swarm-pi-code", ".swarm-code"]
    .some((directory) => normalized === directory || normalized.startsWith(`${directory}/`));
}

async function seedProjectState(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const modelSource = path.join(source, "model.json");
  if (await fs.stat(modelSource).catch(() => undefined)) {
    await fs.copyFile(modelSource, path.join(destination, "model.json"));
  }
  const stateSource = path.join(source, "state.json");
  const raw = await fs.readFile(stateSource, "utf8").catch(() => undefined);
  if (raw) {
    const state = JSON.parse(raw) as Record<string, unknown>;
    state.jobs = [];
    delete state.migration;
    await fs.writeFile(path.join(destination, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).stdout;
}

async function nearestExistingDirectory(candidate: string): Promise<string | undefined> {
  let current = path.resolve(candidate);
  while (true) {
    if ((await fs.stat(current).catch(() => undefined))?.isDirectory()) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
