import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadState, resolveStateDir, updateState } from "./state.js";
export const JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export const JOB_STALE_AFTER_MS = 60_000;
export async function startJob(cwd, input) {
    await reconcileJobs(cwd);
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const workerToken = randomUUID();
    const createdAt = new Date().toISOString();
    const sandboxMode = input.sandboxMode ?? "strict";
    const directory = await jobDirectory(cwd, id);
    const request = {
        requestVersion: 2,
        id,
        host: input.host,
        kind: input.kind,
        cwd: input.cwd,
        executionMode: input.executionMode,
        sandboxMode,
        timeoutMs: input.timeoutMs,
        ...(input.model ? { model: input.model } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
        ...(input.delegationSpec ? { delegationSpec: input.delegationSpec } : {}),
        ...(input.policySnapshot ? { policySnapshot: input.policySnapshot } : {}),
        ...(input.workspaceStrategy ? { workspaceStrategy: input.workspaceStrategy } : {}),
        ...(input.target ? { target: input.target } : {}),
        ...(input.scaffoldSpec ? { scaffoldSpec: input.scaffoldSpec } : {}),
        ...(input.adoptExisting ? { adoptExisting: true } : {}),
        workerToken,
        createdAt,
    };
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
        writeJson(path.join(directory, "request.json"), request),
        fs.writeFile(path.join(directory, "prompt.md"), input.prompt, { encoding: "utf8", mode: 0o600 }),
    ]);
    await updateState(cwd, (state) => {
        state.jobs.push({
            id,
            host: input.host,
            kind: input.kind,
            executionMode: input.executionMode,
            sandboxMode,
            timeoutMs: input.timeoutMs,
            ...(input.model ? { model: input.model } : {}),
            ...(input.role ? { role: input.role } : {}),
            generation: 1,
            approvals: [],
            leases: [],
            notifications: [],
            workerToken,
            status: "queued",
            createdAt,
            updatedAt: createdAt,
        });
    });
    return { id, workerToken };
}
export async function attachJobProcess(cwd, jobId, workerToken, pid) {
    const updatedAt = new Date().toISOString();
    const state = await updateState(cwd, (current) => {
        const job = requireJob(current.jobs, jobId);
        requireWorkerToken(job, workerToken);
        if (isTerminalJobStatus(job.status))
            return;
        job.pid = pid;
        job.updatedAt = updatedAt;
    });
    return requireJob(state.jobs, jobId);
}
export async function markJobRunning(cwd, jobId, workerToken, pid) {
    const startedAt = new Date().toISOString();
    const state = await updateState(cwd, (current) => {
        const job = requireJob(current.jobs, jobId);
        requireWorkerToken(job, workerToken);
        if (isTerminalJobStatus(job.status))
            return;
        job.status = "running";
        job.pid = pid;
        job.startedAt = job.startedAt ?? startedAt;
        job.updatedAt = startedAt;
    });
    await heartbeatJob(cwd, jobId, workerToken, pid);
    return requireJob(state.jobs, jobId);
}
export async function heartbeatJob(cwd, jobId, workerToken, pid) {
    await writeJson(path.join(await jobDirectory(cwd, jobId), "heartbeat.json"), {
        jobId,
        workerToken,
        pid,
        updatedAt: new Date().toISOString(),
    });
}
export async function finishJob(cwd, jobId, result, diff) {
    const directory = await jobDirectory(cwd, jobId);
    const claimed = await claimTerminal(directory);
    if (!claimed) {
        const existingResult = await readJobResult(cwd, jobId);
        if (existingResult)
            await applyResultToState(cwd, jobId, existingResult);
        return;
    }
    const finishedAt = new Date().toISOString();
    const finalResult = { ...result, jobId: result.jobId ?? jobId };
    await fs.mkdir(directory, { recursive: true });
    await writeJson(path.join(directory, "result.json"), finalResult);
    if (diff)
        await fs.writeFile(path.join(directory, "changes.patch"), diff, { encoding: "utf8", mode: 0o600 });
    await applyResultToState(cwd, jobId, finalResult, finishedAt);
}
async function applyResultToState(cwd, jobId, finalResult, finishedAt = new Date().toISOString()) {
    await updateState(cwd, (state) => {
        const existing = state.jobs.find((job) => job.id === jobId);
        const summary = {
            ...(existing ?? { id: jobId }),
            id: jobId,
            ...(finalResult.host ?? existing?.host ? { host: (finalResult.host ?? existing?.host) } : {}),
            kind: finalResult.kind,
            status: finalResult.status,
            ...(finalResult.model ? { model: finalResult.model } : {}),
            finishedAt,
            updatedAt: finishedAt,
            notification: "pending",
            notifications: terminalNotifications(existing?.notifications, finishedAt),
        };
        if (existing)
            Object.assign(existing, summary);
        else
            state.jobs.push(summary);
    });
}
export async function readJobRequest(cwd, jobId) {
    return readRequiredJson(path.join(await jobDirectory(cwd, jobId), "request.json"));
}
export async function updateJobExecutionWorkspace(cwd, jobId, workerToken, workspace) {
    const request = await readJobRequest(cwd, jobId);
    if (request.workerToken !== workerToken)
        throw new Error(`Worker token mismatch for job: ${jobId}`);
    await updateState(cwd, (state) => {
        const job = requireJob(state.jobs, jobId);
        requireWorkerToken(job, workerToken);
        if (isTerminalJobStatus(job.status))
            throw new Error(`Job is terminal: ${jobId}`);
        job.executionWorkspace = structuredClone(workspace);
        job.updatedAt = new Date().toISOString();
    });
    request.cwd = workspace.worktree;
    await writeJson(path.join(await jobDirectory(cwd, jobId), "request.json"), request);
}
export async function readJobPrompt(cwd, jobId) {
    return fs.readFile(path.join(await jobDirectory(cwd, jobId), "prompt.md"), "utf8");
}
export async function readJobResult(cwd, jobId) {
    return readJson(path.join(await jobDirectory(cwd, jobId), "result.json"));
}
export async function getJob(cwd, jobId) {
    await reconcileJobs(cwd);
    const state = await loadState(cwd);
    return {
        job: requireJob(state.jobs, jobId),
        result: await readJobResult(cwd, jobId),
    };
}
export async function listJobs(cwd, pendingNotifications = false) {
    await reconcileJobs(cwd);
    const state = await loadState(cwd);
    return state.jobs
        .filter((job) => !pendingNotifications || job.notification === "pending" ||
        job.notifications?.some((notification) => notification.status === "pending"))
        .sort((left, right) => timestamp(right) - timestamp(left));
}
export async function waitForJob(cwd, jobId, waitTimeoutMs) {
    const deadline = waitTimeoutMs === undefined ? undefined : Date.now() + waitTimeoutMs;
    while (true) {
        const snapshot = await getJob(cwd, jobId);
        if (snapshot.job.status === "awaiting-approval") {
            const approval = snapshot.job.approvals?.find((item) => item.id === snapshot.job.pendingApprovalId);
            if (approval)
                return { event: "approval-required", jobId, status: "awaiting-approval", approval };
        }
        if (isTerminalJobStatus(snapshot.job.status)) {
            if (snapshot.result)
                return snapshot.result;
            return terminalResult(snapshot.job, snapshot.job.status, `Job ${jobId} reached ${snapshot.job.status} without a result artifact.`);
        }
        if (deadline !== undefined && Date.now() >= deadline) {
            return { event: "wait-timed-out", jobId, status: snapshot.job.status };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}
export async function acknowledgeJob(cwd, jobId, notificationId) {
    const state = await updateState(cwd, (current) => {
        const job = requireJob(current.jobs, jobId);
        if (notificationId) {
            const notification = job.notifications?.find((item) => item.id === notificationId);
            if (!notification)
                throw new Error(`Unknown notification: ${notificationId}`);
            notification.status = "acknowledged";
            notification.acknowledgedAt = new Date().toISOString();
            if (notification.kind === "terminal")
                job.notification = "acknowledged";
            if (notification.approvalId) {
                const approval = job.approvals?.find((item) => item.id === notification.approvalId);
                if (approval)
                    approval.notification = "acknowledged";
            }
        }
        else {
            if (!isTerminalJobStatus(job.status))
                throw new Error(`Job is not terminal: ${jobId}`);
            job.notification = "acknowledged";
            for (const notification of job.notifications ?? []) {
                if (notification.kind === "terminal") {
                    notification.status = "acknowledged";
                    notification.acknowledgedAt = new Date().toISOString();
                }
            }
        }
        job.updatedAt = new Date().toISOString();
    });
    return requireJob(state.jobs, jobId);
}
export async function requestJobApproval(cwd, jobId, workerToken, input) {
    const requestedAt = new Date().toISOString();
    const approval = {
        id: randomUUID(),
        jobId,
        generation: 1,
        actionFingerprint: input.actionFingerprint,
        toolName: input.toolName,
        actionSummary: input.actionSummary.slice(0, 2_000),
        decision: structuredClone(input.decision),
        status: "pending",
        requestedAt,
        expiresAt: input.expiresAt,
        notificationId: randomUUID(),
        notification: "pending",
    };
    await updateState(cwd, (state) => {
        const job = requireJob(state.jobs, jobId);
        requireWorkerToken(job, workerToken);
        if (isTerminalJobStatus(job.status))
            throw new Error(`Job is terminal: ${jobId}`);
        if (job.pendingApprovalId) {
            const existing = job.approvals?.find((item) => item.id === job.pendingApprovalId && item.status === "pending");
            if (existing)
                throw new Error(`Job already has a pending approval: ${existing.id}`);
        }
        approval.generation = job.generation ?? 1;
        job.approvals ??= [];
        job.notifications ??= [];
        job.approvals.push(approval);
        job.notifications.push({
            id: approval.notificationId,
            kind: "approval",
            status: "pending",
            createdAt: requestedAt,
            approvalId: approval.id,
        });
        job.pendingApprovalId = approval.id;
        job.status = "awaiting-approval";
        job.updatedAt = requestedAt;
    });
    await writeJson(path.join(await jobDirectory(cwd, jobId), "approvals", `${approval.id}.json`), approval);
    return approval;
}
export async function listJobApprovals(cwd, jobId) {
    await reconcileJobs(cwd);
    return structuredClone((await getJob(cwd, jobId)).job.approvals ?? []);
}
export async function approveJob(cwd, jobId, approvalId, scope = "once") {
    const now = new Date();
    let resolvedApproval;
    let lease;
    const state = await updateState(cwd, (current) => {
        const job = requireJob(current.jobs, jobId);
        if (isTerminalJobStatus(job.status))
            throw new Error(`Job is terminal: ${jobId}`);
        const approval = requireApproval(job, approvalId);
        assertApprovalPending(job, approval, now);
        approval.status = "approved";
        approval.scope = scope;
        approval.resolvedAt = now.toISOString();
        lease = {
            id: randomUUID(),
            jobId,
            generation: approval.generation,
            policyHash: approval.decision.policyHash,
            role: (job.role ?? "scout"),
            actionFingerprint: approval.actionFingerprint,
            scope,
            capabilities: [...approval.decision.capabilities],
            createdAt: now.toISOString(),
            expiresAt: approval.expiresAt,
        };
        job.leases ??= [];
        job.leases.push(lease);
        delete job.pendingApprovalId;
        job.status = "running";
        job.updatedAt = now.toISOString();
        resolvedApproval = structuredClone(approval);
    });
    await writeJson(path.join(await jobDirectory(cwd, jobId), "approvals", `${approvalId}.json`), resolvedApproval);
    await writeJson(path.join(await jobDirectory(cwd, jobId), "leases", `${lease.id}.json`), lease);
    return { job: requireJob(state.jobs, jobId), approval: resolvedApproval, lease };
}
export async function denyJobApproval(cwd, jobId, approvalId) {
    const now = new Date();
    let resolvedApproval;
    const state = await updateState(cwd, (current) => {
        const job = requireJob(current.jobs, jobId);
        if (isTerminalJobStatus(job.status))
            throw new Error(`Job is terminal: ${jobId}`);
        const approval = requireApproval(job, approvalId);
        assertApprovalPending(job, approval, now);
        approval.status = "denied";
        approval.resolvedAt = now.toISOString();
        delete job.pendingApprovalId;
        job.status = "running";
        job.updatedAt = now.toISOString();
        resolvedApproval = structuredClone(approval);
    });
    await writeJson(path.join(await jobDirectory(cwd, jobId), "approvals", `${approvalId}.json`), resolvedApproval);
    return { job: requireJob(state.jobs, jobId), approval: resolvedApproval };
}
export async function waitForApprovalResolution(cwd, jobId, workerToken, approvalId, signal) {
    while (true) {
        if (signal?.aborted)
            throw new Error("Approval wait was cancelled");
        const state = await loadState(cwd);
        const job = requireJob(state.jobs, jobId);
        requireWorkerToken(job, workerToken);
        const approval = requireApproval(job, approvalId);
        if (approval.status === "approved" || approval.status === "denied" || approval.status === "expired") {
            return approval.status;
        }
        if (Date.now() >= Date.parse(approval.expiresAt)) {
            await expireApproval(cwd, jobId, approvalId);
            return "expired";
        }
        await new Promise((resolve, reject) => {
            const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
            const timeout = setTimeout(finish, 250);
            const abort = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); reject(new Error("Approval wait was cancelled")); };
            signal?.addEventListener("abort", abort, { once: true });
        });
    }
}
export function createJobLeaseProvider(cwd, jobId) {
    return {
        async find(actionFingerprint, snapshot) {
            const job = (await loadState(cwd)).jobs.find((item) => item.id === jobId);
            const now = Date.now();
            return structuredClone(job?.leases?.find((lease) => lease.actionFingerprint === actionFingerprint && lease.policyHash === snapshot.hash &&
                Date.parse(lease.expiresAt) > now && (lease.scope === "job" || !lease.consumedAt)) ?? null);
        },
        async consume(target) {
            let consumed = false;
            await updateState(cwd, (state) => {
                const job = requireJob(state.jobs, jobId);
                const lease = job.leases?.find((item) => item.id === target.id);
                if (!lease || lease.generation !== (job.generation ?? 1) || Date.parse(lease.expiresAt) <= Date.now())
                    return;
                if (lease.scope === "once" && lease.consumedAt)
                    return;
                if (lease.scope === "once")
                    lease.consumedAt = new Date().toISOString();
                const approval = job.approvals?.find((item) => item.actionFingerprint === lease.actionFingerprint && item.status === "approved");
                if (approval && lease.scope === "once")
                    approval.status = "consumed";
                consumed = true;
            });
            return consumed;
        },
    };
}
export async function appendPolicyEvent(cwd, jobId, event) {
    const file = path.join(await jobDirectory(cwd, jobId), "policy-events.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}
export async function cancelJob(cwd, jobId) {
    await reconcileJobs(cwd);
    let target;
    const requestedAt = new Date().toISOString();
    await updateState(cwd, (state) => {
        const job = requireJob(state.jobs, jobId);
        target = structuredClone(job);
        if (isTerminalJobStatus(job.status))
            return;
        job.cancelRequestedAt = requestedAt;
        job.updatedAt = requestedAt;
    });
    if (!target || isTerminalJobStatus(target.status))
        return (await getJob(cwd, jobId)).job;
    if (target.pid && processAlive(target.pid)) {
        try {
            try {
                if (process.platform !== "win32")
                    process.kill(-target.pid, "SIGTERM");
                else
                    process.kill(target.pid, "SIGTERM");
            }
            catch {
                process.kill(target.pid, "SIGTERM");
            }
            return (await loadState(cwd)).jobs.find((job) => job.id === jobId);
        }
        catch {
            // The worker may have exited between the liveness check and signal delivery.
        }
    }
    await finishJob(cwd, jobId, terminalResult(target, "cancelled", "Job was cancelled before its worker could stop cleanly."));
    return (await getJob(cwd, jobId)).job;
}
export async function reconcileJobs(cwd) {
    const state = await loadState(cwd);
    for (const job of state.jobs) {
        if (isTerminalJobStatus(job.status))
            continue;
        const result = await readJobResult(cwd, job.id);
        if (result) {
            await finishJob(cwd, job.id, result);
            continue;
        }
        const heartbeat = await readJson(path.join(await jobDirectory(cwd, job.id), "heartbeat.json"));
        const leaseTime = Date.parse(heartbeat?.updatedAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
        const stale = !Number.isFinite(leaseTime) || Date.now() - leaseTime > JOB_STALE_AFTER_MS;
        if (!stale)
            continue;
        const pid = heartbeat?.pid ?? job.pid;
        if (pid && processAlive(pid))
            continue;
        if (job.cancelRequestedAt) {
            await finishJob(cwd, job.id, terminalResult(job, "cancelled", "Job worker stopped after cancellation was requested."));
        }
        else {
            await finishJob(cwd, job.id, terminalResult(job, "orphaned", "Job worker disappeared before writing a terminal result."));
        }
    }
}
export async function jobDirectory(cwd, jobId) {
    return path.join(await resolveStateDir(cwd), "jobs", jobId);
}
export function isTerminalJobStatus(status) {
    return ["succeeded", "failed", "cancelled", "timed-out", "orphaned", "not-implemented"].includes(status);
}
function terminalResult(job, status, output) {
    return {
        kind: job.kind ?? "ask",
        status,
        success: status === "succeeded",
        model: typeof job.model === "string" ? job.model : null,
        output,
        changedFiles: [],
        diffStat: "",
        verification: { status: "not-run", commands: [] },
        ...(job.host ? { host: job.host } : {}),
        jobId: job.id,
        error: status === "succeeded" ? null : output,
    };
}
function terminalNotifications(existing, createdAt) {
    if (existing?.some((notification) => notification.kind === "terminal"))
        return existing;
    return [
        ...(existing ?? []),
        { id: randomUUID(), kind: "terminal", status: "pending", createdAt },
    ];
}
function requireApproval(job, approvalId) {
    const approval = job.approvals?.find((item) => item.id === approvalId);
    if (!approval)
        throw new Error(`Unknown approval: ${approvalId}`);
    return approval;
}
function assertApprovalPending(job, approval, now) {
    if (approval.status !== "pending")
        throw new Error(`Approval is already ${approval.status}: ${approval.id}`);
    if (approval.generation !== (job.generation ?? 1))
        throw new Error(`Approval generation is stale: ${approval.id}`);
    if (Date.parse(approval.expiresAt) <= now.getTime())
        throw new Error(`Approval expired: ${approval.id}`);
    if (job.pendingApprovalId !== approval.id)
        throw new Error(`Approval is not active: ${approval.id}`);
}
async function expireApproval(cwd, jobId, approvalId) {
    await updateState(cwd, (state) => {
        const job = requireJob(state.jobs, jobId);
        const approval = requireApproval(job, approvalId);
        if (approval.status !== "pending")
            return;
        approval.status = "expired";
        approval.resolvedAt = new Date().toISOString();
        delete job.pendingApprovalId;
        job.status = "running";
        job.updatedAt = approval.resolvedAt;
    });
}
function requireJob(jobs, jobId) {
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job)
        throw new Error(`Unknown job: ${jobId}`);
    return job;
}
function requireWorkerToken(job, workerToken) {
    if (job.workerToken !== workerToken)
        throw new Error(`Worker token mismatch for job: ${job.id}`);
}
function timestamp(job) {
    return Date.parse(job.createdAt ?? job.startedAt ?? job.finishedAt ?? "") || 0;
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
async function readRequiredJson(file) {
    const value = await readJson(file);
    if (value === null)
        throw new Error(`Missing job artifact: ${file}`);
    return value;
}
async function writeJson(file, value) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
async function claimTerminal(directory) {
    const claimFile = path.join(directory, "terminal.lock");
    await fs.mkdir(directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await fs.open(claimFile, "wx", 0o600);
            await handle.writeFile(`${process.pid}\n`);
            await handle.close();
            return true;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const stat = await fs.stat(claimFile).catch(() => undefined);
            if (attempt === 0 && stat && Date.now() - stat.mtimeMs > JOB_STALE_AFTER_MS) {
                await fs.rm(claimFile, { force: true });
                continue;
            }
            return false;
        }
    }
    return false;
}
