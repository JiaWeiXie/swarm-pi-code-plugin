import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ActionEffectAssessment,
  ApprovalMode,
  ApprovalRequest,
  CapabilityLease,
  DelegationSpec,
  ExecutionMode,
  Host,
  JobNotification,
  JobPhase,
  JobStatus,
  PolicyDecision,
  PolicySnapshot,
  RoleId,
  SandboxMode,
  TaskKind,
  ThinkingLevel,
  WorkerRoleId,
  WorkerResult,
  WorkspaceStrategy,
  ScaffoldSpec,
  DecisionMode,
  HostAssistanceMode,
  HostAssistanceCorrelation,
  HostAssistancePolicy,
  HostAssistanceRecord,
  HostAssistanceRequest,
  HostAssistanceRequestSummary,
  HostAssistanceResult,
  WorkerAssessment,
  HostAdjudicationReceipt,
} from "../core/contracts.js";
import { hostContextCharacterLimit } from "../host-assistance/context-allowance.js";
import {
  loadState,
  resolveStateDir,
  resolveStateFile,
  updateState,
  type JobRecord,
} from "./state.js";
import { canonicalStateFile, stateObservers, type StateObserverSource } from "./state-observer.js";
import type { ModelConfiguration } from "./model-config.js";

export const JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export const JOB_STALE_AFTER_MS = 60_000;

export interface JobStart {
  host: Host;
  kind: TaskKind;
  prompt: string;
  cwd: string;
  executionMode: ExecutionMode;
  sandboxMode?: SandboxMode;
  timeoutMs: number;
  model?: string;
  role?: WorkerRoleId;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  delegationSpec?: DelegationSpec;
  policySnapshot?: PolicySnapshot;
  workspaceStrategy?: WorkspaceStrategy;
  target?: string;
  projectGoal?: string;
  scaffoldSpec?: ScaffoldSpec;
  adoptExisting?: boolean;
  decisionMode?: DecisionMode;
  hostAssistance?: HostAssistanceMode;
  hostContextFile?: string;
  discoveryFrom?: string;
  modelConfiguration?: ModelConfiguration;
}

export interface JobRequest {
  requestVersion?: 1 | 2 | 3 | 4 | 5;
  id: string;
  host: Host;
  kind: TaskKind;
  cwd: string;
  executionMode: ExecutionMode;
  sandboxMode?: SandboxMode;
  timeoutMs: number;
  model?: string;
  role?: WorkerRoleId;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  delegationSpec?: DelegationSpec;
  policySnapshot?: PolicySnapshot;
  workspaceStrategy?: WorkspaceStrategy;
  target?: string;
  projectGoal?: string;
  scaffoldSpec?: ScaffoldSpec;
  adoptExisting?: boolean;
  decisionMode?: DecisionMode;
  hostAssistance?: HostAssistanceMode;
  hostContextFile?: string;
  discoveryFrom?: string;
  modelConfiguration?: ModelConfiguration;
  providerSnapshotHash?: string;
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
  phase?: JobPhase;
  progressMessage?: string;
  lastProgressAt?: string;
  updatedAt?: string;
}

export interface JobApprovalRequired {
  event: "approval-required";
  jobId: string;
  status: "awaiting-approval";
  approval: ApprovalRequest;
}

export interface JobHostAssistanceRequired {
  event: "host-assistance-required" | "human-decision-required";
  jobId: string;
  status: "awaiting-host" | "awaiting-decision";
  request: HostAssistanceRequestSummary;
}

export interface JobWaitDependencies {
  now?: () => number;
  observerSource?: StateObserverSource;
  readJob?: (cwd: string, jobId: string) => Promise<JobSnapshot>;
  resolveStateFile?: (cwd: string) => Promise<string>;
}

export async function startJob(cwd: string, input: JobStart): Promise<JobHandle> {
  await reconcileJobs(cwd);
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const workerToken = randomUUID();
  const createdAt = new Date().toISOString();
  const sandboxMode = input.sandboxMode ?? "strict";
  const directory = await jobDirectory(cwd, id);
  const providerSnapshotHash = input.modelConfiguration
    ? modelConfigurationSnapshotHash(input.modelConfiguration)
    : undefined;
  if (
    (input.policySnapshot?.version === 2 || input.policySnapshot?.version === 3) &&
    !input.modelConfiguration
  ) {
    throw new Error(
      `Policy snapshot version ${input.policySnapshot.version} requires modelConfiguration`,
    );
  }
  const request: JobRequest = {
    requestVersion:
      input.policySnapshot?.version === 3
        ? 5
        : input.policySnapshot?.version === 2
          ? 4
          : input.modelConfiguration
            ? 3
            : 2,
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
    ...(input.projectGoal !== undefined ? { projectGoal: input.projectGoal } : {}),
    ...(input.scaffoldSpec ? { scaffoldSpec: input.scaffoldSpec } : {}),
    ...(input.adoptExisting ? { adoptExisting: true } : {}),
    ...(input.decisionMode ? { decisionMode: input.decisionMode } : {}),
    ...(input.hostAssistance ? { hostAssistance: input.hostAssistance } : {}),
    ...(input.hostContextFile
      ? {
          hostContextFile: path.relative(input.cwd, path.resolve(input.cwd, input.hostContextFile)),
        }
      : {}),
    ...(input.discoveryFrom ? { discoveryFrom: input.discoveryFrom } : {}),
    ...(input.modelConfiguration
      ? { modelConfiguration: structuredClone(input.modelConfiguration) }
      : {}),
    ...(providerSnapshotHash ? { providerSnapshotHash } : {}),
    workerToken,
    createdAt,
  };
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    writeJson(path.join(directory, "request.json"), request),
    fs.writeFile(path.join(directory, "prompt.md"), input.prompt, {
      encoding: "utf8",
      mode: 0o600,
    }),
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
      ...(input.policySnapshot ? { policyHash: input.policySnapshot.hash } : {}),
      ...(input.policySnapshot?.version === 3 && input.policySnapshot.parentPolicyHash
        ? { parentPolicyHash: input.policySnapshot.parentPolicyHash }
        : {}),
      ...(input.policySnapshot?.version === 2 || input.policySnapshot?.version === 3
        ? { scopeHash: input.policySnapshot.scopeHash }
        : {}),
      ...(providerSnapshotHash ? { providerSnapshotHash } : {}),
      generation: 1,
      approvals: [],
      leases: [],
      notifications: [],
      workerToken,
      status: "queued",
      phase: "queued",
      progressMessage: "Request persisted; waiting for a worker.",
      lastProgressAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });
  });
  return { id, workerToken };
}

export function modelConfigurationSnapshotHash(configuration: ModelConfiguration): string {
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    job.status = activeWaitStatus(job);
    job.phase = "preflight";
    job.progressMessage = "Validating the assigned workspace and policy snapshot.";
    job.lastProgressAt = startedAt;
    job.pid = pid;
    job.startedAt = job.startedAt ?? startedAt;
    job.updatedAt = startedAt;
  });
  await heartbeatJob(cwd, jobId, workerToken, pid);
  return requireJob(state.jobs, jobId);
}

export async function updateJobProgress(
  cwd: string,
  jobId: string,
  workerToken: string,
  phase: JobPhase,
  message: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await updateState(cwd, (state) => {
    const job = requireJob(state.jobs, jobId);
    requireWorkerToken(job, workerToken);
    if (isTerminalJobStatus(job.status)) return;
    job.phase = phase;
    job.progressMessage = message.slice(0, 500);
    job.lastProgressAt = updatedAt;
    job.updatedAt = updatedAt;
  });
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
  const currentJob = (await loadState(cwd)).jobs.find((job) => job.id === jobId);
  const hostAdjudications = currentJob ? summarizeHostAdjudications(currentJob) : [];
  const finalResult = {
    ...result,
    jobId: result.jobId ?? jobId,
    ...(hostAdjudications.length > 0 ? { hostAdjudications } : {}),
  };
  await fs.mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, "result.json"), finalResult);
  if (diff)
    await fs.writeFile(path.join(directory, "changes.patch"), diff, {
      encoding: "utf8",
      mode: 0o600,
    });
  await applyResultToState(cwd, jobId, finalResult, finishedAt);
}

function summarizeHostAdjudications(
  job: JobRecord,
): NonNullable<WorkerResult["hostAdjudications"]> {
  return [
    ...(job.approvals ?? []).flatMap((approval) =>
      approval.adjudication
        ? [
            {
              source: "approval" as const,
              requestId: approval.id,
              ...structuredClone(approval.adjudication),
              outcome: approval.status,
            },
          ]
        : [],
    ),
    ...(job.hostAssistanceRequests ?? []).flatMap((request) =>
      request.adjudication
        ? [
            {
              source: "host-assistance" as const,
              requestId: request.id,
              ...structuredClone(request.adjudication),
              outcome: request.status,
            },
          ]
        : [],
    ),
  ];
}

async function applyResultToState(
  cwd: string,
  jobId: string,
  finalResult: WorkerResult,
  finishedAt = new Date().toISOString(),
): Promise<void> {
  await updateState(cwd, (state) => {
    const existing = state.jobs.find((job) => job.id === jobId);
    if (existing?.pendingApprovalId) {
      const pending = existing.approvals?.find(
        (approval) => approval.id === existing.pendingApprovalId,
      );
      if (pending?.status === "pending") {
        pending.status = "expired";
        pending.resolvedAt = finishedAt;
      }
      delete existing.pendingApprovalId;
    }
    if (existing?.pendingHostRequestIds?.length) {
      for (const request of existing.hostAssistanceRequests ?? []) {
        if (existing.pendingHostRequestIds.includes(request.id) && request.status === "pending") {
          request.status = "expired";
          request.resolvedAt = finishedAt;
          acknowledgeHostRequestNotification(existing, request, finishedAt);
        }
      }
      existing.pendingHostRequestIds = [];
    }
    const summary: JobRecord = {
      ...(existing ?? { id: jobId }),
      id: jobId,
      ...((finalResult.host ?? existing?.host)
        ? { host: (finalResult.host ?? existing?.host)! }
        : {}),
      kind: finalResult.kind,
      status: finalResult.status,
      ...(finalResult.model ? { model: finalResult.model } : {}),
      finishedAt,
      updatedAt: finishedAt,
      notification: "pending",
      notifications: terminalNotifications(existing?.notifications, finishedAt),
    };
    if (existing) Object.assign(existing, summary);
    else state.jobs.push(summary);
  });
}

export async function readJobRequest(cwd: string, jobId: string): Promise<JobRequest> {
  await assertJobArtifactsAvailable(cwd, jobId);
  return readRequiredJson<JobRequest>(path.join(await jobDirectory(cwd, jobId), "request.json"));
}

export async function updateJobExecutionWorkspace(
  cwd: string,
  jobId: string,
  workerToken: string,
  workspace: { worktree: string; branch: string; base: string } & object,
): Promise<void> {
  const request = await readJobRequest(cwd, jobId);
  if (request.workerToken !== workerToken)
    throw new Error(`Worker token mismatch for job: ${jobId}`);
  await updateState(cwd, (state) => {
    const job = requireJob(state.jobs, jobId);
    requireWorkerToken(job, workerToken);
    if (isTerminalJobStatus(job.status)) throw new Error(`Job is terminal: ${jobId}`);
    job.executionWorkspace = structuredClone(workspace);
    job.updatedAt = new Date().toISOString();
  });
  request.cwd = workspace.worktree;
  await writeJson(path.join(await jobDirectory(cwd, jobId), "request.json"), request);
}

export async function readJobPrompt(cwd: string, jobId: string): Promise<string> {
  await assertJobArtifactsAvailable(cwd, jobId);
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
    .filter(
      (job) =>
        !pendingNotifications ||
        job.notification === "pending" ||
        job.notifications?.some((notification) => notification.status === "pending"),
    )
    .sort((left, right) => timestamp(right) - timestamp(left));
}

export async function waitForJob(
  cwd: string,
  jobId: string,
  waitTimeoutMs?: number,
  dependencies: JobWaitDependencies = {},
): Promise<WorkerResult | JobWaitExpired | JobApprovalRequired | JobHostAssistanceRequired> {
  const now = dependencies.now ?? Date.now;
  const readJob = dependencies.readJob ?? getJob;
  const resolveFile = dependencies.resolveStateFile ?? resolveStateFile;
  const observerSource = dependencies.observerSource ?? stateObservers;
  const deadline = waitTimeoutMs === undefined ? undefined : now() + waitTimeoutMs;
  const stateFile = await canonicalStateFile(await resolveFile(cwd));
  const observer = observerSource.acquire(stateFile);
  try {
    while (true) {
      const generation = observer.generation();
      const snapshot = await readJob(cwd, jobId);
      if (snapshot.job.status === "awaiting-approval") {
        const approval = snapshot.job.approvals?.find(
          (item) => item.id === snapshot.job.pendingApprovalId,
        );
        if (approval)
          return { event: "approval-required", jobId, status: "awaiting-approval", approval };
      }
      if (snapshot.job.status === "awaiting-host" || snapshot.job.status === "awaiting-decision") {
        const request = snapshot.job.hostAssistanceRequests?.find(
          (item) =>
            snapshot.job.pendingHostRequestIds?.includes(item.id) && item.status === "pending",
        );
        if (request) {
          return {
            event:
              request.kind === "decision" ? "human-decision-required" : "host-assistance-required",
            jobId,
            status: request.kind === "decision" ? "awaiting-decision" : "awaiting-host",
            request: structuredClone(request),
          };
        }
      }
      if (isTerminalJobStatus(snapshot.job.status)) {
        if (snapshot.result) return snapshot.result;
        return terminalResult(
          snapshot.job,
          snapshot.job.status as Exclude<
            JobStatus,
            "queued" | "running" | "awaiting-approval" | "awaiting-host" | "awaiting-decision"
          >,
          `Job ${jobId} reached ${snapshot.job.status} without a result artifact.`,
        );
      }
      const checkedAt = now();
      if (deadline !== undefined && checkedAt >= deadline) {
        return {
          event: "wait-timed-out",
          jobId,
          status: snapshot.job.status,
          ...(snapshot.job.phase ? { phase: snapshot.job.phase } : {}),
          ...(snapshot.job.progressMessage
            ? { progressMessage: snapshot.job.progressMessage }
            : {}),
          ...(snapshot.job.lastProgressAt ? { lastProgressAt: snapshot.job.lastProgressAt } : {}),
          ...(snapshot.job.updatedAt ? { updatedAt: snapshot.job.updatedAt } : {}),
        };
      }
      const remaining = deadline === undefined ? 500 : deadline - checkedAt;
      await observer.waitForChange(generation, Math.min(500, remaining));
    }
  } finally {
    observer.release();
  }
}

export async function acknowledgeJob(
  cwd: string,
  jobId: string,
  notificationId?: string,
): Promise<JobRecord> {
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    if (notificationId) {
      const notification = job.notifications?.find((item) => item.id === notificationId);
      if (!notification) throw new Error(`Unknown notification: ${notificationId}`);
      notification.status = "acknowledged";
      notification.acknowledgedAt = new Date().toISOString();
      if (notification.kind === "terminal") job.notification = "acknowledged";
      if (notification.approvalId) {
        const approval = job.approvals?.find((item) => item.id === notification.approvalId);
        if (approval) approval.notification = "acknowledged";
      }
    } else {
      if (!isTerminalJobStatus(job.status)) throw new Error(`Job is not terminal: ${jobId}`);
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

export async function requestJobApproval(
  cwd: string,
  jobId: string,
  workerToken: string,
  input: {
    actionFingerprint: string;
    toolName: string;
    actionSummary: string;
    trustedReadOnly?: boolean;
    effectAssessment?: ActionEffectAssessment;
    decision: PolicyDecision;
    workerAssessment?: WorkerAssessment;
    expiresAt: string;
  },
): Promise<ApprovalRequest> {
  const requestedAt = new Date().toISOString();
  const approval: ApprovalRequest = {
    id: randomUUID(),
    jobId,
    generation: 1,
    actionFingerprint: input.actionFingerprint,
    toolName: input.toolName,
    actionSummary: input.actionSummary.slice(0, 2_000),
    ...(input.trustedReadOnly ? { trustedReadOnly: true } : {}),
    ...(input.effectAssessment
      ? { effectAssessment: structuredClone(input.effectAssessment) }
      : {}),
    decision: structuredClone(input.decision),
    status: "pending",
    requestedAt,
    expiresAt: input.expiresAt,
    notificationId: randomUUID(),
    notification: "pending",
    ...(input.workerAssessment
      ? { workerAssessment: structuredClone(input.workerAssessment) }
      : {}),
  };
  await updateState(cwd, (state) => {
    const job = requireJob(state.jobs, jobId);
    requireWorkerToken(job, workerToken);
    if (isTerminalJobStatus(job.status)) throw new Error(`Job is terminal: ${jobId}`);
    if (job.pendingApprovalId) {
      const existing = job.approvals?.find(
        (item) => item.id === job.pendingApprovalId && item.status === "pending",
      );
      if (existing) throw new Error(`Job already has a pending approval: ${existing.id}`);
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
  await writeJson(
    path.join(await jobDirectory(cwd, jobId), "approvals", `${approval.id}.json`),
    approval,
  );
  return approval;
}

export async function listJobApprovals(cwd: string, jobId: string): Promise<ApprovalRequest[]> {
  await reconcileJobs(cwd);
  return structuredClone((await getJob(cwd, jobId)).job.approvals ?? []);
}

export async function approveJob(
  cwd: string,
  jobId: string,
  approvalId: string,
  scope: "once" | "job" = "once",
  adjudicationInput?: unknown,
): Promise<{ job: JobRecord; approval: ApprovalRequest; lease: CapabilityLease }> {
  const now = new Date();
  const request = adjudicationInput === undefined ? undefined : await readJobRequest(cwd, jobId);
  const adjudication =
    adjudicationInput === undefined
      ? undefined
      : normalizeHostAdjudicationReceipt(adjudicationInput);
  let resolvedApproval!: ApprovalRequest;
  let lease!: CapabilityLease;
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    if (isTerminalJobStatus(job.status)) throw new Error(`Job is terminal: ${jobId}`);
    const approval = requireApproval(job, approvalId);
    assertApprovalPending(job, approval, now);
    if (adjudication && request) {
      assertHostCanAutoApproveCapability(job, request, approval, scope, adjudication);
      approval.adjudication = structuredClone(adjudication);
    }
    approval.status = "approved";
    approval.scope = scope;
    approval.resolvedAt = now.toISOString();
    lease = {
      id: randomUUID(),
      jobId,
      generation: approval.generation,
      policyHash: approval.decision.policyHash,
      role: (job.role ?? "scout") as RoleId,
      actionFingerprint: approval.actionFingerprint,
      scope,
      capabilities: [...approval.decision.capabilities],
      createdAt: now.toISOString(),
      expiresAt: approval.expiresAt,
      principal: adjudication ? "host-model" : "user",
      ...(adjudication ? { adjudication: structuredClone(adjudication) } : {}),
    };
    job.leases ??= [];
    job.leases.push(lease);
    acknowledgeApprovalNotification(job, approval, now.toISOString());
    delete job.pendingApprovalId;
    job.status = activeWaitStatus(job);
    job.updatedAt = now.toISOString();
    resolvedApproval = structuredClone(approval);
  });
  await writeJson(
    path.join(await jobDirectory(cwd, jobId), "approvals", `${approvalId}.json`),
    resolvedApproval,
  );
  await writeJson(path.join(await jobDirectory(cwd, jobId), "leases", `${lease.id}.json`), lease);
  return { job: requireJob(state.jobs, jobId), approval: resolvedApproval, lease };
}

export async function recordJobApprovalAdjudication(
  cwd: string,
  jobId: string,
  approvalId: string,
  adjudicationInput: unknown,
): Promise<{
  job: JobRecord;
  approval: ApprovalRequest;
  outcome: "ask-user" | "hard-deny";
}> {
  const request = await readJobRequest(cwd, jobId);
  const adjudication = normalizeHostAdjudicationReceipt(adjudicationInput);
  if (adjudication.decision === "allow") {
    throw new Error("Allow adjudication must use the capability approval path");
  }
  const now = new Date();
  let resolvedApproval!: ApprovalRequest;
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    if (isTerminalJobStatus(job.status)) throw new Error(`Job is terminal: ${jobId}`);
    const approval = requireApproval(job, approvalId);
    assertApprovalPending(job, approval, now);
    assertHostAdjudicationBinding(job, request, adjudication);
    if (
      adjudication.actionFingerprint !== approval.actionFingerprint ||
      adjudication.actionFingerprint.length !== 64
    ) {
      throw new Error("Host adjudication fingerprint does not match the pending approval");
    }
    approval.adjudication = structuredClone(adjudication);
    if (adjudication.decision === "hard-deny") {
      approval.status = "denied";
      approval.resolvedAt = now.toISOString();
      acknowledgeApprovalNotification(job, approval, approval.resolvedAt);
      delete job.pendingApprovalId;
      job.status = activeWaitStatus(job);
    }
    job.updatedAt = now.toISOString();
    resolvedApproval = structuredClone(approval);
  });
  await writeJson(
    path.join(await jobDirectory(cwd, jobId), "approvals", `${approvalId}.json`),
    resolvedApproval,
  );
  return {
    job: requireJob(state.jobs, jobId),
    approval: resolvedApproval,
    outcome: adjudication.decision,
  };
}

export async function denyJobApproval(
  cwd: string,
  jobId: string,
  approvalId: string,
): Promise<{ job: JobRecord; approval: ApprovalRequest }> {
  const now = new Date();
  let resolvedApproval!: ApprovalRequest;
  const state = await updateState(cwd, (current) => {
    const job = requireJob(current.jobs, jobId);
    if (isTerminalJobStatus(job.status)) throw new Error(`Job is terminal: ${jobId}`);
    const approval = requireApproval(job, approvalId);
    assertApprovalPending(job, approval, now);
    approval.status = "denied";
    approval.resolvedAt = now.toISOString();
    acknowledgeApprovalNotification(job, approval, approval.resolvedAt);
    delete job.pendingApprovalId;
    job.status = activeWaitStatus(job);
    job.updatedAt = now.toISOString();
    resolvedApproval = structuredClone(approval);
  });
  await writeJson(
    path.join(await jobDirectory(cwd, jobId), "approvals", `${approvalId}.json`),
    resolvedApproval,
  );
  return { job: requireJob(state.jobs, jobId), approval: resolvedApproval };
}

export async function waitForApprovalResolution(
  cwd: string,
  jobId: string,
  workerToken: string,
  approvalId: string,
  signal?: AbortSignal,
): Promise<"approved" | "denied" | "expired"> {
  while (true) {
    if (signal?.aborted) throw new Error("Approval wait was cancelled");
    const state = await loadState(cwd);
    const job = requireJob(state.jobs, jobId);
    requireWorkerToken(job, workerToken);
    const approval = requireApproval(job, approvalId);
    if (
      approval.status === "approved" ||
      approval.status === "denied" ||
      approval.status === "expired"
    ) {
      return approval.status;
    }
    if (Date.now() >= Date.parse(approval.expiresAt)) {
      await expireApproval(cwd, jobId, approvalId);
      return "expired";
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timeout = setTimeout(finish, 250);
      const abort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Approval wait was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export async function requestJobHostAssistance(
  cwd: string,
  jobId: string,
  workerToken: string,
  input: {
    correlation: HostAssistanceCorrelation;
    request: HostAssistanceRequest;
    policy: HostAssistancePolicy;
    expiresAt: string;
  },
): Promise<HostAssistanceRequestSummary> {
  if (!input.policy.enabled || input.policy.mode === "off")
    throw new Error("Host Assistance is disabled by policy");
  if (input.request.dataClassification === "secret")
    throw new Error("Secret or credential Host Assistance is hard denied");
  if (input.request.kind === "context") {
    if (!input.policy.contextClasses.includes(input.request.contextClass)) {
      throw new Error(`Host context class is not allowed: ${input.request.contextClass}`);
    }
    if (input.request.budget < 1) throw new Error("Host context request budget must be positive");
  }
  const requestedAt = new Date().toISOString();
  const id = randomUUID();
  const notificationId = randomUUID();
  const summary: HostAssistanceRequestSummary = {
    id,
    jobId,
    generation: input.correlation.generation,
    sessionId: input.correlation.sessionId,
    attempt: input.correlation.attempt,
    ...(input.correlation.perspective ? { perspective: input.correlation.perspective } : {}),
    kind: input.request.kind,
    ...(input.request.kind === "context" ? { contextClass: input.request.contextClass } : {}),
    safeSummary: safeHostRequestSummary(input.request),
    status: "pending",
    requestedAt,
    expiresAt: input.expiresAt,
    notificationId,
    actionFingerprint: hostAssistanceFingerprint(input.request),
  };
  const record: HostAssistanceRecord = { ...summary, request: structuredClone(input.request) };
  const directory = path.join(await jobDirectory(cwd, jobId), "host-assistance");
  const file = path.join(directory, `${id}.json`);
  const pendingFile = path.join(directory, `${id}.pending.json`);
  try {
    await writeJson(pendingFile, record);
    await updateState(cwd, (state) => {
      const job = requireJob(state.jobs, jobId);
      requireWorkerToken(job, workerToken);
      if (isTerminalJobStatus(job.status)) throw new Error(`Job is terminal: ${jobId}`);
      if (
        (job.generation ?? 1) !== input.correlation.generation ||
        input.correlation.jobId !== jobId
      ) {
        throw new Error(`Host Assistance correlation is stale for job: ${jobId}`);
      }
      const records = job.hostAssistanceRequests ?? [];
      if (records.length >= input.policy.maxRequests) {
        throw new Error(`Host Assistance request quota exceeded for job: ${jobId}`);
      }
      const activeRequests = records.filter((item) => item.status === "pending");
      if (activeRequests.length >= input.policy.maxFanOut) {
        throw new Error(`Host Assistance fan-out exceeded for job: ${jobId}`);
      }
      const activeForSession = records.find(
        (item) => item.sessionId === input.correlation.sessionId && item.status === "pending",
      );
      if (activeForSession)
        throw new Error(
          `Session already has an active Host Assistance request: ${activeForSession.id}`,
        );
      job.hostAssistanceRequests ??= [];
      job.pendingHostRequestIds ??= [];
      job.notifications ??= [];
      job.hostAssistanceRequests.push(summary);
      job.pendingHostRequestIds.push(id);
      job.notifications.push({
        id: notificationId,
        kind: input.request.kind === "decision" ? "human-decision" : "host-assistance",
        status: "pending",
        createdAt: requestedAt,
        hostRequestId: id,
      });
      job.status = input.request.kind === "decision" ? "awaiting-decision" : "awaiting-host";
      job.updatedAt = requestedAt;
    });
    await fs.rename(pendingFile, file).catch(() => {
      // A crash or transient rename failure is reconciled from the durable
      // .pending artifact before list/resolve/consume reads the request.
    });
  } catch (error) {
    await updateState(cwd, (state) => {
      const job = requireJob(state.jobs, jobId);
      job.hostAssistanceRequests = (job.hostAssistanceRequests ?? []).filter(
        (item) => item.id !== id,
      );
      job.pendingHostRequestIds = (job.pendingHostRequestIds ?? []).filter((item) => item !== id);
      job.notifications = (job.notifications ?? []).filter((item) => item.hostRequestId !== id);
      job.status = activeWaitStatus(job);
      job.updatedAt = new Date().toISOString();
    }).catch(() => {});
    await fs.rm(file, { force: true }).catch(() => {});
    await fs.rm(pendingFile, { force: true }).catch(() => {});
    throw error;
  }
  return structuredClone(summary);
}

export async function listJobHostRequests(
  cwd: string,
  jobId: string,
  kind?: "context" | "decision" | "action-recommendation",
): Promise<HostAssistanceRecord[]> {
  await reconcileJobs(cwd);
  const job = (await getJob(cwd, jobId)).job;
  const summaries = (job.hostAssistanceRequests ?? []).filter(
    (item) => !kind || item.kind === kind,
  );
  const directory = await jobDirectory(cwd, jobId);
  return Promise.all(
    summaries.map(async (summary) =>
      readRequiredJson<HostAssistanceRecord>(
        await ensureHostAssistanceArtifact(directory, summary.id),
      ),
    ),
  );
}

export async function resolveJobHostRequest(
  cwd: string,
  jobId: string,
  requestId: string,
  response: unknown,
  adjudicationInput?: unknown,
): Promise<HostAssistanceRecord> {
  const directory = path.join(await jobDirectory(cwd, jobId), "host-assistance");
  const file = await ensureHostAssistanceArtifact(path.dirname(directory), requestId);
  const lockFile = path.join(directory, `${requestId}.resolve.lock`);
  await fs.mkdir(directory, { recursive: true });
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Host Assistance response is already being resolved: ${requestId}`);
    throw error;
  }
  try {
    const currentJob = (await loadState(cwd)).jobs.find((item) => item.id === jobId);
    if (!currentJob) throw new Error(`Unknown job: ${jobId}`);
    assertHostRequestPending(currentJob, requireHostRequest(currentJob, requestId));
    const record = await readRequiredJson<HostAssistanceRecord>(file);
    const adjudication =
      adjudicationInput === undefined
        ? undefined
        : normalizeHostAdjudicationReceipt(adjudicationInput);
    if (adjudication) {
      const jobRequest = await readJobRequest(cwd, jobId);
      assertHostAdjudicationRequestBinding(currentJob, jobRequest, record, adjudication);
      if (adjudication.decision === "ask-user") {
        const updated = { ...record, adjudication: structuredClone(adjudication) };
        await writeJson(file, updated);
        await updateState(cwd, (state) => {
          const job = requireJob(state.jobs, jobId);
          const summary = requireHostRequest(job, requestId);
          assertHostRequestPending(job, summary);
          summary.adjudication = structuredClone(adjudication);
          job.updatedAt = adjudication.decidedAt;
        });
        return structuredClone(updated);
      }
      if (adjudication.decision === "allow") {
        assertHostCanAutoResolveRequest(currentJob, jobRequest, record, response, adjudication);
      } else {
        response = {
          kind: "unavailable",
          reason: "policy-denied",
          message: adjudication.rationale,
        };
      }
    }
    const normalized = normalizeHostAssistanceResponse(record, response);
    const resolvedAt = responseTimestamp(normalized);
    const updated: HostAssistanceRecord = {
      ...record,
      status: normalized.kind === "unavailable" ? "declined" : "resolved",
      resolvedAt,
      responseHash: normalized.hash,
      response: normalized,
      ...(adjudication ? { adjudication: structuredClone(adjudication) } : {}),
    };
    await writeJson(file, updated);
    await updateState(cwd, (state) => {
      const job = requireJob(state.jobs, jobId);
      const summary = requireHostRequest(job, requestId);
      assertHostRequestPending(job, summary);
      if (summary.generation !== record.generation || record.jobId !== jobId)
        throw new Error(`Host response correlation mismatch: ${requestId}`);
      Object.assign(summary, {
        status: updated.status,
        resolvedAt,
        responseHash: normalized.hash,
        ...(adjudication ? { adjudication: structuredClone(adjudication) } : {}),
      });
      job.pendingHostRequestIds = (job.pendingHostRequestIds ?? []).filter(
        (id) => id !== requestId,
      );
      acknowledgeHostRequestNotification(job, summary, resolvedAt);
      job.status = activeWaitStatus(job);
      job.updatedAt = resolvedAt;
    });
    return structuredClone(updated);
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}

export async function declineJobHostRequest(
  cwd: string,
  jobId: string,
  requestId: string,
  message = "The Host declined this request.",
): Promise<HostAssistanceRecord> {
  return resolveJobHostRequest(cwd, jobId, requestId, {
    kind: "unavailable",
    reason: "declined",
    message,
  });
}

export async function waitForHostAssistanceResolution(
  cwd: string,
  jobId: string,
  workerToken: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<HostAssistanceResult> {
  while (true) {
    if (signal?.aborted) throw new Error("Host Assistance wait was cancelled");
    const state = await loadState(cwd);
    const job = requireJob(state.jobs, jobId);
    requireWorkerToken(job, workerToken);
    const summary = requireHostRequest(job, requestId);
    if (summary.generation !== (job.generation ?? 1))
      throw new Error(`Host Assistance request generation is stale: ${requestId}`);
    if (summary.status === "pending" && Date.now() >= Date.parse(summary.expiresAt)) {
      await expireHostRequest(cwd, jobId, requestId);
      continue;
    }
    if (
      summary.status === "resolved" ||
      summary.status === "declined" ||
      summary.status === "expired"
    ) {
      const file = await ensureHostAssistanceArtifact(await jobDirectory(cwd, jobId), requestId);
      const record = await readRequiredJson<HostAssistanceRecord>(file);
      if (!record.response)
        throw new Error(`Host Assistance response artifact is missing: ${requestId}`);
      const consumedAt = new Date().toISOString();
      let consumed = false;
      await updateState(cwd, (current) => {
        const currentJob = requireJob(current.jobs, jobId);
        requireWorkerToken(currentJob, workerToken);
        const currentSummary = requireHostRequest(currentJob, requestId);
        if (currentSummary.status === "consumed") return;
        if (
          currentSummary.status !== "resolved" &&
          currentSummary.status !== "declined" &&
          currentSummary.status !== "expired"
        )
          return;
        currentSummary.status = "consumed";
        currentSummary.consumedAt = consumedAt;
        currentJob.updatedAt = consumedAt;
        consumed = true;
      });
      if (!consumed) throw new Error(`Host Assistance response was already consumed: ${requestId}`);
      await writeJson(file, { ...record, status: "consumed", consumedAt });
      return structuredClone(record.response);
    }
    if (summary.status === "consumed")
      throw new Error(`Host Assistance response was already consumed: ${requestId}`);
    await abortableDelay(250, signal, "Host Assistance wait was cancelled");
  }
}

export function createJobLeaseProvider(cwd: string, jobId: string) {
  return {
    async find(
      actionFingerprint: string,
      snapshot: { hash: string },
    ): Promise<CapabilityLease | null> {
      const job = (await loadState(cwd)).jobs.find((item) => item.id === jobId);
      const now = Date.now();
      return structuredClone(
        job?.leases?.find(
          (lease) =>
            lease.actionFingerprint === actionFingerprint &&
            lease.policyHash === snapshot.hash &&
            Date.parse(lease.expiresAt) > now &&
            (lease.scope === "job" || !lease.consumedAt),
        ) ?? null,
      );
    },
    async consume(target: CapabilityLease): Promise<boolean> {
      let consumed = false;
      await updateState(cwd, (state) => {
        const job = requireJob(state.jobs, jobId);
        const lease = job.leases?.find((item) => item.id === target.id);
        if (
          !lease ||
          lease.generation !== (job.generation ?? 1) ||
          Date.parse(lease.expiresAt) <= Date.now()
        )
          return;
        if (lease.scope === "once" && lease.consumedAt) return;
        if (lease.scope === "once") lease.consumedAt = new Date().toISOString();
        const approval = job.approvals?.find(
          (item) =>
            item.actionFingerprint === lease.actionFingerprint && item.status === "approved",
        );
        if (approval && lease.scope === "once") approval.status = "consumed";
        consumed = true;
      });
      return consumed;
    },
  };
}

export async function appendPolicyEvent(cwd: string, jobId: string, event: unknown): Promise<void> {
  const file = path.join(await jobDirectory(cwd, jobId), "policy-events.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
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
      try {
        if (process.platform !== "win32") process.kill(-target.pid, "SIGTERM");
        else process.kill(target.pid, "SIGTERM");
      } catch {
        process.kill(target.pid, "SIGTERM");
      }
      return (await loadState(cwd)).jobs.find((job) => job.id === jobId)!;
    } catch {
      // The worker may have exited between the liveness check and signal delivery.
    }
  }
  await finishJob(
    cwd,
    jobId,
    terminalResult(target, "cancelled", "Job was cancelled before its worker could stop cleanly."),
  );
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
    const leaseTime = Date.parse(
      heartbeat?.updatedAt ?? job.updatedAt ?? job.startedAt ?? job.createdAt ?? "",
    );
    const stale = !Number.isFinite(leaseTime) || Date.now() - leaseTime > JOB_STALE_AFTER_MS;
    if (!stale) continue;
    const pid = heartbeat?.pid ?? job.pid;
    if (pid && processAlive(pid)) continue;
    if (job.cancelRequestedAt) {
      await finishJob(
        cwd,
        job.id,
        terminalResult(job, "cancelled", "Job worker stopped after cancellation was requested."),
      );
    } else {
      await finishJob(
        cwd,
        job.id,
        terminalResult(job, "orphaned", "Job worker disappeared before writing a terminal result."),
      );
    }
  }
}

export async function jobDirectory(cwd: string, jobId: string): Promise<string> {
  return path.join(await resolveStateDir(cwd), "jobs", jobId);
}

export function isTerminalJobStatus(status: string): boolean {
  return ["succeeded", "failed", "cancelled", "timed-out", "orphaned", "not-implemented"].includes(
    status,
  );
}

function terminalResult(
  job: JobRecord,
  status: Exclude<
    JobStatus,
    "queued" | "running" | "awaiting-approval" | "awaiting-host" | "awaiting-decision"
  >,
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

function terminalNotifications(
  existing: JobNotification[] | undefined,
  createdAt: string,
): JobNotification[] {
  if (existing?.some((notification) => notification.kind === "terminal")) return existing;
  return [
    ...(existing ?? []),
    { id: randomUUID(), kind: "terminal", status: "pending", createdAt },
  ];
}

function safeHostRequestSummary(request: HostAssistanceRequest): string {
  if (request.kind === "decision")
    return `Human decision requested with ${request.options.length} bounded option(s)`;
  if (request.kind === "action-recommendation")
    return `Action recommendation recorded for ${request.actionClass}`;
  return `${request.contextClass} context requested (${request.dataClassification})`;
}

function requireHostRequest(job: JobRecord, requestId: string): HostAssistanceRequestSummary {
  const request = job.hostAssistanceRequests?.find((item) => item.id === requestId);
  if (!request) throw new Error(`Unknown Host Assistance request: ${requestId}`);
  return request;
}

function assertHostRequestPending(job: JobRecord, request: HostAssistanceRequestSummary): void {
  if (request.status !== "pending")
    throw new Error(`Host Assistance request is already ${request.status}: ${request.id}`);
  if (request.generation !== (job.generation ?? 1))
    throw new Error(`Host Assistance request generation is stale: ${request.id}`);
  if (!(job.pendingHostRequestIds ?? []).includes(request.id))
    throw new Error(`Host Assistance request is not active: ${request.id}`);
  if (Date.parse(request.expiresAt) <= Date.now())
    throw new Error(`Host Assistance request expired: ${request.id}`);
}

function acknowledgeHostRequestNotification(
  job: JobRecord,
  request: HostAssistanceRequestSummary,
  acknowledgedAt: string,
): void {
  const notification = job.notifications?.find(
    (item) =>
      (item.kind === "host-assistance" || item.kind === "human-decision") &&
      (item.hostRequestId === request.id || item.id === request.notificationId),
  );
  if (notification) {
    notification.status = "acknowledged";
    notification.acknowledgedAt = acknowledgedAt;
  }
}

function activeWaitStatus(job: JobRecord): JobStatus {
  if (job.pendingApprovalId) return "awaiting-approval";
  const pending = (job.hostAssistanceRequests ?? []).filter(
    (item) => (job.pendingHostRequestIds ?? []).includes(item.id) && item.status === "pending",
  );
  if (pending.some((item) => item.kind === "decision")) return "awaiting-decision";
  if (pending.length > 0) return "awaiting-host";
  return "running";
}

function normalizeHostAssistanceResponse(
  record: HostAssistanceRecord,
  input: unknown,
): HostAssistanceResult {
  const value =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (typeof value.requestId === "string" && value.requestId !== record.id) {
    throw new Error(`Host response request correlation mismatch: ${record.id}`);
  }
  if (value.kind === "unavailable") {
    const reason = [
      "declined",
      "expired",
      "disabled",
      "quota-exceeded",
      "policy-denied",
      "cancelled",
    ].includes(String(value.reason))
      ? (value.reason as import("../core/contracts.js").HostAssistanceUnavailable["reason"])
      : "declined";
    const base = {
      kind: "unavailable" as const,
      requestId: record.id,
      reason,
      message:
        typeof value.message === "string"
          ? value.message.slice(0, 4_000)
          : "Host Assistance is unavailable.",
      resolvedAt: new Date().toISOString(),
    };
    return { ...base, hash: valueHash(base) };
  }
  if (record.request.kind === "decision") {
    if (typeof value.decision !== "string" || !value.decision.trim())
      throw new Error("Human decision response requires a decision");
    const base = {
      kind: "decision" as const,
      requestId: record.id,
      decision: value.decision.slice(0, 4_000),
      ...(typeof value.rationale === "string"
        ? { rationale: value.rationale.slice(0, 8_000) }
        : {}),
      decidedAt: new Date().toISOString(),
    };
    return { ...base, hash: valueHash(base) };
  }
  if (record.request.kind === "action-recommendation") {
    const base = {
      kind: "action-recommendation" as const,
      requestId: record.id,
      status: value.status === "declined" ? ("declined" as const) : ("recorded" as const),
      message:
        typeof value.message === "string"
          ? value.message.slice(0, 4_000)
          : "Action recommendation recorded; no action was executed.",
      recordedAt: new Date().toISOString(),
    };
    return { ...base, hash: valueHash(base) };
  }
  if (typeof value.answer !== "string" || !value.answer.trim())
    throw new Error("Host context response requires an answer");
  const retrievedAt =
    typeof value.retrievedAt === "string" && Number.isFinite(Date.parse(value.retrievedAt))
      ? value.retrievedAt
      : new Date().toISOString();
  const claims = Array.isArray(value.claims)
    ? value.claims.flatMap((claim) => {
        if (!claim || typeof claim !== "object" || Array.isArray(claim)) return [];
        const candidate = claim as Record<string, unknown>;
        if (typeof candidate.claim !== "string") return [];
        return [
          {
            claim: candidate.claim.slice(0, 8_000),
            evidenceIds: stringList(candidate.evidenceIds, 100),
            confidence: (candidate.confidence === "high" || candidate.confidence === "low"
              ? candidate.confidence
              : "medium") as "low" | "medium" | "high",
          },
        ];
      })
    : [];
  const citations = Array.isArray(value.citations)
    ? value.citations.flatMap((citation) => {
        if (!citation || typeof citation !== "object" || Array.isArray(citation)) return [];
        const candidate = citation as Record<string, unknown>;
        if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return [];
        return [
          {
            id: candidate.id.slice(0, 200),
            title: candidate.title.slice(0, 1_000),
            ...(typeof candidate.url === "string" ? { url: candidate.url.slice(0, 4_000) } : {}),
            ...(typeof candidate.version === "string"
              ? { version: candidate.version.slice(0, 500) }
              : {}),
            retrievedAt:
              typeof candidate.retrievedAt === "string" &&
              Number.isFinite(Date.parse(candidate.retrievedAt))
                ? candidate.retrievedAt
                : retrievedAt,
          },
        ];
      })
    : [];
  const base = {
    kind: "context" as const,
    requestId: record.id,
    answer: `[UNTRUSTED_HOST_CONTEXT]\n${value.answer.slice(
      0,
      hostContextCharacterLimit(record.request.budget),
    )}`,
    claims,
    citations,
    conflicts: stringList(value.conflicts, 100),
    unknowns: stringList(value.unknowns, 100),
    provenance: stringList(value.provenance, 100),
    redactions: stringList(value.redactions, 100),
    retrievedAt,
  };
  return { ...base, hash: valueHash(base) };
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, limit)
        .map((item) => item.slice(0, 4_000))
    : [];
}

export function hostAssistanceFingerprint(request: HostAssistanceRequest): string {
  return valueHash({ kind: "host-assistance", request });
}

function normalizeHostAdjudicationReceipt(input: unknown): HostAdjudicationReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Host adjudication receipt must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.principal !== "host-model") {
    throw new Error("Automated adjudication requires principal host-model");
  }
  if (value.host !== "codex" && value.host !== "claude") {
    throw new Error("Host adjudication host is invalid");
  }
  if (
    value.decision !== "allow" &&
    value.decision !== "ask-user" &&
    value.decision !== "hard-deny"
  ) {
    throw new Error("Host adjudication decision is invalid");
  }
  if (!["low", "medium", "high", "critical"].includes(String(value.assessedRisk))) {
    throw new Error("Host adjudication risk is invalid");
  }
  const required = (field: string, limit: number): string => {
    const candidate = value[field];
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new Error(`Host adjudication ${field} is required`);
    }
    return candidate.slice(0, limit);
  };
  const decidedAt = required("decidedAt", 100);
  if (!Number.isFinite(Date.parse(decidedAt))) {
    throw new Error("Host adjudication decidedAt is invalid");
  }
  return {
    principal: "host-model",
    host: value.host,
    ...(typeof value.model === "string" && value.model.trim()
      ? { model: value.model.slice(0, 500) }
      : {}),
    decision: value.decision,
    assessedRisk: value.assessedRisk as HostAdjudicationReceipt["assessedRisk"],
    rationale: required("rationale", 8_000),
    constraints: stringList(value.constraints, 50),
    intentMatch: value.intentMatch === true,
    actionFingerprint: required("actionFingerprint", 200),
    policyHash: required("policyHash", 200),
    autoResolved: value.autoResolved === true,
    decidedAt,
  };
}

function assertHostAdjudicationBinding(
  job: JobRecord,
  request: JobRequest,
  receipt: HostAdjudicationReceipt,
): asserts request is JobRequest & { policySnapshot: Extract<PolicySnapshot, { version: 3 }> } {
  const snapshot = request.policySnapshot;
  if (snapshot?.version !== 3) throw new Error("Host-first review requires a v3 policy snapshot");
  if ((snapshot.hostAssistance.reviewMode ?? "user-only") !== "host-first") {
    throw new Error("Host-first review is disabled for this snapshotted Job");
  }
  if (receipt.host !== request.host || receipt.host !== job.host) {
    throw new Error("Host adjudication identity does not match the Job");
  }
  if (receipt.policyHash !== snapshot.hash || receipt.policyHash !== job.policyHash) {
    throw new Error("Host adjudication policy hash does not match the Job snapshot");
  }
  if (receipt.decision === "ask-user" && receipt.autoResolved) {
    throw new Error("An ask-user adjudication cannot be marked auto-resolved");
  }
  if (receipt.decision === "hard-deny" && !receipt.autoResolved) {
    throw new Error("A hard-deny adjudication must be marked auto-resolved");
  }
}

function assertHostAutoAllow(
  job: JobRecord,
  request: JobRequest,
  receipt: HostAdjudicationReceipt,
): asserts request is JobRequest & { policySnapshot: Extract<PolicySnapshot, { version: 3 }> } {
  assertHostAdjudicationBinding(job, request, receipt);
  if (request.policySnapshot.sandboxMode === "strict" || job.sandboxMode === "strict") {
    throw new Error("Strict mode cannot be expanded through Host auto-approval");
  }
  if (
    receipt.decision !== "allow" ||
    !receipt.autoResolved ||
    !receipt.intentMatch ||
    (receipt.assessedRisk !== "low" && receipt.assessedRisk !== "medium")
  ) {
    throw new Error("Host adjudication must be a confident low/medium-risk allow decision");
  }
}

function assertWorkerAssessmentComplete(assessment: WorkerAssessment | undefined): void {
  if (
    !assessment ||
    !assessment.purpose.trim() ||
    !assessment.blockedBy.trim() ||
    assessment.minimumAccess.length === 0 ||
    assessment.targets.length === 0 ||
    assessment.failureModes.length === 0 ||
    assessment.mitigations.length === 0 ||
    !assessment.rollback.trim() ||
    assessment.verification.length === 0 ||
    !assessment.fallback.trim()
  ) {
    throw new Error("Host auto-approval requires a complete WorkerAssessment");
  }
}

function assertHostCanAutoApproveCapability(
  job: JobRecord,
  request: JobRequest,
  approval: ApprovalRequest,
  scope: "once" | "job",
  receipt: HostAdjudicationReceipt,
): void {
  assertHostAutoAllow(job, request, receipt);
  if (scope !== "once") throw new Error("Host-model leases are limited to one exact action");
  if (
    receipt.actionFingerprint !== approval.actionFingerprint ||
    receipt.actionFingerprint.length !== 64
  ) {
    throw new Error("Host adjudication fingerprint does not match the pending approval");
  }
  assertWorkerAssessmentComplete(approval.workerAssessment);
  const policy = request.policySnapshot.hostAssistance;
  const autoScope = policy.autoApprovalScope ?? "context-only";
  if (autoScope === "context-only") {
    throw new Error("This Job permits Host auto-review for context only");
  }
  const capabilities = approval.decision.capabilities;
  const effectAssessment = approval.effectAssessment;
  if (effectAssessment) assertTrustedEffectAssessment(approval, effectAssessment);
  const legacyReadOnly =
    !effectAssessment &&
    (capabilities.every(
      (capability) => capability === "filesystem.read-workspace" || capability === "git.read",
    ) ||
      (approval.trustedReadOnly === true &&
        approval.toolName === "bash" &&
        capabilities.length === 1 &&
        capabilities[0] === "shell.execute"));
  const readOnly = effectAssessment?.effect === "read-only" || legacyReadOnly;
  if (autoScope === "read-only" && !readOnly) {
    throw new Error("This Job permits only read-only Host auto-approval");
  }
  const assessment = approval.workerAssessment!;
  if (!readOnly) {
    if (effectAssessment && effectAssessment.effect !== "reversible-workspace-write") {
      throw new Error("Host auto-approval requires trusted reversible effect evidence");
    }
    const mutationIntent =
      request.kind === "implement" ||
      request.kind === "setup" ||
      request.kind === "scaffold" ||
      (request.kind === "discover" && job.internalStage === "experiment");
    if (!mutationIntent) throw new Error("The original Job has no mutation intent");
    if (
      (effectAssessment && effectAssessment.reversibility !== "reversible") ||
      assessment.reversibility !== "reversible"
    ) {
      throw new Error("Only fully reversible mutations may be auto-approved");
    }
  }
  if (
    approval.toolName === "role-escalation" ||
    approval.toolName === "host-context-egress" ||
    (!effectAssessment &&
      /(?:^|[\\/])\.git(?:[\\/]|$)|\b(?:rm|rmdir|unlink|git\s+(?:add|commit|merge|push|reset)|deploy|publish|transaction)\b/i.test(
        approval.actionSummary,
      ))
  ) {
    throw new Error("The requested capability is outside the Host auto-approval ceiling");
  }
  for (const target of assessment.targets) {
    if (/(?:^|[\\/])\.git(?:[\\/]|$)/.test(target)) {
      throw new Error("Host auto-approval cannot target Git metadata");
    }
    if (path.isAbsolute(target)) {
      const relative = path.relative(request.cwd, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Host auto-approval target escapes the snapshotted workspace");
      }
    }
  }
}

function assertTrustedEffectAssessment(
  approval: ApprovalRequest,
  assessment: ActionEffectAssessment,
): void {
  if (
    assessment.version !== 1 ||
    !["deterministic-tool", "deterministic-shell"].includes(assessment.source)
  ) {
    throw new Error("Action effect evidence is invalid");
  }
  const decisionCapabilities = [...new Set(approval.decision.capabilities)].sort();
  const effectCapabilities = [...new Set(assessment.capabilities)].sort();
  if (JSON.stringify(decisionCapabilities) !== JSON.stringify(effectCapabilities)) {
    throw new Error("Action effect evidence does not match runtime capabilities");
  }
  if (assessment.effect === "read-only") {
    if (assessment.reversibility !== "read-only") {
      throw new Error("Read-only effect evidence has invalid reversibility");
    }
    if (approval.toolName === "bash" && assessment.source !== "deterministic-shell") {
      throw new Error("Read-only Bash requires deterministic shell evidence");
    }
    return;
  }
  if (assessment.effect === "reversible-workspace-write") {
    if (
      assessment.source !== "deterministic-tool" ||
      assessment.reversibility !== "reversible" ||
      (approval.toolName !== "write" && approval.toolName !== "edit")
    ) {
      throw new Error("Reversible write effect evidence is invalid");
    }
    return;
  }
  throw new Error("The trusted effect is outside the Host auto-approval ceiling");
}

function assertHostAdjudicationRequestBinding(
  job: JobRecord,
  request: JobRequest,
  record: HostAssistanceRecord,
  receipt: HostAdjudicationReceipt,
): void {
  assertHostAdjudicationBinding(job, request, receipt);
  const fingerprint = record.actionFingerprint ?? hostAssistanceFingerprint(record.request);
  if (receipt.actionFingerprint !== fingerprint || receipt.actionFingerprint.length !== 64) {
    throw new Error("Host adjudication fingerprint does not match the assistance request");
  }
}

function assertHostCanAutoResolveRequest(
  job: JobRecord,
  request: JobRequest,
  record: HostAssistanceRecord,
  response: unknown,
  receipt: HostAdjudicationReceipt,
): void {
  assertHostAutoAllow(job, request, receipt);
  assertHostAdjudicationRequestBinding(job, request, record, receipt);
  assertWorkerAssessmentComplete(record.request.workerAssessment);
  if (record.request.kind === "action-recommendation") {
    throw new Error("Action recommendations always require a user decision");
  }
  if (record.request.kind === "context") {
    if (
      record.request.contextClass === "connector" ||
      record.request.dataClassification === "private" ||
      record.request.dataClassification === "secret"
    ) {
      throw new Error("Private or connector context always requires a user decision");
    }
    return;
  }
  if (
    request.policySnapshot.hostAssistance.autoApproveDiscoveryGates !== true ||
    !record.perspective?.startsWith("discovery:")
  ) {
    throw new Error("Only snapshotted Discovery gates may be auto-decided");
  }
  const value = response as Record<string, unknown> | null;
  if (!value || typeof value.decision !== "string" || value.decision.toLowerCase() !== "approve") {
    throw new Error("Automated Discovery gate decisions may only approve a valid bounded gate");
  }
}

function valueHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function responseTimestamp(result: HostAssistanceResult): string {
  if (result.kind === "context") return result.retrievedAt;
  if (result.kind === "decision") return result.decidedAt;
  if (result.kind === "action-recommendation") return result.recordedAt;
  return result.resolvedAt;
}

async function expireHostRequest(cwd: string, jobId: string, requestId: string): Promise<void> {
  const file = await ensureHostAssistanceArtifact(await jobDirectory(cwd, jobId), requestId);
  const record = await readRequiredJson<HostAssistanceRecord>(file);
  const resolvedAt = new Date().toISOString();
  const base = {
    kind: "unavailable" as const,
    requestId,
    reason: "expired" as const,
    message: "Host Assistance request expired before a response was provided.",
    resolvedAt,
  };
  const response: HostAssistanceResult = { ...base, hash: valueHash(base) };
  await updateState(cwd, (state) => {
    const job = requireJob(state.jobs, jobId);
    const summary = requireHostRequest(job, requestId);
    if (summary.status !== "pending") return;
    summary.status = "expired";
    summary.resolvedAt = resolvedAt;
    summary.responseHash = response.hash;
    job.pendingHostRequestIds = (job.pendingHostRequestIds ?? []).filter((id) => id !== requestId);
    acknowledgeHostRequestNotification(job, summary, resolvedAt);
    job.status = activeWaitStatus(job);
    job.updatedAt = resolvedAt;
  });
  await writeJson(file, {
    ...record,
    status: "expired",
    resolvedAt,
    responseHash: response.hash,
    response,
  });
}

async function ensureHostAssistanceArtifact(jobDir: string, requestId: string): Promise<string> {
  const directory = path.join(jobDir, "host-assistance");
  const file = path.join(directory, `${requestId}.json`);
  try {
    await fs.access(file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = path.join(directory, `${requestId}.pending.json`);
  try {
    await fs.rename(pending, file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Host Assistance request artifact is missing: ${requestId}`);
    }
    throw error;
  }
}

async function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error(message));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function requireApproval(job: JobRecord, approvalId: string): ApprovalRequest {
  const approval = job.approvals?.find((item) => item.id === approvalId);
  if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
  return approval;
}

function assertApprovalPending(job: JobRecord, approval: ApprovalRequest, now: Date): void {
  if (approval.status !== "pending")
    throw new Error(`Approval is already ${approval.status}: ${approval.id}`);
  if (approval.generation !== (job.generation ?? 1))
    throw new Error(`Approval generation is stale: ${approval.id}`);
  if (Date.parse(approval.expiresAt) <= now.getTime())
    throw new Error(`Approval expired: ${approval.id}`);
  if (job.pendingApprovalId !== approval.id)
    throw new Error(`Approval is not active: ${approval.id}`);
}

async function expireApproval(cwd: string, jobId: string, approvalId: string): Promise<void> {
  await updateState(cwd, (state) => {
    const job = requireJob(state.jobs, jobId);
    const approval = requireApproval(job, approvalId);
    if (approval.status !== "pending") return;
    approval.status = "expired";
    approval.resolvedAt = new Date().toISOString();
    delete job.pendingApprovalId;
    job.status = activeWaitStatus(job);
    job.updatedAt = approval.resolvedAt;
  });
}

function acknowledgeApprovalNotification(
  job: JobRecord,
  approval: ApprovalRequest,
  acknowledgedAt: string,
): void {
  const notification = job.notifications?.find(
    (item) =>
      item.kind === "approval" &&
      (item.approvalId === approval.id || item.id === approval.notificationId),
  );
  if (notification) {
    notification.status = "acknowledged";
    notification.acknowledgedAt = acknowledgedAt;
  }
  approval.notification = "acknowledged";
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

async function assertJobArtifactsAvailable(cwd: string, jobId: string): Promise<void> {
  const job = (await loadState(cwd, { migrateLegacy: false })).jobs.find(
    (candidate) => candidate.id === jobId,
  );
  if (typeof job?.prunedAt === "string") {
    throw new Error(`Job artifacts were pruned at ${job.prunedAt}: ${jobId}`);
  }
  if (job?.pruneOperation) {
    throw new Error(`Job artifacts are being pruned: ${jobId}`);
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
