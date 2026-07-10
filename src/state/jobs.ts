import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ExecutionMode,
  Host,
  JobStatus,
  TaskKind,
  WorkerResult,
} from "../core/contracts.js";
import { loadState, resolveStateDir, updateState, type JobRecord } from "./state.js";

export const JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export const JOB_STALE_AFTER_MS = 60_000;

export interface JobStart {
  host: Host;
  kind: TaskKind;
  prompt: string;
  cwd: string;
  executionMode: ExecutionMode;
  timeoutMs: number;
  model?: string;
}

export interface JobRequest {
  id: string;
  host: Host;
  kind: TaskKind;
  cwd: string;
  executionMode: ExecutionMode;
  timeoutMs: number;
  model?: string;
  workerToken: string;
  createdAt: string;
}

export interface JobHandle {
  id: string;
  workerToken: string;
}

export interface JobSnapshot {
  job: JobRecord;
  result: WorkerResult | null;
}

export interface JobWaitExpired {
  event: "wait-timed-out";
  jobId: string;
  status: string;
}

export async function startJob(cwd: string, input: JobStart): Promise<JobHandle> {
  await reconcileJobs(cwd);
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const workerToken = randomUUID();
  const createdAt = new Date().toISOString();
  const directory = await jobDirectory(cwd, id);
  const request: JobRequest = {
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

export async function attachJobProcess(
  cwd: string,
  jobId: string,
  workerToken: string,
  pid: number,
): Promise<JobRecord> {
  const updatedAt = new Date().toISOString();
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    requireWorkerToken(job, workerToken);
    if (isTerminalJobStatus(job.status)) return;
    job.pid = pid;
    job.updatedAt = updatedAt;
  });
  return requireJob(state.jobs, jobId);
}

export async function markJobRunning(
  cwd: string,
  jobId: string,
  workerToken: string,
  pid: number,
): Promise<JobRecord> {
  const startedAt = new Date().toISOString();
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    requireWorkerToken(job, workerToken);
    if (isTerminalJobStatus(job.status)) return;
    job.status = "running";
    job.pid = pid;
    job.startedAt = job.startedAt ?? startedAt;
    job.updatedAt = startedAt;
  });
  await heartbeatJob(cwd, jobId, workerToken, pid);
  return requireJob(state.jobs, jobId);
}

export async function heartbeatJob(
  cwd: string,
  jobId: string,
  workerToken: string,
  pid: number,
): Promise<void> {
  await writeJson(path.join(await jobDirectory(cwd, jobId), "heartbeat.json"), {
    jobId,
    workerToken,
    pid,
    updatedAt: new Date().toISOString(),
  });
}

export async function finishJob(
  cwd: string,
  jobId: string,
  result: WorkerResult,
  diff?: string,
): Promise<void> {
  const directory = await jobDirectory(cwd, jobId);
  const claimed = await claimTerminal(directory);
  if (!claimed) {
    const existingResult = await readJobResult(cwd, jobId);
    if (existingResult) await applyResultToState(cwd, jobId, existingResult);
    return;
  }
  const finishedAt = new Date().toISOString();
  const finalResult = { ...result, jobId: result.jobId ?? jobId };
  await fs.mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, "result.json"), finalResult);
  if (diff) await fs.writeFile(path.join(directory, "changes.patch"), diff, { encoding: "utf8", mode: 0o600 });
  await applyResultToState(cwd, jobId, finalResult, finishedAt);
}

async function applyResultToState(
  cwd: string,
  jobId: string,
  finalResult: WorkerResult,
  finishedAt = new Date().toISOString(),
): Promise<void> {
  await updateState(cwd, (state) => {
    const existing = state.jobs.find((job) => job.id === jobId);
    const summary: JobRecord = {
      ...(existing ?? { id: jobId }),
      id: jobId,
      ...(finalResult.host ?? existing?.host ? { host: (finalResult.host ?? existing?.host)! } : {}),
      kind: finalResult.kind,
      status: finalResult.status,
      ...(finalResult.model ? { model: finalResult.model } : {}),
      finishedAt,
      updatedAt: finishedAt,
      notification: "pending",
    };
    if (existing) Object.assign(existing, summary);
    else state.jobs.push(summary);
  });
}

export async function readJobRequest(cwd: string, jobId: string): Promise<JobRequest> {
  return readRequiredJson<JobRequest>(path.join(await jobDirectory(cwd, jobId), "request.json"));
}

export async function readJobPrompt(cwd: string, jobId: string): Promise<string> {
  return fs.readFile(path.join(await jobDirectory(cwd, jobId), "prompt.md"), "utf8");
}

export async function readJobResult(cwd: string, jobId: string): Promise<WorkerResult | null> {
  return readJson<WorkerResult>(path.join(await jobDirectory(cwd, jobId), "result.json"));
}

export async function getJob(cwd: string, jobId: string): Promise<JobSnapshot> {
  await reconcileJobs(cwd);
  const state = await loadState(cwd);
  return {
    job: requireJob(state.jobs, jobId),
    result: await readJobResult(cwd, jobId),
  };
}

export async function listJobs(cwd: string, pendingNotifications = false): Promise<JobRecord[]> {
  await reconcileJobs(cwd);
  const state = await loadState(cwd);
  return state.jobs
    .filter((job) => !pendingNotifications || job.notification === "pending")
    .sort((left, right) => timestamp(right) - timestamp(left));
}

export async function waitForJob(
  cwd: string,
  jobId: string,
  waitTimeoutMs?: number,
): Promise<WorkerResult | JobWaitExpired> {
  const deadline = waitTimeoutMs === undefined ? undefined : Date.now() + waitTimeoutMs;
  while (true) {
    const snapshot = await getJob(cwd, jobId);
    if (isTerminalJobStatus(snapshot.job.status)) {
      if (snapshot.result) return snapshot.result;
      return terminalResult(snapshot.job, snapshot.job.status as Exclude<JobStatus, "queued" | "running">,
        `Job ${jobId} reached ${snapshot.job.status} without a result artifact.`);
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      return { event: "wait-timed-out", jobId, status: snapshot.job.status };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function acknowledgeJob(cwd: string, jobId: string): Promise<JobRecord> {
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    if (!isTerminalJobStatus(job.status)) throw new Error(`Job is not terminal: ${jobId}`);
    job.notification = "acknowledged";
    job.updatedAt = new Date().toISOString();
  });
  return requireJob(state.jobs, jobId);
}

export async function cancelJob(cwd: string, jobId: string): Promise<JobRecord> {
  await reconcileJobs(cwd);
  let target: JobRecord | undefined;
  const requestedAt = new Date().toISOString();
  await updateState(cwd, (state) => {
    const job = requireJob(state.jobs, jobId);
    target = structuredClone(job);
    if (isTerminalJobStatus(job.status)) return;
    job.cancelRequestedAt = requestedAt;
    job.updatedAt = requestedAt;
  });
  if (!target || isTerminalJobStatus(target.status)) return (await getJob(cwd, jobId)).job;
  if (target.pid && processAlive(target.pid)) {
    try {
      process.kill(target.pid, "SIGTERM");
      return (await loadState(cwd)).jobs.find((job) => job.id === jobId)!;
    } catch {
      // The worker may have exited between the liveness check and signal delivery.
    }
  }
  await finishJob(cwd, jobId, terminalResult(target, "cancelled", "Job was cancelled before its worker could stop cleanly."));
  return (await getJob(cwd, jobId)).job;
}

export async function reconcileJobs(cwd: string): Promise<void> {
  const state = await loadState(cwd);
  for (const job of state.jobs) {
    if (isTerminalJobStatus(job.status)) continue;
    const result = await readJobResult(cwd, job.id);
    if (result) {
      await finishJob(cwd, job.id, result);
      continue;
    }
    const heartbeat = await readJson<{ updatedAt?: string; pid?: number; workerToken?: string }>(
      path.join(await jobDirectory(cwd, job.id), "heartbeat.json"),
    );
    const leaseTime = Date.parse(heartbeat?.updatedAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt ?? "");
    const stale = !Number.isFinite(leaseTime) || Date.now() - leaseTime > JOB_STALE_AFTER_MS;
    if (!stale) continue;
    const pid = heartbeat?.pid ?? job.pid;
    if (pid && processAlive(pid)) continue;
    if (job.cancelRequestedAt) {
      await finishJob(cwd, job.id, terminalResult(job, "cancelled", "Job worker stopped after cancellation was requested."));
    } else {
      await finishJob(cwd, job.id, terminalResult(job, "orphaned", "Job worker disappeared before writing a terminal result."));
    }
  }
}

export async function jobDirectory(cwd: string, jobId: string): Promise<string> {
  return path.join(await resolveStateDir(cwd), "jobs", jobId);
}

export function isTerminalJobStatus(status: string): boolean {
  return status !== "queued" && status !== "running";
}

function terminalResult(
  job: JobRecord,
  status: Exclude<JobStatus, "queued" | "running">,
  output: string,
): WorkerResult {
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

function requireJob(jobs: JobRecord[], jobId: string): JobRecord {
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  return job;
}

function requireWorkerToken(job: JobRecord, workerToken: string): void {
  if (job.workerToken !== workerToken) throw new Error(`Worker token mismatch for job: ${job.id}`);
}

function timestamp(job: JobRecord): number {
  return Date.parse(job.createdAt ?? job.startedAt ?? job.finishedAt ?? "") || 0;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readRequiredJson<T>(file: string): Promise<T> {
  const value = await readJson<T>(file);
  if (value === null) throw new Error(`Missing job artifact: ${file}`);
  return value;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function claimTerminal(directory: string): Promise<boolean> {
  const claimFile = path.join(directory, "terminal.lock");
  await fs.mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(claimFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
