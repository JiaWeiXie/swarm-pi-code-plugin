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
    const directory = await jobDirectory(cwd, id);
    const request = {
        id,
        host: input.host,
        kind: input.kind,
        cwd: input.cwd,
        executionMode: input.executionMode,
        timeoutMs: input.timeoutMs,
        ...(input.model ? { model: input.model } : {}),
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
            timeoutMs: input.timeoutMs,
            ...(input.model ? { model: input.model } : {}),
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
        .filter((job) => !pendingNotifications || job.notification === "pending")
        .sort((left, right) => timestamp(right) - timestamp(left));
}
export async function waitForJob(cwd, jobId, waitTimeoutMs) {
    const deadline = waitTimeoutMs === undefined ? undefined : Date.now() + waitTimeoutMs;
    while (true) {
        const snapshot = await getJob(cwd, jobId);
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
export async function acknowledgeJob(cwd, jobId) {
    const state = await updateState(cwd, (current) => {
        const job = requireJob(current.jobs, jobId);
        if (!isTerminalJobStatus(job.status))
            throw new Error(`Job is not terminal: ${jobId}`);
        job.notification = "acknowledged";
        job.updatedAt = new Date().toISOString();
    });
    return requireJob(state.jobs, jobId);
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
            process.kill(target.pid, "SIGTERM");
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
    return status !== "queued" && status !== "running";
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
