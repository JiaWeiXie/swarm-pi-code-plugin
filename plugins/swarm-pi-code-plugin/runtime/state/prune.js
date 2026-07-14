import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { jobWorktreeBranch } from "../git/job-worktree.js";
import { JOB_STALE_AFTER_MS, readJobResult } from "./jobs.js";
import { loadState, resolveStateDir, resolveWorkspaceRoot, updateState } from "./state.js";
const execFileAsync = promisify(execFile);
const PRUNABLE_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export async function pruneJobs(cwd, options) {
    const started = options.now ?? new Date();
    const cutoffMs = started.getTime() - options.olderThanMs;
    const stateDir = await resolveStateDir(cwd);
    if (!options.apply)
        return createPreview(cwd, stateDir, cutoffMs, options, started);
    const lock = await acquirePruneLock(stateDir);
    try {
        const report = await createPreview(cwd, stateDir, cutoffMs, options, started);
        report.mode = "apply";
        for (const item of report.jobs) {
            if (!item.eligible)
                continue;
            try {
                const applied = await applyJobPrune(cwd, stateDir, item, options);
                Object.assign(item, applied);
                report.summary.pruned += 1;
                report.summary.actualBytes += applied.artifactBytes;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                item.error = message;
                item.reasons = ["prune-failed"];
                item.actions.artifacts = "retain";
                report.errors.push({ jobId: item.jobId, message });
                report.summary.failed += 1;
                await recordOperationError(cwd, item.jobId, message);
            }
        }
        report.summary.retained = report.summary.examined - report.summary.pruned;
        report.success = report.errors.length === 0;
        report.finishedAt = new Date().toISOString();
        return report;
    }
    finally {
        await lock.close();
        await fs.rm(path.join(stateDir, "prune.lock"), { force: true });
    }
}
export function formatPruneReport(report) {
    const lines = [
        `Job prune ${report.mode}: cutoff ${report.cutoff}`,
        `Examined ${report.summary.examined}; eligible ${report.summary.eligible}; pruned ${report.summary.pruned}; retained ${report.summary.retained}; failed ${report.summary.failed}.`,
        `${report.mode === "preview" ? "Estimated" : "Actual"} artifact bytes: ${report.mode === "preview" ? report.summary.estimatedBytes : report.summary.actualBytes}.`,
    ];
    for (const job of report.jobs) {
        const disposition = job.error
            ? `failed: ${job.error}`
            : job.eligible
                ? `${report.mode === "apply" ? "pruned" : "eligible"}; ${job.artifactBytes} bytes; worktree=${job.actions.worktree}; branch=${job.actions.branch}`
                : `retained: ${job.reasons.join(", ")}`;
        lines.push(`- ${job.jobId} (${job.status}): ${disposition}`);
    }
    if (report.orphans.length > 0) {
        lines.push(`Orphan job directories (report only): ${report.orphans.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
}
async function createPreview(cwd, stateDir, cutoffMs, options, started) {
    const state = await loadState(cwd, { migrateLegacy: false });
    const reports = [];
    const errors = [];
    for (const job of state.jobs) {
        try {
            reports.push(await assessJob(cwd, stateDir, state, job, cutoffMs));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push({ jobId: job.id, message });
            reports.push({
                jobId: job.id,
                status: String(job.status),
                finishedAt: typeof job.finishedAt === "string" ? job.finishedAt : null,
                eligible: false,
                reasons: ["assessment-failed"],
                artifactBytes: 0,
                actions: { artifacts: "retain", worktree: "retain", branch: "retain" },
                error: message,
            });
        }
    }
    const orphans = await findOrphanDirectories(stateDir, state);
    const eligible = reports.filter((job) => job.eligible);
    return {
        schemaVersion: 1,
        mode: options.apply ? "apply" : "preview",
        cutoff: new Date(cutoffMs).toISOString(),
        olderThanMs: options.olderThanMs,
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        success: errors.length === 0,
        summary: {
            examined: reports.length,
            eligible: eligible.length,
            pruned: 0,
            retained: reports.length - eligible.length,
            failed: errors.length,
            estimatedBytes: eligible.reduce((total, job) => total + job.artifactBytes, 0),
            actualBytes: 0,
            orphans: orphans.length,
        },
        jobs: reports,
        orphans,
        errors,
    };
}
async function assessJob(cwd, stateDir, state, job, cutoffMs) {
    const reasons = [];
    const operation = pruneOperation(job);
    const validJobId = safeJobId(job.id);
    const finishedAt = typeof job.finishedAt === "string" ? job.finishedAt : null;
    const finishedMs = finishedAt ? Date.parse(finishedAt) : Number.NaN;
    if (!validJobId)
        reasons.push("unsafe-job-id");
    if (typeof job.prunedAt === "string")
        reasons.push("already-pruned");
    if (!PRUNABLE_STATUSES.has(String(job.status)))
        reasons.push("status-not-prunable");
    if (!Number.isFinite(finishedMs))
        reasons.push("missing-finished-at");
    else if (finishedMs >= cutoffMs)
        reasons.push("newer-than-cutoff");
    if (hasPendingNotification(job))
        reasons.push("pending-notification");
    if (hasPendingApproval(job))
        reasons.push("pending-approval");
    if (hasPendingHostRequest(job))
        reasons.push("pending-host-assistance");
    if (validJobId && (await hasLiveWorker(stateDir, job)))
        reasons.push("active-worker");
    let workspace = {
        safe: true,
        reason: "no-workspace",
        worktreeAction: "none",
        branchAction: "none",
        scaffold: false,
    };
    if (reasons.length === 0 || operation) {
        workspace = await assessWorkspace(cwd, state, job);
        if (!workspace.safe)
            reasons.push(workspace.reason);
    }
    if (validJobId && (await hasRecoverableArtifact(cwd, job))) {
        reasons.push("recoverable-artifact");
    }
    const jobDir = path.join(stateDir, "jobs", job.id);
    const quarantine = operation ? quarantinePath(stateDir, job.id, operation.id) : undefined;
    const [jobStat, quarantineStat] = validJobId
        ? await Promise.all([
            fs.lstat(jobDir).catch(() => undefined),
            quarantine ? fs.lstat(quarantine).catch(() => undefined) : undefined,
        ])
        : [undefined, undefined];
    if (jobStat?.isSymbolicLink() || quarantineStat?.isSymbolicLink()) {
        reasons.push("artifact-directory-is-symbolic-link");
    }
    if (jobStat && quarantineStat)
        reasons.push("ambiguous-prune-artifacts");
    const artifactBytes = validJobId ? await logicalBytes(quarantine ?? jobDir) : 0;
    const resumeBlockers = new Set([
        "unsafe-job-id",
        "already-pruned",
        "pending-notification",
        "pending-approval",
        "pending-host-assistance",
        "active-worker",
        "recoverable-artifact",
        "artifact-directory-is-symbolic-link",
        "ambiguous-prune-artifacts",
    ]);
    const eligible = operation
        ? !reasons.some((reason) => resumeBlockers.has(reason)) && workspace.safe
        : reasons.length === 0;
    return {
        jobId: job.id,
        status: String(job.status),
        finishedAt,
        eligible,
        reasons: eligible ? (operation ? ["resume-incomplete-operation"] : []) : reasons,
        artifactBytes,
        actions: {
            artifacts: eligible ? "delete" : "retain",
            worktree: eligible
                ? workspace.worktreeAction
                : workspace.worktreeAction === "none"
                    ? "none"
                    : "retain",
            branch: eligible
                ? workspace.branchAction
                : workspace.branchAction === "none"
                    ? "none"
                    : "retain",
        },
        ...(operation ? { operationId: operation.id } : {}),
    };
}
async function applyJobPrune(cwd, stateDir, report, options) {
    const preclaimState = await loadState(cwd, { migrateLegacy: false });
    const preclaimJob = requireJob(preclaimState, report.jobId);
    if (await hasLiveWorker(stateDir, preclaimJob)) {
        throw new Error(`Job gained an active worker before prune claim: ${report.jobId}`);
    }
    if (await hasRecoverableArtifact(cwd, preclaimJob)) {
        throw new Error(`Job gained a recoverable artifact before prune claim: ${report.jobId}`);
    }
    const operation = await claimOperation(cwd, report);
    await options.afterPhase?.(report.jobId, "claimed");
    let current = operation;
    if (current.phase === "claimed") {
        const state = await loadState(cwd, { migrateLegacy: false });
        const job = requireJob(state, report.jobId);
        const assessment = await assessWorkspace(cwd, state, job);
        if (!assessment.safe)
            throw new Error(`Workspace became unsafe: ${assessment.reason}`);
        await removeWorkspace(cwd, assessment);
        current = await setOperationPhase(cwd, report.jobId, "workspace-cleaned", {
            worktreeDisposition: assessment.worktreeAction === "remove" ? "removed" : "none",
            branchDisposition: assessment.branchAction === "remove"
                ? "removed"
                : assessment.branchAction === "contained"
                    ? "contained"
                    : "none",
        });
        await options.afterPhase?.(report.jobId, "workspace-cleaned");
    }
    const source = path.join(stateDir, "jobs", report.jobId);
    const quarantine = quarantinePath(stateDir, report.jobId, current.id);
    if (current.phase === "workspace-cleaned" || current.phase === "claimed") {
        const [sourceStat, quarantineStat] = await Promise.all([
            fs.lstat(source).catch(() => undefined),
            fs.lstat(quarantine).catch(() => undefined),
        ]);
        if (sourceStat?.isSymbolicLink())
            throw new Error("Job artifact directory is a symbolic link");
        if (sourceStat && quarantineStat)
            throw new Error("Both job and quarantine directories exist");
        if (sourceStat)
            await fs.rename(source, quarantine);
        current = await setOperationPhase(cwd, report.jobId, "quarantined");
        await options.afterPhase?.(report.jobId, "quarantined");
    }
    if (current.phase === "quarantined") {
        const bytes = await logicalBytes(quarantine);
        current = await setOperationPhase(cwd, report.jobId, "quarantined", {
            artifactBytes: Math.max(current.artifactBytes, bytes),
        });
        await fs.rm(quarantine, { recursive: true, force: true });
        current = await setOperationPhase(cwd, report.jobId, "artifacts-removed");
        await options.afterPhase?.(report.jobId, "artifacts-removed");
    }
    const prunedAt = new Date().toISOString();
    await updateState(cwd, (state) => {
        const index = state.jobs.findIndex((job) => job.id === report.jobId);
        if (index < 0)
            throw new Error(`Unknown job: ${report.jobId}`);
        const job = state.jobs[index];
        const active = pruneOperation(job);
        if (!active || active.id !== current.id)
            throw new Error(`Prune operation changed: ${report.jobId}`);
        state.jobs[index] = createTombstone(job, current, prunedAt);
    });
    return {
        artifactBytes: current.artifactBytes,
        operationId: current.id,
        reasons: [],
        actions: {
            artifacts: "deleted",
            worktree: current.worktreeDisposition === "removed" ? "removed" : "none",
            branch: current.branchDisposition === "removed"
                ? "removed"
                : current.branchDisposition === "contained"
                    ? "contained"
                    : "none",
        },
    };
}
async function claimOperation(cwd, report) {
    let operation;
    await updateState(cwd, (state) => {
        const job = requireJob(state, report.jobId);
        const existing = pruneOperation(job);
        if (existing) {
            operation = structuredClone(existing);
            return;
        }
        if (job.status !== report.status || job.finishedAt !== report.finishedAt) {
            throw new Error(`Job changed before prune claim: ${report.jobId}`);
        }
        if (hasPendingNotification(job) || hasPendingApproval(job) || hasPendingHostRequest(job)) {
            throw new Error(`Job gained pending Host work before prune claim: ${report.jobId}`);
        }
        const now = new Date().toISOString();
        operation = {
            id: randomUUID(),
            phase: "claimed",
            startedAt: now,
            updatedAt: now,
            artifactBytes: 0,
            worktreeDisposition: "none",
            branchDisposition: "none",
        };
        job.pruneOperation = structuredClone(operation);
    });
    return operation;
}
async function setOperationPhase(cwd, jobId, phase, patch = {}) {
    let operation;
    await updateState(cwd, (state) => {
        const job = requireJob(state, jobId);
        const current = pruneOperation(job);
        if (!current)
            throw new Error(`Missing prune operation: ${jobId}`);
        operation = { ...current, ...patch, phase, updatedAt: new Date().toISOString() };
        delete operation.lastError;
        job.pruneOperation = structuredClone(operation);
    });
    return operation;
}
async function recordOperationError(cwd, jobId, message) {
    await updateState(cwd, (state) => {
        const job = state.jobs.find((candidate) => candidate.id === jobId);
        const operation = job && pruneOperation(job);
        if (!job || !operation)
            return;
        job.pruneOperation = {
            ...operation,
            updatedAt: new Date().toISOString(),
            lastError: message.slice(0, 500),
        };
    }).catch(() => { });
}
function createTombstone(job, operation, prunedAt) {
    return {
        id: job.id,
        status: job.status,
        ...(job.host ? { host: job.host } : {}),
        ...(job.kind ? { kind: job.kind } : {}),
        ...(job.createdAt ? { createdAt: job.createdAt } : {}),
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        updatedAt: prunedAt,
        prunedAt,
        pruneOperationId: operation.id,
        prunedArtifactBytes: operation.artifactBytes,
        worktreeDisposition: operation.worktreeDisposition,
        branchDisposition: operation.branchDisposition,
    };
}
async function assessWorkspace(cwd, state, job) {
    const workspace = executionWorkspace(job);
    if (!workspace) {
        return {
            safe: true,
            reason: "no-workspace",
            worktreeAction: "none",
            branchAction: "none",
            scaffold: false,
        };
    }
    const duplicate = state.jobs.some((candidate) => {
        if (candidate.id === job.id)
            return false;
        const other = executionWorkspace(candidate);
        return (other?.worktree === workspace.worktree ||
            (job.kind !== "scaffold" && other?.branch === workspace.branch));
    });
    if (duplicate)
        return unsafeWorkspace("workspace-referenced-by-another-job", workspace, job);
    if (job.kind === "scaffold")
        return assessScaffoldWorkspace(job, workspace);
    if (workspace.branch !== jobWorktreeBranch(job.id)) {
        return unsafeWorkspace("workspace-ownership-mismatch", workspace, job);
    }
    const root = await resolveWorkspaceRoot(cwd);
    const registrations = await gitWorktrees(root);
    const ownedWorktree = await canonicalPath(workspace.worktree);
    let registration;
    for (const candidate of registrations) {
        if ((await canonicalPath(candidate.worktree)) === ownedWorktree) {
            registration = candidate;
            break;
        }
    }
    const branchRegistrations = registrations.filter((candidate) => candidate.branch === `refs/heads/${workspace.branch}`);
    const worktreeStat = await fs.lstat(workspace.worktree).catch(() => undefined);
    if (worktreeStat?.isSymbolicLink())
        return unsafeWorkspace("worktree-is-symbolic-link", workspace, job);
    if (worktreeStat && !registration)
        return unsafeWorkspace("worktree-not-registered", workspace, job);
    if (registration && registration.branch !== `refs/heads/${workspace.branch}`) {
        return unsafeWorkspace("worktree-branch-mismatch", workspace, job);
    }
    if (branchRegistrations.length > 1) {
        return unsafeWorkspace("branch-used-by-multiple-worktrees", workspace, job);
    }
    if (worktreeStat) {
        const status = await git(workspace.worktree, ["status", "--porcelain=v1"]);
        if (status.trim())
            return unsafeWorkspace("worktree-has-uncommitted-changes", workspace, job);
    }
    const tip = await git(root, ["rev-parse", "--verify", `refs/heads/${workspace.branch}`]).catch(() => undefined);
    if (tip) {
        const integrated = await branchIsDisposable(root, tip.trim(), workspace.base, job);
        if (!integrated)
            return unsafeWorkspace("recoverable-artifact", workspace, job);
    }
    else if (worktreeStat || registration) {
        return unsafeWorkspace("registered-worktree-without-owned-branch", workspace, job);
    }
    return {
        safe: true,
        reason: "workspace-disposable",
        worktreeAction: worktreeStat || registration ? "remove" : "none",
        branchAction: tip ? "remove" : "none",
        workspace,
        scaffold: false,
    };
}
async function assessScaffoldWorkspace(job, workspace) {
    if (workspace.branch !== "main" ||
        path.basename(workspace.worktree) !== job.id ||
        path.basename(path.dirname(workspace.worktree)) !== "swarm-pi-scaffolds") {
        return unsafeWorkspace("workspace-ownership-mismatch", workspace, job, true);
    }
    const stat = await fs.lstat(workspace.worktree).catch(() => undefined);
    if (!stat) {
        return {
            safe: true,
            reason: "workspace-absent",
            worktreeAction: "none",
            branchAction: "none",
            workspace,
            scaffold: true,
        };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return unsafeWorkspace("worktree-is-not-a-directory", workspace, job, true);
    }
    const [root, status, tip] = await Promise.all([
        git(workspace.worktree, ["rev-parse", "--show-toplevel"]).catch(() => ""),
        git(workspace.worktree, ["status", "--porcelain=v1"]).catch(() => "<invalid>"),
        git(workspace.worktree, ["rev-parse", "HEAD"]).catch(() => ""),
    ]);
    if (path.resolve(root.trim()) !== path.resolve(workspace.worktree)) {
        return unsafeWorkspace("scaffold-worktree-root-mismatch", workspace, job, true);
    }
    if (status.trim())
        return unsafeWorkspace("worktree-has-uncommitted-changes", workspace, job, true);
    if (typeof job.materializedAt !== "string" && tip.trim() !== workspace.base) {
        return unsafeWorkspace("recoverable-artifact", workspace, job, true);
    }
    return {
        safe: true,
        reason: "workspace-disposable",
        worktreeAction: "remove",
        branchAction: "contained",
        workspace,
        scaffold: true,
    };
}
function unsafeWorkspace(reason, workspace, job, scaffold = job.kind === "scaffold") {
    return {
        safe: false,
        reason,
        worktreeAction: "remove",
        branchAction: scaffold ? "contained" : "remove",
        workspace,
        scaffold,
    };
}
async function branchIsDisposable(root, tip, base, job) {
    if (typeof job.materializedAt === "string" || tip === base)
        return true;
    return git(root, ["merge-base", "--is-ancestor", tip, "HEAD"])
        .then(() => true)
        .catch(() => false);
}
async function removeWorkspace(cwd, assessment) {
    if (!assessment.workspace || assessment.worktreeAction === "none") {
        if (assessment.workspace && assessment.branchAction === "remove") {
            const root = await resolveWorkspaceRoot(cwd);
            await git(root, ["branch", "-D", "--", assessment.workspace.branch]);
        }
        return;
    }
    if (assessment.scaffold) {
        await fs.rm(assessment.workspace.worktree, { recursive: true, force: true });
        return;
    }
    const root = await resolveWorkspaceRoot(cwd);
    await git(root, ["worktree", "remove", "--force", assessment.workspace.worktree]);
    if (assessment.branchAction === "remove") {
        await git(root, ["branch", "-D", "--", assessment.workspace.branch]);
    }
}
function executionWorkspace(job) {
    const value = job.executionWorkspace;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const candidate = value;
    if (typeof candidate.worktree !== "string" ||
        typeof candidate.branch !== "string" ||
        typeof candidate.base !== "string") {
        return undefined;
    }
    return { worktree: candidate.worktree, branch: candidate.branch, base: candidate.base };
}
async function hasRecoverableArtifact(cwd, job) {
    if (typeof job.materializedAt === "string")
        return false;
    const result = await readJobResult(cwd, job.id);
    if (!result?.artifact?.deliverable)
        return false;
    const workspace = executionWorkspace(job);
    const commit = result.artifact.commit;
    if (job.kind === "scaffold" || !workspace || typeof commit !== "string" || !commit)
        return true;
    const root = await resolveWorkspaceRoot(cwd);
    return git(root, ["merge-base", "--is-ancestor", commit, "HEAD"])
        .then(() => false)
        .catch(() => true);
}
function hasPendingNotification(job) {
    return (job.notification === "pending" ||
        job.notifications?.some((notification) => notification.status === "pending") === true);
}
function hasPendingApproval(job) {
    return (typeof job.pendingApprovalId === "string" ||
        job.approvals?.some((approval) => approval.status === "pending" || approval.notification === "pending") === true);
}
function hasPendingHostRequest(job) {
    return ((job.pendingHostRequestIds?.length ?? 0) > 0 ||
        job.hostAssistanceRequests?.some((request) => request.status === "pending") === true);
}
async function hasLiveWorker(stateDir, job) {
    const heartbeat = await readJson(path.join(stateDir, "jobs", job.id, "heartbeat.json"));
    const heartbeatAt = Date.parse(heartbeat?.updatedAt ?? "");
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= JOB_STALE_AFTER_MS)
        return true;
    const updatedAt = Date.parse(job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
    const pid = heartbeat?.pid ?? (typeof job.pid === "number" ? job.pid : undefined);
    return Boolean(pid &&
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt <= JOB_STALE_AFTER_MS &&
        processAlive(pid));
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
async function logicalBytes(target) {
    const stat = await fs.lstat(target).catch(() => undefined);
    if (!stat)
        return 0;
    if (!stat.isDirectory() || stat.isSymbolicLink())
        return stat.size;
    let total = 0;
    for (const entry of await fs.readdir(target))
        total += await logicalBytes(path.join(target, entry));
    return total;
}
async function findOrphanDirectories(stateDir, state) {
    const jobsDir = path.join(stateDir, "jobs");
    const known = new Set(state.jobs.map((job) => job.id));
    const activeQuarantines = new Set(state.jobs.flatMap((job) => {
        const operation = pruneOperation(job);
        return operation ? [path.basename(quarantinePath(stateDir, job.id, operation.id))] : [];
    }));
    const entries = await fs.readdir(jobsDir, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) &&
        !known.has(entry.name) &&
        !activeQuarantines.has(entry.name))
        .map((entry) => entry.name)
        .sort();
}
function pruneOperation(job) {
    const value = job.pruneOperation;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const candidate = value;
    if (typeof candidate.id !== "string" ||
        !safeToken(candidate.id) ||
        !["claimed", "workspace-cleaned", "quarantined", "artifacts-removed"].includes(String(candidate.phase)) ||
        typeof candidate.startedAt !== "string" ||
        typeof candidate.updatedAt !== "string") {
        return undefined;
    }
    return {
        id: candidate.id,
        phase: candidate.phase,
        startedAt: candidate.startedAt,
        updatedAt: candidate.updatedAt,
        artifactBytes: Number(candidate.artifactBytes) || 0,
        worktreeDisposition: candidate.worktreeDisposition ?? "none",
        branchDisposition: candidate.branchDisposition ?? "none",
        ...(candidate.lastError ? { lastError: candidate.lastError } : {}),
    };
}
function requireJob(state, jobId) {
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job)
        throw new Error(`Unknown job: ${jobId}`);
    return job;
}
function safeJobId(jobId) {
    return (jobId.length > 0 &&
        jobId !== "." &&
        jobId !== ".." &&
        path.basename(jobId) === jobId &&
        !jobId.includes("/") &&
        !jobId.includes("\\"));
}
function safeToken(value) {
    return value.length > 0 && /^[a-zA-Z0-9-]+$/.test(value);
}
function quarantinePath(stateDir, jobId, operationId) {
    return path.join(stateDir, "jobs", `.prune-${jobId}-${operationId}`);
}
async function acquirePruneLock(stateDir) {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(stateDir, "prune.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await fs.open(lockFile, "wx", 0o600);
            await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
            return handle;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const stale = await staleLock(lockFile);
            if (attempt === 0 && stale) {
                await fs.rm(lockFile, { force: true });
                continue;
            }
            throw new Error(`Another prune operation is active: ${lockFile}`);
        }
    }
    throw new Error(`Unable to acquire prune lock: ${lockFile}`);
}
async function staleLock(lockFile) {
    const [stat, value] = await Promise.all([
        fs.stat(lockFile).catch(() => undefined),
        readJson(lockFile),
    ]);
    if (!stat || Date.now() - stat.mtimeMs <= JOB_STALE_AFTER_MS)
        return false;
    return !value?.pid || !processAlive(value.pid);
}
async function gitWorktrees(cwd) {
    const output = await git(cwd, ["worktree", "list", "--porcelain"]);
    return output
        .trim()
        .split(/\n\n+/)
        .filter(Boolean)
        .map((block) => {
        const lines = block.split("\n");
        const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
        const branch = lines.find((line) => line.startsWith("branch "))?.slice(7);
        if (!worktree)
            throw new Error("Git returned an invalid worktree registration");
        return { worktree, ...(branch ? { branch } : {}) };
    });
}
async function canonicalPath(value) {
    return fs.realpath(value).catch(() => path.resolve(value));
}
async function git(cwd, args) {
    return (await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }))
        .stdout;
}
async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
