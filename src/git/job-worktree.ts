import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { assessWorkspace, requireCleanWorktree } from "./worktree.js";
import { resolveWorkspaceRoot } from "../state/state.js";

const execFileAsync = promisify(execFile);

export interface JobWorktree {
  worktree: string;
  branch: string;
  base: string;
}

export async function prepareJobWorktree(
  cwd: string,
  jobId: string,
  strategy: "auto" | "isolated-head" | "isolated-snapshot" = "auto",
): Promise<JobWorktree> {
  const workspace = await fs.realpath(await resolveWorkspaceRoot(cwd));
  if (strategy === "auto") await requireCleanWorktree(workspace);
  const assessment = await assessWorkspace(workspace);
  if (assessment.disposition === "unsafe") throw new Error("Unsafe worktree cannot be isolated");
  const base = (await git(workspace, ["rev-parse", "HEAD"])).trim();
  const key = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
  const worktree = path.join(os.tmpdir(), "swarm-pi-job-worktrees", key, jobId);
  const branch = `swarm-pi/${jobId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-48)}`;
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  let created = false;
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktree, base], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    created = true;
    if (strategy === "isolated-snapshot") {
      const patchFile = path.join(os.tmpdir(), `swarm-pi-snapshot-${jobId}.patch`);
      const patch = await git(workspace, ["diff", "--binary", "HEAD", "--"]);
      try {
        if (patch.trim()) {
          await fs.writeFile(patchFile, patch, { mode: 0o600 });
          await execFileAsync("git", ["apply", "--binary", "--whitespace=nowarn", patchFile], { cwd: worktree, encoding: "utf8" });
        }
      } finally {
        await fs.rm(patchFile, { force: true });
      }
      await copyWorkspaceSnapshot(workspace, worktree, assessment.entries.filter((entry) => entry.category === "user" && entry.status === "??"));
      await execFileAsync("git", ["add", "-A"], { cwd: worktree, encoding: "utf8" });
      const status = await git(worktree, ["status", "--porcelain=v1"]);
      if (status.trim()) {
        await execFileAsync("git", [
          "-c", "user.name=Swarm Pi Control Plane",
          "-c", "user.email=swarm-pi@localhost",
          "-c", "commit.gpgsign=false",
          "commit", "-m", `swarm-pi: local snapshot ${jobId}`,
        ], { cwd: worktree, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      }
    }
    return { worktree, branch, base };
  } catch (error) {
    if (created) {
      await execFileAsync("git", ["worktree", "remove", "--force", worktree], { cwd: workspace, encoding: "utf8" }).catch(() => {});
      await execFileAsync("git", ["branch", "-D", branch], { cwd: workspace, encoding: "utf8" }).catch(() => {});
    }
    throw error;
  }
}

export async function checkpointJobWorktree(worktree: string, jobId: string): Promise<string | null> {
  await execFileAsync("git", ["add", "-A"], { cwd: worktree, encoding: "utf8" });
  const status = await git(worktree, ["status", "--porcelain=v1"]);
  if (!status.trim()) return null;
  await execFileAsync("git", [
    "-c", "user.name=Swarm Pi",
    "-c", "user.email=swarm-pi@localhost",
    "-c", "commit.gpgsign=false",
    "commit", "-m", `swarm-pi: checkpoint ${jobId}`,
  ], { cwd: worktree, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

export async function cleanupJobWorktree(
  cwd: string,
  artifact: JobWorktree & { commit?: string },
  discard = false,
): Promise<void> {
  const workspace = await fs.realpath(await resolveWorkspaceRoot(cwd));
  if (!discard && !artifact.commit) {
    const status = await git(artifact.worktree, ["status", "--porcelain=v1"]).catch(() => "");
    if (status.trim()) throw new Error("Job worktree contains uncommitted changes; use --discard to remove it explicitly");
  }
  if (!discard && artifact.commit) {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", artifact.commit, "HEAD"], { cwd: workspace });
    } catch {
      throw new Error("Job artifact is not integrated; use --discard to remove it explicitly");
    }
  }
  await execFileAsync("git", ["worktree", "remove", "--force", artifact.worktree], { cwd: workspace, encoding: "utf8" });
  if (discard || !artifact.commit) {
    await execFileAsync("git", ["branch", "-D", artifact.branch], { cwd: workspace, encoding: "utf8" }).catch(() => {});
  } else {
    await execFileAsync("git", ["branch", "-d", artifact.branch], { cwd: workspace, encoding: "utf8" }).catch(() => {});
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout;
}

async function copyWorkspaceSnapshot(
  source: string,
  destination: string,
  entries: Array<{ path: string }>,
): Promise<void> {
  for (const entry of entries) {
    const relative = entry.path;
    if (relative === ".git" || relative.startsWith(`.git${path.sep}`) || relative.includes("..")) {
      throw new Error(`Unsafe snapshot path: ${relative}`);
    }
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    const stat = await fs.lstat(from).catch(() => undefined);
    if (!stat) {
      await fs.rm(to, { recursive: true, force: true });
      continue;
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Unsupported snapshot entry: ${relative}`);
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true, force: true });
  }
}
