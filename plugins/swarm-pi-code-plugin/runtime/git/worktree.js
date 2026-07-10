import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir, resolveWorkspaceRoot } from "../state/state.js";
const execFileAsync = promisify(execFile);
export class WorktreeDirtyError extends Error {
    inspection;
    constructor(inspection) {
        super(`Implementation requires a clean worktree. Existing changes: ${inspection.changedFiles.join(", ")}`);
        this.name = "WorktreeDirtyError";
        this.inspection = inspection;
    }
}
export async function inspectWorktree(cwd) {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const entries = await excludeRuntimeState(cwd, parsePorcelain(stdout));
    const changedFiles = [...new Set(entries.map((entry) => entry.path))].sort();
    return { clean: entries.length === 0, changedFiles, entries };
}
async function excludeRuntimeState(cwd, entries) {
    const workspace = await resolveWorkspaceRoot(cwd);
    const stateDir = await resolveStateDir(cwd);
    const relativeStateDir = path.relative(workspace, stateDir);
    const runtimeStateDirs = [".swarm-pi-code", ".swarm-code"];
    if (relativeStateDir !== "" &&
        !relativeStateDir.startsWith("..") &&
        !path.isAbsolute(relativeStateDir)) {
        runtimeStateDirs.push(relativeStateDir);
    }
    return entries.filter((entry) => runtimeStateDirs.every((directory) => entry.path !== directory && !entry.path.startsWith(`${directory}${path.sep}`)));
}
export async function requireCleanWorktree(cwd) {
    const inspection = await inspectWorktree(cwd);
    if (!inspection.clean)
        throw new WorktreeDirtyError(inspection);
}
export async function acquireWorktreeLease(cwd, jobId) {
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
            }
            finally {
                await handle.close();
            }
            let baseline;
            try {
                baseline = await captureWorktreeBaseline(workspace);
            }
            catch (error) {
                await fs.rm(file, { force: true });
                throw error;
            }
            return {
                workspace,
                baseline,
                async release() {
                    const current = await readLease(file);
                    if (current?.token === token)
                        await fs.rm(file, { force: true });
                },
            };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const current = await readLease(file);
            if (current?.pid && processAlive(current.pid)) {
                throw new Error(`Another implementation job already owns this worktree: ${current.jobId ?? "unknown"}`);
            }
            await fs.rm(file, { force: true });
        }
    }
    throw new Error("Unable to acquire the implementation worktree lease");
}
export async function assertWorktreeBaseline(cwd, baseline) {
    const head = await headRevision(cwd);
    if (head !== baseline.head) {
        throw new Error("The worktree HEAD changed while the delegated implementation was running");
    }
}
export async function captureIgnoredPaths(cwd) {
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
export async function validateChangedPaths(cwd, changedFiles) {
    const root = await fs.realpath(await resolveWorkspaceRoot(cwd));
    for (const file of changedFiles) {
        const absolute = path.resolve(root, file);
        if (!isInside(root, absolute))
            throw new Error(`Changed path escaped the worktree: ${file}`);
        let stat;
        try {
            stat = await fs.lstat(absolute);
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            const target = path.resolve(path.dirname(absolute), await fs.readlink(absolute));
            const resolvedTarget = await fs.realpath(target).catch((error) => {
                if (error.code === "ENOENT")
                    return target;
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
export async function captureWorktreeChanges(cwd) {
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
    const untrackedDiffs = [];
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
async function captureWorktreeBaseline(cwd) {
    return {
        head: await headRevision(cwd),
        ignoredPaths: await captureIgnoredPaths(cwd),
    };
}
async function headRevision(cwd) {
    try {
        return (await gitOutput(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
    }
    catch {
        return null;
    }
}
async function diffUntrackedFile(cwd, file) {
    try {
        const { stdout } = await execFileAsync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", file], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        return stdout;
    }
    catch (error) {
        const gitError = error;
        if (gitError.code === 1)
            return gitError.stdout ?? "";
        throw error;
    }
}
export function parsePorcelain(output) {
    const records = output.split("\0");
    const entries = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record)
            continue;
        const status = record.slice(0, 2);
        entries.push({ status, path: record.slice(3) });
        if (status.includes("R") || status.includes("C"))
            index += 1;
    }
    return entries;
}
async function gitOutput(cwd, args, maxBuffer = 4 * 1024 * 1024) {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer });
    return stdout;
}
async function readLease(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        return undefined;
    }
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
