import { execFile } from "node:child_process";
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
