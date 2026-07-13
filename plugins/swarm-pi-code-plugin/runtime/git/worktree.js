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
export class WorktreeBaselineError extends Error {
    changedPaths;
    code = "baseline-side-effect";
    constructor(changedPaths) {
        super(`Preserved workspace paths changed during delegated execution: ${changedPaths.join(", ")}`);
        this.changedPaths = changedPaths;
        this.name = "WorktreeBaselineError";
    }
}
export async function inspectWorktree(cwd) {
    const assessment = await assessWorkspace(cwd);
    if (!assessment.git) {
        throw new Error(`Implementation requires a Git repository; workspace is ${assessment.disposition}`);
    }
    const relevant = assessment.entries.filter((entry) => entry.category === "user" || entry.category === "unsafe");
    const entries = relevant.map(({ status, path: entryPath }) => ({ status, path: entryPath }));
    const changedFiles = [...new Set(entries.map((entry) => entry.path))].sort();
    return { clean: entries.length === 0, changedFiles, entries, assessment };
}
export async function assessWorkspace(cwd) {
    const root = await fs.realpath(await resolveWorkspaceRoot(cwd)).catch(() => path.resolve(cwd));
    let output;
    try {
        output = await gitOutput(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    }
    catch {
        const inventory = await inventoryDirectory(root);
        const visible = inventory.entries.filter((entry) => entry.category === "user" || entry.category === "unsafe");
        const disposition = inventory.entries.some((entry) => entry.category === "unsafe")
            ? "unsafe"
            : visible.length === 0
                ? "non-git-empty"
                : "non-git-existing";
        return {
            root,
            git: false,
            head: null,
            disposition,
            entries: inventory.entries,
            fingerprint: fingerprint(inventory.fingerprints),
        };
    }
    const raw = parsePorcelain(output);
    const assessments = [];
    for (const entry of raw)
        assessments.push(await assessEntry(root, entry));
    const head = await headRevision(root);
    const disposition = assessments.some((entry) => entry.category === "unsafe")
        ? "unsafe"
        : head === null
            ? "git-unborn"
            : assessments.some((entry) => entry.category === "user")
                ? "user-dirty"
                : assessments.length > 0
                    ? "safe-dirty"
                    : "clean";
    return {
        root,
        git: true,
        head,
        disposition,
        entries: assessments,
        fingerprint: await gitWorkspaceFingerprint(root, assessments),
    };
}
async function assessEntry(root, entry) {
    const absolute = path.resolve(root, entry.path);
    const stat = await fs.lstat(absolute).catch(() => undefined);
    if (entry.status.includes("U") ||
        stat?.isSymbolicLink() ||
        (stat && !stat.isFile() && !stat.isDirectory())) {
        return { ...entry, category: "unsafe", reason: "conflict, link, or unsupported file type" };
    }
    if (entry.status === "??" && isRuntimePath(entry.path)) {
        return { ...entry, category: "runtime", reason: "plugin runtime state" };
    }
    if (entry.status === "??" && isSafeGeneratedPath(entry.path)) {
        return { ...entry, category: "ephemeral", reason: "recognized generated artifact" };
    }
    return {
        ...entry,
        category: "user",
        reason: entry.status === "??" ? "unknown untracked content" : "tracked or staged content",
    };
}
function isRuntimePath(value) {
    const normalized = value.split(path.sep).join("/");
    return [".swarm-pi-code-plugin", ".swarm-pi-code", ".swarm-code"].some((directory) => normalized === directory || normalized.startsWith(`${directory}/`));
}
function isSafeGeneratedPath(value) {
    const normalized = value.split(path.sep).join("/");
    const basename = path.posix.basename(normalized);
    return (basename === ".DS_Store" ||
        normalized.split("/").includes("__pycache__") ||
        /\.(?:pyc|pyo)$/.test(basename));
}
function fingerprint(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function gitWorkspaceFingerprint(root, entries) {
    const head = await headRevision(root);
    const content = await Promise.all(entries.map(async (entry) => ({
        path: entry.path,
        status: entry.status,
        category: entry.category,
        digest: await digestWorkspacePath(path.join(root, entry.path)),
    })));
    return fingerprint({ head, entries: content });
}
async function digestWorkspacePath(file) {
    const stat = await fs.lstat(file).catch((error) => {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    });
    if (!stat)
        return { missing: true };
    if (stat.isSymbolicLink())
        return { link: await fs.readlink(file), mode: stat.mode };
    if (stat.isFile()) {
        return {
            file: true,
            mode: stat.mode,
            size: stat.size,
            digest: createHash("sha256")
                .update(await fs.readFile(file))
                .digest("hex"),
        };
    }
    if (!stat.isDirectory())
        return { unsupported: true, mode: stat.mode, size: stat.size };
    const children = await fs.readdir(file, { withFileTypes: true });
    return {
        directory: true,
        mode: stat.mode,
        children: await Promise.all(children
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(async (child) => ({
            name: child.name,
            digest: await digestWorkspacePath(path.join(file, child.name)),
        }))),
    };
}
async function inventoryDirectory(root) {
    const entries = [];
    const fingerprints = [];
    async function visit(directory, prefix = "") {
        const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
            const relative = prefix ? `${prefix}/${child.name}` : child.name;
            const absolute = path.join(directory, child.name);
            const stat = await fs.lstat(absolute);
            const category = isRuntimePath(relative)
                ? "runtime"
                : isSafeGeneratedPath(relative)
                    ? "ephemeral"
                    : "user";
            if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) {
                entries.push({
                    path: relative,
                    status: "??",
                    category: "unsafe",
                    reason: "link or unsupported file type",
                });
                fingerprints.push([relative, "unsafe", stat.mode, stat.size]);
                continue;
            }
            if (child.isDirectory()) {
                if (category === "runtime" || category === "ephemeral") {
                    entries.push({
                        path: relative,
                        status: "??",
                        category,
                        reason: category === "runtime" ? "plugin runtime state" : "recognized generated artifact",
                    });
                }
                await visit(absolute, relative);
                continue;
            }
            entries.push({
                path: relative,
                status: "??",
                category,
                reason: category === "user"
                    ? "existing non-Git content"
                    : category === "runtime"
                        ? "plugin runtime state"
                        : "recognized generated artifact",
            });
            const digest = createHash("sha256")
                .update(await fs.readFile(absolute))
                .digest("hex");
            fingerprints.push([relative, stat.mode, stat.size, digest]);
        }
    }
    await visit(root);
    return { entries, fingerprints };
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
    const changedPaths = [];
    for (const entry of baseline.preservedEntries) {
        const digest = fingerprint(await digestWorkspacePath(path.join(cwd, entry.path)));
        if (digest !== entry.digest)
            changedPaths.push(entry.path);
    }
    if (changedPaths.length > 0)
        throw new WorktreeBaselineError(changedPaths);
}
export async function captureIgnoredPaths(cwd) {
    const output = await gitOutput(cwd, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"], 8 * 1024 * 1024);
    return output
        .split("\0")
        .filter((record) => record.startsWith("!! "))
        .map((record) => record.slice(3))
        .sort();
}
export async function validateChangedPaths(cwd, changedFiles) {
    const root = await fs.realpath(await resolveWorkspaceRoot(cwd));
    for (const file of changedFiles) {
        if (isProtectedWorkspacePath(file))
            throw new Error(`Changed path is protected by the delegated worker boundary: ${file}`);
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
export function isProtectedWorkspacePath(value) {
    const normalized = value.split(path.sep).join("/").replace(/^\.\//, "");
    const first = normalized.split("/")[0] ?? "";
    return ([".git", ".swarm-pi-code-plugin", ".swarm-pi-code", ".swarm-code"].includes(first) ||
        [".env", ".env.local", ".swarm-pi-policy.json"].includes(normalized));
}
export async function captureWorktreeChanges(cwd) {
    const inspection = await inspectWorktree(cwd);
    const head = await headRevision(cwd);
    const [{ stdout: diff }, { stdout: trackedStat }] = head === null
        ? [{ stdout: "" }, { stdout: "" }]
        : await Promise.all([
            execFileAsync("git", ["diff", "--binary", "--no-ext-diff", head, "--"], {
                cwd,
                encoding: "utf8",
                maxBuffer: 16 * 1024 * 1024,
            }),
            execFileAsync("git", ["diff", "--stat", head, "--"], {
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
    const assessment = await assessWorkspace(cwd);
    const safePaths = assessment.entries
        .filter((entry) => entry.category === "runtime" || entry.category === "ephemeral")
        .map((entry) => entry.path);
    return {
        head: assessment.head,
        ignoredPaths: await captureIgnoredPaths(cwd),
        safePaths,
        preservedEntries: await Promise.all(safePaths.map(async (entryPath) => ({
            path: entryPath,
            digest: fingerprint(await digestWorkspacePath(path.join(cwd, entryPath))),
        }))),
        workspaceFingerprint: assessment.fingerprint,
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
    return (relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)));
}
