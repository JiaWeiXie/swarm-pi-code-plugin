import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { resolveStateDir, resolveWorkspaceRoot } from "../state/state.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInspection {
  clean: boolean;
  changedFiles: string[];
  entries: Array<{ status: string; path: string }>;
}

export interface WorktreeChanges extends WorktreeInspection {
  diff: string;
  diffStat: string;
}

export interface WorktreeBaseline {
  head: string | null;
  ignoredPaths: string[];
}

export interface WorktreeLease {
  workspace: string;
  baseline: WorktreeBaseline;
  release(): Promise<void>;
}

export class WorktreeDirtyError extends Error {
  readonly inspection: WorktreeInspection;

  constructor(inspection: WorktreeInspection) {
    super(`Implementation requires a clean worktree. Existing changes: ${inspection.changedFiles.join(", ")}`);
    this.name = "WorktreeDirtyError";
    this.inspection = inspection;
  }
}

export async function inspectWorktree(cwd: string): Promise<WorktreeInspection> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const entries = await excludeRuntimeState(cwd, parsePorcelain(stdout));
  const changedFiles = [...new Set(entries.map((entry) => entry.path))].sort();
  return { clean: entries.length === 0, changedFiles, entries };
}

async function excludeRuntimeState(
  cwd: string,
  entries: Array<{ status: string; path: string }>,
): Promise<Array<{ status: string; path: string }>> {
  const workspace = await resolveWorkspaceRoot(cwd);
  const stateDir = await resolveStateDir(cwd);
  const relativeStateDir = path.relative(workspace, stateDir);
  const runtimeStateDirs = [".swarm-pi-code", ".swarm-code"];
  if (
    relativeStateDir !== "" &&
    !relativeStateDir.startsWith("..") &&
    !path.isAbsolute(relativeStateDir)
  ) {
    runtimeStateDirs.push(relativeStateDir);
  }
  return entries.filter((entry) =>
    runtimeStateDirs.every(
      (directory) =>
        entry.path !== directory && !entry.path.startsWith(`${directory}${path.sep}`),
    ),
  );
}

export async function requireCleanWorktree(cwd: string): Promise<void> {
  const inspection = await inspectWorktree(cwd);
  if (!inspection.clean) throw new WorktreeDirtyError(inspection);
}

export async function acquireWorktreeLease(cwd: string, jobId: string): Promise<WorktreeLease> {
  const workspace = await fs.realpath(await resolveWorkspaceRoot(cwd));
  const directory = path.join(await resolveStateDir(cwd), "worktree-leases");
  await fs.mkdir(directory, { recursive: true });
  const key = createHash("sha256").update(workspace).digest("hex");
  const file = path.join(directory, `${key}.json`);
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ jobId, pid: process.pid, token, workspace })}\n`);
      } finally {
        await handle.close();
      }
      let baseline: WorktreeBaseline;
      try {
        baseline = await captureWorktreeBaseline(workspace);
      } catch (error) {
        await fs.rm(file, { force: true });
        throw error;
      }
      return {
        workspace,
        baseline,
        async release() {
          const current = await readLease(file);
          if (current?.token === token) await fs.rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readLease(file);
      if (current?.pid && processAlive(current.pid)) {
        throw new Error(`Another implementation job already owns this worktree: ${current.jobId ?? "unknown"}`);
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new Error("Unable to acquire the implementation worktree lease");
}

export async function assertWorktreeBaseline(cwd: string, baseline: WorktreeBaseline): Promise<void> {
  const head = await headRevision(cwd);
  if (head !== baseline.head) {
    throw new Error("The worktree HEAD changed while the delegated implementation was running");
  }
}

export async function captureIgnoredPaths(cwd: string): Promise<string[]> {
  const output = await gitOutput(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=normal",
  ], 8 * 1024 * 1024);
  return output
    .split("\0")
    .filter((record) => record.startsWith("!! "))
    .map((record) => record.slice(3))
    .sort();
}

export async function validateChangedPaths(cwd: string, changedFiles: string[]): Promise<void> {
  const root = await fs.realpath(await resolveWorkspaceRoot(cwd));
  for (const file of changedFiles) {
    const absolute = path.resolve(root, file);
    if (!isInside(root, absolute)) throw new Error(`Changed path escaped the worktree: ${file}`);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = path.resolve(path.dirname(absolute), await fs.readlink(absolute));
      const resolvedTarget = await fs.realpath(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return target;
        throw error;
      });
      if (!isInside(root, resolvedTarget)) {
        throw new Error(`Changed symlink points outside the worktree: ${file}`);
      }
      continue;
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Changed path has an unsupported file type: ${file}`);
    }
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error(`Changed file has multiple hard links and cannot be accepted safely: ${file}`);
    }
  }
}

export async function captureWorktreeChanges(cwd: string): Promise<WorktreeChanges> {
  const inspection = await inspectWorktree(cwd);
  const [{ stdout: diff }, { stdout: trackedStat }] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
    execFileAsync("git", ["diff", "--stat", "HEAD", "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  ]);
  const untracked = inspection.entries
    .filter((entry) => entry.status === "??")
    .map((entry) => entry.path);
  const untrackedDiffs: string[] = [];
  for (const file of untracked) {
    untrackedDiffs.push(await diffUntrackedFile(cwd, file));
  }
  return {
    ...inspection,
    diff: [diff.trimEnd(), ...untrackedDiffs.map((value) => value.trimEnd())]
      .filter(Boolean)
      .join("\n"),
    diffStat: [trackedStat.trimEnd(), ...untracked.map((file) => `${file} (untracked)`)]
      .filter(Boolean)
      .join("\n"),
  };
}

async function captureWorktreeBaseline(cwd: string): Promise<WorktreeBaseline> {
  return {
    head: await headRevision(cwd),
    ignoredPaths: await captureIgnoredPaths(cwd),
  };
}

async function headRevision(cwd: string): Promise<string | null> {
  try {
    return (await gitOutput(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch {
    return null;
  }
}

async function diffUntrackedFile(cwd: string, file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-index", "--binary", "--", "/dev/null", file],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const gitError = error as NodeJS.ErrnoException & { code?: number; stdout?: string };
    if (gitError.code === 1) return gitError.stdout ?? "";
    throw error;
  }
}

export function parsePorcelain(output: string): Array<{ status: string; path: string }> {
  const records = output.split("\0");
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    entries.push({ status, path: record.slice(3) });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

async function gitOutput(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer });
  return stdout;
}

async function readLease(file: string): Promise<{ jobId?: string; pid?: number; token?: string } | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as { jobId?: string; pid?: number; token?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
