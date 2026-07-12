import fs from "node:fs/promises";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type {
  ApprovalRequest,
  JobAuditExportV1,
  DelegationSpec,
  Host,
  PolicyDecision,
  PolicySnapshot,
  ProviderSummary,
  ReadinessReport,
  SandboxMode,
  ScaffoldSpec,
  TaskKind,
  ThinkingLevel,
  WorkerResult,
  WorkerRequest,
} from "../core/contracts.js";
import { buildReviewRequest } from "../git/review.js";
import { checkpointJobWorktree, cleanupJobWorktree, materializeJobWorktree, prepareJobWorktree } from "../git/job-worktree.js";
import { checkpointScaffold, materializeScaffold, parseScaffoldSpec, prepareScaffoldWorkspace, type ScaffoldWorkspace } from "../git/scaffold.js";
import {
  acquireWorktreeLease,
  assertWorktreeBaseline,
  captureIgnoredPaths,
  captureWorktreeChanges,
  inspectWorktree,
  assessWorkspace,
  requireCleanWorktree,
  validateChangedPaths,
  WorktreeBaselineError,
} from "../git/worktree.js";
import { executeSession, type RunnableSession } from "../pi/execute.js";
import {
  createModelCatalog,
  describeModels,
  describeProviders,
  modelId,
  orderModels,
  type ModelCatalog,
  type PiModel,
} from "../pi/models.js";
import { createWorkerSession } from "../pi/runtime.js";
import { createSandboxRunner, type SandboxRunner } from "../sandbox/runner.js";
import { PiPolicyClassifier } from "../policy/classifier.js";
import {
  ClassifierDecisionCache,
  PolicyEngine,
  actionFingerprint,
  type PolicyAction,
  type PolicyClassifier,
} from "../policy/engine.js";
import { loadRepositoryDenyRules } from "../policy/project-policy.js";
import { exportJobAudit } from "../audit/export.js";
import {
  acknowledgeJob,
  attachJobProcess,
  cancelJob,
  finishJob,
  getJob,
  heartbeatJob,
  JOB_HEARTBEAT_INTERVAL_MS,
  listJobs,
  markJobRunning,
  modelConfigurationSnapshotHash,
  readJobPrompt,
  readJobRequest,
  updateJobExecutionWorkspace,
  updateJobProgress,
  requestJobApproval,
  startJob,
  waitForApprovalResolution,
  createJobLeaseProvider,
  appendPolicyEvent,
  waitForJob,
  approveJob,
  denyJobApproval,
  listJobApprovals,
  isTerminalJobStatus,
  type JobHandle,
  type JobRequest,
} from "../state/jobs.js";
import {
  clearModelConfiguration,
  loadModelConfiguration,
  modelPriority,
  parseModelConfiguration,
  saveModelPriority,
  type ModelConfiguration,
} from "../state/model-config.js";
import {
  clearConfiguration,
  defaultState,
  resolveStateDir,
  loadState,
  saveProfile,
  setAvailableModels,
  setModelPriority,
  updateState,
  type SwarmProfile,
} from "../state/state.js";
import type { JobRecord } from "../state/state.js";
import { StateMigrationConflictError } from "../state/state.js";
import { createContinuation, consumeContinuation, readContinuation } from "../onboarding/continuations.js";
import { inspectReadiness } from "../onboarding/readiness.js";
import type { RunnerArguments } from "./args.js";
import { spawnBackgroundWorker, type SpawnBackgroundWorkerOptions } from "./background.js";
import { buildWorkerPrompt } from "./prompts.js";
import {
  assertRoleCompatible,
  createPolicySnapshot,
  defaultRoleForTask,
  listDefaultRoles,
  isWorkerRole,
  normalizeAdaptivePolicy,
  resolveRolePolicy,
} from "../orchestration/roles.js";

export interface RunnerDependencies {
  catalog: ModelCatalog;
  readFile(path: string): Promise<string>;
  createSession(options: {
    cwd: string;
    mode: "readonly" | "implement";
    model: PiModel;
    sandboxRunner?: SandboxRunner;
    thinkingLevel?: ThinkingLevel;
    policyEngine?: PolicyEngine;
    onApproval?: (
      action: PolicyAction,
      decision: PolicyDecision,
      fingerprint: string,
      signal?: AbortSignal,
    ) => Promise<"approved" | "denied" | "expired">;
  }): Promise<RunnableSession>;
  createClassifier?(options: {
    cwd: string;
    models: PiModel[];
    thinkingLevel: ThinkingLevel;
  }): PolicyClassifier;
}

export type RunnerOutput =
  | WorkerResult
  | JobAuditExportV1
  | { event: "accepted"; jobId: string; status: "queued"; executionMode: "background" }
  | { event: "wait-timed-out"; jobId: string; status: string }
  | { event: "approval-required"; jobId: string; status: "awaiting-approval"; approval: ApprovalRequest }
  | { event: "setup-required"; continuationId: string; readiness: ReadinessReport }
  | {
      event: "workspace-action-required";
      errorCode: string;
      message: string;
      continuationId: string;
      workspace: import("../core/contracts.js").WorkspaceAssessment;
      strategies: string[];
      nextActions: Array<{ action: string; label: string }>;
    }
  | { jobs: PublicJobRecord[] }
  | { job: PublicJobRecord; result: WorkerResult | null }
  | { job: PublicJobRecord }
  | { job: PublicJobRecord; approval: import("../core/contracts.js").ApprovalRequest; lease?: import("../core/contracts.js").CapabilityLease }
  | { approvals: import("../core/contracts.js").ApprovalRequest[] }
  | { cleaned: true; jobId: string }
  | { materialized: true; jobId: string; target: string; commit: string; changedFiles?: string[]; cleanupWarnings?: string[] }
  | ReadinessReport
  | (ReadinessReport & { smokeTest: { status: "not-run" | "passed" | "failed"; model: string | null; error?: string } })
  | { roles: ReturnType<typeof listDefaultRoles>; sandboxMode: SandboxMode; approvalPolicy: "deny" | "wait"; classifierModels: string[] }
  | { models: ReturnType<typeof describeModels>; active: string | null; providers: Record<string, number> }
  | { providers: ProviderSummary[]; registryError: string | null }
  | {
      configured: boolean;
      reconfigure: boolean;
      reset: boolean;
      activeModel: string | null;
      modelPriority: string[];
      detectedModels: string[];
      profile: SwarmProfile | null;
      sandboxMode: SandboxMode;
      jobs: number;
    };

export interface RunCommandOptions {
  signal?: AbortSignal;
  spawnWorker?: (options: SpawnBackgroundWorkerOptions) => Promise<number>;
  requestOverride?: WorkerRequest;
  continuationId?: string;
}

type PublicJobRecord = Omit<JobRecord, "workerToken">;
const approvalQueues = new Map<string, Promise<void>>();

export function defaultDependencies(modelConfiguration: ModelConfiguration): RunnerDependencies {
  return {
    catalog: createModelCatalog(modelConfiguration),
    readFile: (file) => fs.readFile(file, "utf8"),
    createSession: async (options) => {
      const { session } = await createWorkerSession({ ...options, modelConfiguration });
      return session;
    },
    createClassifier: (options) => new PiPolicyClassifier({
      ...options,
      modelConfiguration,
    }),
  };
}

export async function runCommand(
  args: RunnerArguments,
  cwd: string,
  dependencies?: RunnerDependencies,
  options: RunCommandOptions = {},
): Promise<RunnerOutput> {
  if (args.command === "configure") {
    throw new Error("configure must be started through the CLI web configuration entry point");
  }
  if (args.command === "jobs") return handleJobs(args, cwd);
  if (args.command === "__worker") {
    return runBackgroundJob(args, cwd, dependencies, options.signal);
  }
  if (args.command === "status" || args.command === "doctor") {
    return handleReadiness(args, cwd, dependencies);
  }
  if (args.command === "resume") {
    const continuation = await readContinuation(cwd, args.continuationId!);
    const resumed = await runCommand(
      requestArguments(continuation.request), continuation.request.cwd, dependencies,
      { ...options, requestOverride: continuation.request, continuationId: continuation.id },
    );
    if (!("event" in resumed) || (resumed.event !== "setup-required" && resumed.event !== "workspace-action-required")) {
      await consumeContinuation(cwd, continuation.id);
    }
    return resumed;
  }
  const state = await loadState(cwd);
  const modelConfiguration = await loadModelConfiguration(cwd, state.config.modelPriority);
  const activeDependencies = dependencies ?? defaultDependencies(modelConfiguration);
  const available = activeDependencies.catalog.available();
  if (args.command === "roles") {
    const background = state.config.backgroundRolePolicy;
    const roles = listDefaultRoles().map((role) => isWorkerRole(role.role)
      ? resolveRolePolicy(role.role, state.config.rolePolicies, modelPriority(modelConfiguration), background)
      : role);
    const adaptive = normalizeAdaptivePolicy(state.config.adaptivePolicy);
    return {
      roles,
      sandboxMode: state.config.sandboxMode ?? "strict",
      approvalPolicy: adaptive.approvalPolicy,
      classifierModels: adaptive.classifierModels,
    };
  }
  if (args.command === "models") {
    return modelInventory(activeDependencies.catalog, modelConfiguration, args);
  }
  if (args.command === "providers") {
    return {
      providers: describeProviders(activeDependencies.catalog, modelConfiguration),
      registryError: activeDependencies.catalog.error?.() ?? null,
    };
  }
  if (args.command === "init") {
    return handleInit(
      args,
      cwd,
      available,
      activeDependencies,
      modelConfiguration,
    );
  }
  const host = args.host!;
  const scaffoldSpec: ScaffoldSpec | undefined = options.requestOverride?.scaffoldSpec ?? (args.command === "scaffold"
    ? parseScaffoldSpec(await activeDependencies.readFile(args.specFile!))
    : undefined);
  const rawPrompt = options.requestOverride?.prompt ?? (scaffoldSpec
    ? scaffoldSpec.request
    :
    args.command === "review"
      ? await buildReviewRequest(cwd, { base: args.base, scope: args.scope })
      : await activeDependencies.readFile(args.promptFile!));
  const executionMode = args.executionMode ?? "supervised";
  const sandboxMode = state.config.sandboxMode ?? "strict";
  const roleId = args.role ?? defaultRoleForTask(args.command);
  let rolePolicy = resolveRolePolicy(
    roleId,
    state.config.rolePolicies,
    modelPriority(modelConfiguration),
    state.config.backgroundRolePolicy,
  );
  if (args.thinkingLevel) rolePolicy = { ...rolePolicy, thinkingLevel: args.thinkingLevel };
  if (roleId === "scaffolder" && executionMode === "background") {
    rolePolicy = {
      ...rolePolicy,
      capabilities: rolePolicy.capabilities.filter((capability) => capability !== "shell.execute" && capability !== "network.connect"),
    };
  }
  assertRoleCompatible(rolePolicy, args.command, executionMode);
  const adaptivePolicy = normalizeAdaptivePolicy(state.config.adaptivePolicy);
  adaptivePolicy.rules.push(...await loadRepositoryDenyRules(cwd));
  const approvalMode = args.approvalMode ?? adaptivePolicy.approvalPolicy;
  const escalationPolicy = roleId === "mechanical-executor"
    ? resolveRolePolicy("executor", state.config.rolePolicies, modelPriority(modelConfiguration), state.config.backgroundRolePolicy)
    : undefined;
  const policySnapshot = createPolicySnapshot({
    sandboxMode,
    approvalMode,
    rolePolicy,
    adaptivePolicy,
    ...(escalationPolicy ? { escalationPolicy } : {}),
  });
  const candidates = orderModels(available, {
    requested: args.model,
    priority: rolePolicy.models.length ? rolePolicy.models : modelPriority(modelConfiguration),
  }).slice(0, rolePolicy.maxAttempts);
  const delegationSpec = options.requestOverride?.delegationSpec ?? (args.specFile && args.command !== "scaffold"
    ? parseDelegationSpec(await activeDependencies.readFile(args.specFile))
    : { request: rawPrompt });
  const timeoutMs = args.timeoutMs ?? defaultTimeoutMs(args.command);
  let workspaceStrategy = args.workspaceStrategy ?? options.requestOverride?.workspaceStrategy ?? "auto";
  const target = args.target ?? options.requestOverride?.target;
  const adoptExisting = args.adoptExisting ?? options.requestOverride?.adoptExisting ?? false;
  const readiness = await inspectReadiness({
    cwd,
    state,
    modelPriority: modelPriority(modelConfiguration),
    availableModels: available.map(modelId),
    registryError: activeDependencies.catalog.error?.() ?? null,
  });
  if (isMutationTask(args.command) && workspaceStrategy === "auto" && readiness.workspace.disposition === "safe-dirty") {
    workspaceStrategy = "isolated-head";
  }
  const workerRequest: WorkerRequest = {
    host,
    kind: args.command,
    cwd,
    prompt: rawPrompt,
    mode: isMutationTask(args.command) ? "implement" : "readonly",
    executionMode,
    sandboxMode,
    timeoutMs,
    ...(args.model ? { model: args.model } : {}),
    role: roleId,
    thinkingLevel: rolePolicy.thinkingLevel,
    approvalMode,
    delegationSpec,
    policySnapshot,
    workspaceStrategy,
    ...(target ? { target } : {}),
    ...(scaffoldSpec ? { scaffoldSpec } : {}),
    ...(adoptExisting ? { adoptExisting: true } : {}),
  };
  const setupBlocked = !dependencies && readiness.issues.some((issue) => issue.severity === "blocking" && issue.stage !== "workspace");
  if (setupBlocked) {
    const continuation = await createContinuation(cwd, workerRequest);
    return { event: "setup-required", continuationId: continuation.id, readiness };
  }
  const mutationCommand = args.command === "implement" || args.command === "setup";
  if ((args.command !== "scaffold" && readiness.workspace.disposition === "unsafe") ||
      (mutationCommand && (
       readiness.workspace.disposition === "git-unborn" ||
       readiness.workspace.disposition === "non-git-empty" ||
       readiness.workspace.disposition === "non-git-existing" ||
       (readiness.workspace.disposition === "user-dirty" && workspaceStrategy === "auto")))) {
    const continuationId = options.continuationId ?? (await createContinuation(cwd, workerRequest, { workspaceFence: "repair" })).id;
    const userDirty = readiness.workspace.disposition === "user-dirty";
    const unborn = readiness.workspace.disposition === "git-unborn";
    const unsafe = readiness.workspace.disposition === "unsafe";
    const strategies = unsafe ? ["inspect-workspace"] : userDirty ? ["isolated-head", "isolated-snapshot"] : ["scaffold", "inspect-adoption"];
    return {
      event: "workspace-action-required",
      errorCode: unsafe ? "workspace-unsafe" : unborn ? "workspace-unborn-head" : userDirty ? "workspace-user-dirty" : `workspace-${readiness.workspace.disposition}`,
      message: unsafe
        ? "The workspace contains conflicts or unsafe filesystem entries. No model was started; inspect and repair the workspace before resuming."
        : unborn
        ? "The Git repository has no initial commit. No model was started; scaffold or adopt the workspace, then resume the preserved request."
        : "The workspace requires an explicit execution strategy before a mutation worker can start.",
      continuationId,
      workspace: readiness.workspace,
      strategies,
      nextActions: strategies.map((action) => ({
        action,
        label: action === "isolated-head" ? "Run from HEAD"
          : action === "isolated-snapshot" ? "Include a local snapshot"
            : action === "scaffold" ? "Design the initial project"
              : action === "inspect-workspace" ? "Review blocking workspace entries"
              : "Inspect and adopt existing files",
      })),
    };
  }
  if (args.command === "scaffold" && scaffoldSpec?.targetMode === "adopt" && !adoptExisting) {
    const continuationId = options.continuationId ?? (await createContinuation(cwd, workerRequest, { workspaceFence: "repair" })).id;
    return {
      event: "workspace-action-required",
      errorCode: "workspace-adoption-approval-required",
      message: "Existing target content requires explicit adoption approval before a worker can start.",
      continuationId,
      workspace: await assessWorkspace(path.resolve(cwd, target!)),
      strategies: ["approve-adoption"],
      nextActions: [{ action: "approve-adoption", label: "Review and approve adoption" }],
    };
  }
  const job = await startJob(cwd, {
    host,
    kind: args.command,
    prompt: rawPrompt,
    cwd,
    executionMode,
    sandboxMode,
    timeoutMs,
    ...(args.model ? { model: args.model } : {}),
    role: roleId,
    thinkingLevel: rolePolicy.thinkingLevel,
    approvalMode,
    delegationSpec,
    policySnapshot,
    workspaceStrategy,
    ...(target ? { target } : {}),
    ...(scaffoldSpec ? { scaffoldSpec } : {}),
    ...(adoptExisting ? { adoptExisting: true } : {}),
    modelConfiguration,
  });
  let executionCwd = cwd;
  try {
    if (args.command === "scaffold") {
      if (!target) throw new Error("Scaffold target is missing from the request");
      const workspace = await prepareScaffoldWorkspace(cwd, target, job.id, scaffoldSpec!);
      await updateJobExecutionWorkspace(cwd, job.id, job.workerToken, workspace);
      executionCwd = workspace.worktree;
    } else if ((args.command === "implement" || args.command === "setup") &&
      (workspaceStrategy !== "auto" || executionMode === "background")) {
      const workspace = await prepareJobWorktree(cwd, job.id, workspaceStrategy);
      await updateJobExecutionWorkspace(cwd, job.id, job.workerToken, workspace);
      executionCwd = workspace.worktree;
    }
  } catch (error) {
    const failed = withMetadata(failure(args.command, error instanceof Error ? error.message : String(error)), host, job.id, 0);
    await finishJob(cwd, job.id, failed);
    return failed;
  }
  if (executionMode === "background") {
    try {
      const spawnWorker = options.spawnWorker ?? spawnBackgroundWorker;
      const pid = await spawnWorker({ cwd, jobId: job.id, workerToken: job.workerToken });
      await attachJobProcess(cwd, job.id, job.workerToken, pid);
      return { event: "accepted", jobId: job.id, status: "queued", executionMode: "background" };
    } catch (error) {
      const failed = withMetadata(
        failure(args.command, error instanceof Error ? error.message : String(error)),
        host,
        job.id,
        0,
      );
      await finishJob(cwd, job.id, failed);
      return failed;
    }
  }
  return runStartedJobSafely({
    args,
    cwd: executionCwd,
    stateCwd: cwd,
    host,
    rawPrompt,
    ...(state.config.profile ? { profile: state.config.profile } : {}),
    candidates,
    dependencies: activeDependencies,
    job,
    timeoutMs,
    sandboxMode,
    policySnapshot,
    modelConfiguration,
    executionMode,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function handleJobs(args: RunnerArguments, cwd: string): Promise<RunnerOutput> {
  switch (args.jobsAction) {
    case "list":
      return { jobs: (await listJobs(cwd, args.pendingNotifications ?? false)).map(publicJob) };
    case "status": {
      const snapshot = await getJob(cwd, args.jobId!);
      return { job: publicJob(snapshot.job), result: snapshot.result };
    }
    case "export":
      return exportJobAudit(cwd, args.jobId!);
    case "wait":
      return waitForJob(cwd, args.jobId!, args.waitTimeoutMs);
    case "cancel":
      return { job: publicJob(await cancelJob(cwd, args.jobId!)) };
    case "acknowledge":
      return { job: publicJob(await acknowledgeJob(cwd, args.jobId!, args.notificationId)) };
    case "approvals":
      return { approvals: await listJobApprovals(cwd, args.jobId!) };
    case "approve": {
      const approved = await approveJob(cwd, args.jobId!, args.approvalId!, args.approvalScope);
      return { job: publicJob(approved.job), approval: approved.approval, lease: approved.lease };
    }
    case "deny": {
      const denied = await denyJobApproval(cwd, args.jobId!, args.approvalId!);
      return { job: publicJob(denied.job), approval: denied.approval };
    }
    case "materialize": {
      const snapshot = await getJob(cwd, args.jobId!);
      if (snapshot.job.materializedAt && typeof snapshot.job.materializedTarget === "string" && snapshot.result?.artifact?.commit) {
        return {
          materialized: true,
          jobId: args.jobId!,
          target: snapshot.job.materializedTarget,
          commit: snapshot.result.artifact.commit,
        };
      }
      const workspace = snapshot.job.executionWorkspace as ScaffoldWorkspace | undefined;
      if (!workspace || !snapshot.result?.artifact?.commit || !snapshot.result.artifact.deliverable) {
        throw new Error(`Job has no verified deliverable artifact: ${args.jobId}`);
      }
      if (snapshot.job.kind !== "scaffold") {
        const materialized = await materializeJobWorktree(cwd, args.jobId!, {
          worktree: workspace.worktree,
          branch: workspace.branch,
          base: workspace.base,
          commit: snapshot.result.artifact.commit,
        });
        await updateState(cwd, (state) => {
          const job = state.jobs.find((item) => item.id === args.jobId);
          if (job) {
            job.materializedAt = new Date().toISOString();
            job.materializedTarget = materialized.target;
          }
        });
        return { materialized: true, jobId: args.jobId!, ...materialized };
      }
      const sourceStateDir = await resolveStateDir(cwd);
      const target = path.resolve(args.target ?? workspace.target);
      const controlRoot = await fs.realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
      const targetRoot = await fs.realpath(target).catch(() => target);
      const moveState = controlRoot === targetRoot && !(await assessWorkspace(cwd)).git;
      const materialized = await materializeScaffold({
        workspace,
        result: snapshot.result,
        ...(args.target ? { target: args.target } : {}),
        stateDir: sourceStateDir,
        moveState,
        afterSwap: async () => {
          await updateState(cwd, (state) => {
            const job = state.jobs.find((item) => item.id === args.jobId);
            if (job) {
              job.materializedAt = new Date().toISOString();
              job.materializedTarget = target;
              job.cleanedAt = new Date().toISOString();
            }
          });
        },
      });
      const cleanupWarnings = [...materialized.cleanupWarnings];
      if (materialized.stateMoved && path.resolve(sourceStateDir) !== path.resolve(await resolveStateDir(cwd))) {
        await fs.rm(sourceStateDir, { recursive: true, force: true }).catch(() => {
          cleanupWarnings.push(`Previous runtime state retained for recovery: ${sourceStateDir}`);
        });
      }
      await fs.rm(workspace.worktree, { recursive: true, force: true }).catch(() => {
        cleanupWarnings.push(`Staging artifact retained for cleanup: ${workspace.worktree}`);
      });
      return {
        materialized: true,
        jobId: args.jobId!,
        target: materialized.target,
        commit: materialized.commit,
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      };
    }
    case "cleanup": {
      const snapshot = await getJob(cwd, args.jobId!);
      if (!isTerminalJobStatus(snapshot.job.status)) throw new Error(`Job is not terminal: ${args.jobId}`);
      const workspace = snapshot.job.executionWorkspace as { worktree: string; branch: string; base: string } | undefined;
      if (!workspace) throw new Error(`Job has no isolated worktree: ${args.jobId}`);
      await cleanupJobWorktree(cwd, {
        ...workspace,
        ...(snapshot.result?.artifact?.commit ? { commit: snapshot.result.artifact.commit } : {}),
      }, args.discard ?? Boolean(snapshot.job.materializedAt));
      await updateState(cwd, (state) => {
        const job = state.jobs.find((item) => item.id === args.jobId);
        if (job) job.cleanedAt = new Date().toISOString();
      });
      return { cleaned: true, jobId: args.jobId! };
    }
    default:
      throw new Error(`Unknown jobs action: ${args.jobsAction ?? "<none>"}`);
  }
}

function publicJob(job: JobRecord): PublicJobRecord {
  const { workerToken: _workerToken, ...publicRecord } = job;
  return publicRecord;
}

async function runBackgroundJob(
  args: RunnerArguments,
  cwd: string,
  dependencies?: RunnerDependencies,
  outerSignal?: AbortSignal,
): Promise<WorkerResult> {
  const request = await readJobRequest(cwd, args.jobId!);
  if (request.workerToken !== args.workerToken) throw new Error(`Worker token mismatch for job: ${request.id}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const forwardAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const snapshot = await getJob(cwd, request.id);
    if (snapshot.job.cancelRequestedAt) controller.abort();
    const state = await loadState(cwd);
    const modelConfiguration = request.modelConfiguration
      ? parseModelConfiguration(request.modelConfiguration)
      : await loadModelConfiguration(cwd, state.config.modelPriority);
    if (request.requestVersion === 3) {
      if (!request.modelConfiguration || !request.providerSnapshotHash) {
        throw new Error("Background job is missing its provider configuration snapshot");
      }
      if (modelConfigurationSnapshotHash(modelConfiguration) !== request.providerSnapshotHash) {
        throw new Error("Background job provider configuration snapshot failed integrity validation");
      }
    }
    const activeDependencies = dependencies ?? defaultDependencies(modelConfiguration);
    const candidates = orderModels(activeDependencies.catalog.available(), {
      requested: request.model,
      priority: request.policySnapshot?.rolePolicy.models.length
        ? request.policySnapshot.rolePolicy.models
        : modelPriority(modelConfiguration),
    }).slice(0, request.policySnapshot?.rolePolicy.maxAttempts ?? 2);
    const prompt = await readJobPrompt(cwd, request.id);
    return runStartedJobSafely({
      args: requestArguments(request),
      cwd: request.cwd,
      stateCwd: cwd,
      host: request.host,
      rawPrompt: prompt,
      ...(state.config.profile ? { profile: state.config.profile } : {}),
      candidates,
      dependencies: activeDependencies,
      job: { id: request.id, workerToken: request.workerToken },
      timeoutMs: request.timeoutMs,
      sandboxMode: request.sandboxMode ?? "strict",
      policySnapshot: request.policySnapshot ?? legacyPolicySnapshot(request, modelPriority(modelConfiguration)),
      modelConfiguration,
      executionMode: request.executionMode,
      signal: controller.signal,
    });
  } catch (error) {
    const failed = withMetadata(
      failure(request.kind, error instanceof Error ? error.message : String(error), request.model ?? null),
      request.host,
      request.id,
      0,
    );
    await finishJob(cwd, request.id, failed);
    return failed;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}

function requestArguments(request: JobRequest | WorkerRequest): RunnerArguments {
  return {
    command: request.kind,
    host: request.host,
    ...(request.model ? { model: request.model } : {}),
    executionMode: "supervised",
    timeoutMs: request.timeoutMs,
    ...(request.role ? { role: request.role } : {}),
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
    ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}),
    ...(request.workspaceStrategy ? { workspaceStrategy: request.workspaceStrategy } : {}),
    ...(request.target ? { target: request.target } : {}),
    ...(request.adoptExisting ? { adoptExisting: true } : {}),
    reconfigure: false,
    reset: false,
    json: true,
  };
}

async function runStartedJobSafely(
  options: Parameters<typeof runStartedJob>[0],
): Promise<WorkerResult> {
  try {
    return await runStartedJob(options);
  } catch (error) {
    const kind = options.args.command as TaskKind;
    const failed = withMetadata(
      failure(kind, error instanceof Error ? error.message : String(error), options.args.model ?? null),
      options.host,
      options.job.id,
      0,
    );
    if (error instanceof WorktreeBaselineError) failed.errorCode = error.code;
    await finishJob(options.stateCwd, options.job.id, failed);
    return failed;
  }
}

async function runStartedJob(options: {
  args: Extract<RunnerArguments, { command: TaskKind }> | RunnerArguments;
  cwd: string;
  stateCwd: string;
  host: Host;
  rawPrompt: string;
  profile?: SwarmProfile;
  candidates: PiModel[];
  dependencies: RunnerDependencies;
  job: JobHandle;
  timeoutMs: number;
  sandboxMode: SandboxMode;
  policySnapshot: PolicySnapshot;
  modelConfiguration: ModelConfiguration;
  executionMode: import("../core/contracts.js").ExecutionMode;
  signal?: AbortSignal;
}): Promise<WorkerResult> {
  const kind = options.args.command as TaskKind;
  const jobId = options.job.id;
  let actualRole = options.policySnapshot.rolePolicy.role;
  const orchestrationTrace: NonNullable<WorkerResult["orchestrationTrace"]> = [];
  await markJobRunning(options.stateCwd, jobId, options.job.workerToken, process.pid);
  const heartbeat = setInterval(() => {
    void heartbeatJob(options.stateCwd, jobId, options.job.workerToken, process.pid).catch(() => {});
  }, JOB_HEARTBEAT_INTERVAL_MS);
  const deadline = Date.now() + options.timeoutMs;
  let sandboxRunner: SandboxRunner | undefined;
  let worktreeLease: Awaited<ReturnType<typeof acquireWorktreeLease>> | undefined;

  try {
    if (options.candidates.length === 0) {
      const result = withMetadata(
        failure(kind, options.args.model ? `Requested Pi model is unavailable: ${options.args.model}` : "No configured Pi model is available."),
        options.host,
        jobId,
        0,
      );
      await finishJob(options.stateCwd, jobId, result);
      return result;
    }

    if (kind === "implement" || kind === "setup") {
      try {
        worktreeLease = await acquireWorktreeLease(options.cwd, jobId);
        await requireCleanWorktree(options.cwd);
      } catch (error) {
        const result = withMetadata(
          failure(kind, error instanceof Error ? error.message : String(error)),
          options.host,
          jobId,
          0,
        );
        await finishJob(options.stateCwd, jobId, result);
        return result;
      }
    }

    await updateJobProgress(options.stateCwd, jobId, options.job.workerToken, "delegating", "Pi is working on the assigned task.");

    const workerMode = isMutationTask(kind) ? "implement" : "readonly";
    const classifierModels = options.policySnapshot.adaptivePolicy.classifierModels
      .map((reference) => options.dependencies.catalog.available().find((model) => modelId(model) === reference))
      .filter((model): model is PiModel => Boolean(model));
    const classifier = options.sandboxMode === "adaptive" && classifierModels.length && options.dependencies.createClassifier
      ? options.dependencies.createClassifier({
          cwd: options.cwd,
          models: classifierModels,
          thinkingLevel: options.policySnapshot.adaptivePolicy.classifierThinkingLevel,
        })
      : undefined;
    const metrics = { allowed: 0, denied: 0, approvals: 0 };
    let sideEffectsObserved = false;
    const engine = new PolicyEngine({
      snapshot: options.policySnapshot,
      ...(classifier ? { classifier } : {}),
      classifierCache: new ClassifierDecisionCache(),
      leases: createJobLeaseProvider(options.stateCwd, jobId),
      onDecision: async (action, decision, fingerprint, metadata) => {
        if (decision.decision === "allow") metrics.allowed += 1;
        else if (decision.decision === "deny") metrics.denied += 1;
        else metrics.approvals += 1;
        if (decision.decision === "allow" && decision.capabilities.some((capability) =>
          capability === "filesystem.write-workspace" || capability === "shell.execute" || capability === "network.connect")) {
          sideEffectsObserved = true;
        }
        await appendPolicyEvent(options.stateCwd, jobId, {
          timestamp: new Date().toISOString(),
          tool: action.toolName,
          fingerprint,
          decision: decision.decision,
          risk: decision.risk,
          reason: decision.reason.slice(0, 500),
          ...(options.policySnapshot.adaptivePolicy.diagnostics ? { action: summarizePolicyAction(action) } : {}),
          ...(metadata?.classifierCache ? { classifierCache: metadata.classifierCache } : {}),
          model: decision.model,
          policyHash: decision.policyHash,
        });
      },
    });
    const onApproval = async (
      action: PolicyAction,
      decision: PolicyDecision,
      fingerprint: string,
      signal?: AbortSignal,
    ) => await handlePolicyApproval({
      cwd: options.stateCwd,
      jobId,
      workerToken: options.job.workerToken,
      action,
      decision,
      fingerprint,
      deadline,
      ...(signal ? { signal } : {}),
    });
    if (options.sandboxMode === "lenient" || options.sandboxMode === "adaptive") {
      sandboxRunner = await createSandboxRunner({
        cwd: options.cwd,
        mode: workerMode,
        sandboxMode: options.sandboxMode,
        trustedDomains: options.policySnapshot.adaptivePolicy.trustedDomains,
        ...(options.sandboxMode === "adaptive" ? {
          authorizeNetwork: async (host: string, port?: number) => {
            if (!await publicNetworkTarget(host)) return false;
            const action: PolicyAction = { toolName: "network", input: { host, port }, cwd: options.cwd, domain: host, ...(port ? { port } : {}) };
            let decision = await engine.authorize(action, options.signal);
            if (decision.decision === "require-approval") {
              const resolution = await onApproval(action, decision, actionFingerprint(action), options.signal);
              if (resolution === "approved") decision = await engine.authorize(action, options.signal);
            }
            return decision.decision === "allow";
          },
        } : {}),
      });
    }

    if (kind === "orchestrate") {
      const result = await runOrchestration({
        cwd: options.cwd,
        host: options.host,
        prompt: options.rawPrompt,
        profile: options.profile,
        candidates: options.candidates,
        dependencies: options.dependencies,
        deadline,
        ...(sandboxRunner ? { sandboxRunner } : {}),
        policyEngine: engine,
        onApproval,
        thinkingLevel: options.policySnapshot.rolePolicy.thinkingLevel,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const final = withMetadata(result, options.host, jobId, result.attempts ?? 0);
      final.role = options.policySnapshot.rolePolicy.role as never;
      final.requestedThinkingLevel = options.policySnapshot.rolePolicy.thinkingLevel;
      final.policySummary = { mode: options.sandboxMode, hash: options.policySnapshot.hash, ...metrics };
      if (final.success) {
        final.nextActions = [{
          action: "review-handoff",
          label: "Review the durable analysis before starting implementation",
          requiresConfirmation: true,
          jobId,
        }];
      }
      await finishJob(options.stateCwd, jobId, final);
      return final;
    }

    const prompt = buildWorkerPrompt({
      host: options.host,
      kind,
      prompt: options.rawPrompt,
      profile: options.profile,
    });
    let result = await runWithFallback({
      kind,
      cwd: options.cwd,
      prompt,
      mode: isMutationTask(kind) ? "implement" : "readonly",
      candidates: options.candidates,
      dependencies: options.dependencies,
      deadline,
      ...(sandboxRunner ? { sandboxRunner } : {}),
      policyEngine: engine,
      onApproval,
      thinkingLevel: options.policySnapshot.rolePolicy.thinkingLevel,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let totalRoleAttempts = result.attempts ?? 0;
    orchestrationTrace.push({ role: actualRole, model: result.model, status: result.status });
    if (kind === "implement" && actualRole === "mechanical-executor" && !result.success &&
        !sideEffectsObserved && (await inspectWorktree(options.cwd)).clean && options.policySnapshot.escalationPolicy) {
      let escalationAllowed = options.executionMode === "supervised";
      if (options.executionMode === "background" && options.policySnapshot.approvalMode === "wait") {
        escalationAllowed = await approveRoleEscalation({
          cwd: options.cwd,
          jobId,
          workerToken: options.job.workerToken,
          snapshot: options.policySnapshot,
          deadline,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      }
      if (escalationAllowed) {
        const policy = options.policySnapshot.escalationPolicy;
        const executorCandidates = orderModels(options.dependencies.catalog.available(), {
          priority: policy.models,
        }).slice(0, policy.maxAttempts);
        if (executorCandidates.length > 0) {
          actualRole = "executor";
          result = await runWithFallback({
            kind,
            cwd: options.cwd,
            prompt,
            mode: "implement",
            candidates: executorCandidates,
            dependencies: options.dependencies,
            deadline,
            ...(sandboxRunner ? { sandboxRunner } : {}),
            policyEngine: engine,
            onApproval,
            thinkingLevel: policy.thinkingLevel,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          totalRoleAttempts += result.attempts ?? 0;
          orchestrationTrace.push({ role: actualRole, model: result.model, status: result.status });
        }
      }
    }
    let diff = "";
    result = { ...result, attempts: totalRoleAttempts };
    if (isMutationTask(kind)) {
      await updateJobProgress(options.stateCwd, jobId, options.job.workerToken, "postflight", "Inspecting changes and preserved workspace paths.");
      if (worktreeLease) await assertWorktreeBaseline(options.cwd, worktreeLease.baseline);
      const changes = await captureWorktreeChanges(options.cwd);
      diff = changes.diff;
      const ignored = worktreeLease
        ? (await captureIgnoredPaths(options.cwd)).filter(
            (entry) => !worktreeLease!.baseline.ignoredPaths.includes(entry),
          )
        : [];
      const preserved = changes.assessment.entries
        .filter((entry) => entry.category === "runtime" || entry.category === "ephemeral")
        .map((entry) => entry.path);
      const runtimeSideEffects = [...new Set([...ignored, ...preserved])].sort();
      try {
        await validateChangedPaths(options.cwd, changes.changedFiles);
        result = {
          ...result,
          changedFiles: changes.changedFiles,
          diffStat: changes.diffStat,
          ...(runtimeSideEffects.length > 0 ? { runtimeSideEffects } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          ...result,
          status: "failed",
          success: false,
          output: `${result.output}\n\nSandbox postflight failed: ${message}`.trim(),
          error: message,
          errorCode: error instanceof WorktreeBaselineError ? error.code : "sandbox-postflight-failed",
          changedFiles: changes.changedFiles,
          diffStat: changes.diffStat,
          ...(runtimeSideEffects.length > 0 ? { runtimeSideEffects } : {}),
        };
      }
      if (result.success) {
        let artifact: WorkerResult["artifact"];
        const job = (await getJob(options.stateCwd, jobId)).job;
        const workspace = job.executionWorkspace as ({ worktree: string; branch: string; base: string } & Partial<ScaffoldWorkspace>) | undefined;
        if (workspace) {
          await updateJobProgress(options.stateCwd, jobId, options.job.workerToken, "checkpointing", "Creating a trusted artifact from the isolated worktree.");
          if (kind === "scaffold") {
            const commit = await checkpointScaffold(workspace as ScaffoldWorkspace, jobId);
            artifact = {
              worktree: workspace.worktree,
              branch: workspace.branch,
              commit,
              deliverable: false,
              kind: "scaffold",
              ...(workspace.target ? { target: workspace.target } : {}),
              ...(workspace.targetFingerprint ? { targetFingerprint: workspace.targetFingerprint } : {}),
            };
          } else {
            const commit = await checkpointJobWorktree(options.cwd, jobId);
            artifact = { worktree: workspace.worktree, branch: workspace.branch, ...(commit ? { commit } : {}), deliverable: false, kind: kind === "setup" ? "snapshot" : "implementation" };
          }
        } else if (options.executionMode === "background") {
          if (!workspace) {
            result = { ...result, status: "failed", success: false, error: "Background implementation has no isolated worktree", errorCode: "artifact-missing" };
          }
        }
        if (result.success) {
          await updateJobProgress(options.stateCwd, jobId, options.job.workerToken, "verifying", "Running an independent read-only verification pass.");
          const verification = await runAgentVerifier({
            cwd: options.cwd,
            task: options.rawPrompt,
            diff,
            candidates: options.dependencies.catalog.available(),
            dependencies: options.dependencies,
            deadline,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          result = { ...result, agentVerification: verification, ...(artifact ? { artifact: { ...artifact, deliverable: verification.status === "passed" } } : {}) };
          if (artifact && verification.status === "passed") {
            result.nextActions = [{
              action: "materialize",
              label: "Apply the verified artifact to the target workspace",
              requiresConfirmation: true,
              jobId,
            }];
          }
          if (verification.status !== "passed") {
            result = {
              ...result,
              status: "failed",
              success: false,
              errorCode: verification.status === "refuted" ? "verification-refuted" : "verification-inconclusive",
              error: `Agent verification ${verification.status}`,
              output: `${result.output}\n\nVerifier: ${verification.output}`.trim(),
            };
          }
        }
      }
    }
    const final = withMetadata(result, options.host, jobId, result.attempts ?? 0);
    final.role = actualRole as never;
    final.requestedThinkingLevel = actualRole === "executor" && options.policySnapshot.escalationPolicy
      ? options.policySnapshot.escalationPolicy.thinkingLevel
      : options.policySnapshot.rolePolicy.thinkingLevel;
    final.policySummary = { mode: options.sandboxMode, hash: options.policySnapshot.hash, ...metrics };
    final.orchestrationTrace = orchestrationTrace;
    await finishJob(options.stateCwd, jobId, final, diff);
    return final;
  } finally {
    await sandboxRunner?.dispose().catch(() => {});
    await worktreeLease?.release().catch(() => {});
    clearInterval(heartbeat);
  }
}

async function runAgentVerifier(options: {
  cwd: string;
  task: string;
  diff: string;
  candidates: PiModel[];
  dependencies: RunnerDependencies;
  deadline: number;
  signal?: AbortSignal;
}): Promise<NonNullable<WorkerResult["agentVerification"]>> {
  const verifierPolicy = resolveRolePolicy("verifier", {}, options.candidates.map(modelId));
  const verifierSnapshot = createPolicySnapshot({
    sandboxMode: "strict",
    approvalMode: "deny",
    rolePolicy: verifierPolicy,
    adaptivePolicy: normalizeAdaptivePolicy(undefined),
  });
  const verifierEngine = new PolicyEngine({ snapshot: verifierSnapshot });
  const prompt = [
    "You are an independent verifier. Do not modify files and do not run shell commands.",
    "Check the implementation against the requested task, repository evidence, and supplied diff.",
    "Begin the response with exactly VERIFIED, REFUTED, or INCONCLUSIVE, followed by concise evidence.",
    `TASK:\n${options.task}`,
    `DIFF:\n${options.diff || "(no textual diff)"}`,
  ].join("\n\n");
  const result = await runWithFallback({
    kind: "review",
    cwd: options.cwd,
    prompt,
    mode: "readonly",
    candidates: options.candidates.slice(0, 2),
    dependencies: options.dependencies,
    policyEngine: verifierEngine,
    thinkingLevel: "medium",
    deadline: options.deadline,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const normalized = result.output.trim().toUpperCase();
  const status = !result.success
    ? "failed"
    : normalized.startsWith("VERIFIED")
      ? "passed"
      : normalized.startsWith("REFUTED")
        ? "refuted"
        : "inconclusive";
  return { status, output: result.output, model: result.model };
}

async function handleReadiness(
  args: RunnerArguments,
  cwd: string,
  dependencies?: RunnerDependencies,
): Promise<RunnerOutput> {
  try {
    const state = await loadState(cwd);
    const configuration = await loadModelConfiguration(cwd, state.config.modelPriority);
    const activeDependencies = dependencies ?? defaultDependencies(configuration);
    const available = activeDependencies.catalog.available();
    let report = await inspectReadiness({
      cwd,
      state,
      modelPriority: modelPriority(configuration),
      availableModels: available.map(modelId),
      registryError: activeDependencies.catalog.error?.() ?? null,
    });
    const recoveryJournal = path.join(await resolveStateDir(cwd), "recovery", "configuration.json");
    if (await fs.stat(recoveryJournal).catch(() => undefined)) {
      report = {
        ...report,
        status: "blocked",
        issues: [...report.issues, {
          code: "configuration-recovery-required",
          stage: "recovery",
          severity: "blocking",
          recoverable: true,
          message: "A previous configuration save could not be fully rolled back.",
          preserved: ["recovery journal", "existing credentials and configuration"],
          nextActions: [{ action: "doctor", label: "Inspect configuration recovery" }],
        }],
      };
    }
    if (args.command !== "doctor") return report;
    let smokeTest: { status: "not-run" | "passed" | "failed"; model: string | null; error?: string } = {
      status: "not-run",
      model: report.activeModel,
    };
    if (args.smokeTest && report.activeModel) {
      const model = available.find((candidate) => modelId(candidate) === report.activeModel);
      if (model) {
        try {
          const session = await activeDependencies.createSession({ cwd, mode: "readonly", model, thinkingLevel: "minimal" });
          const result = await executeSession({
            kind: "ask",
            model: report.activeModel,
            prompt: "Reply with exactly READY.",
            session,
            timeoutMs: 15_000,
          });
          if (!result.success) throw new Error(result.error ?? result.output);
          smokeTest = { status: "passed", model: report.activeModel };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          smokeTest = { status: "failed", model: report.activeModel, error: message };
          report = {
            ...report,
            status: "blocked",
            issues: [...report.issues, {
              code: "model-smoke-test-failed",
              stage: "models",
              severity: "blocking",
              recoverable: true,
              message,
              preserved: ["existing configuration"],
              nextActions: [{ action: "configure", label: "Choose or reconnect a model" }],
            }],
          };
        }
      }
    }
    return { ...report, smokeTest };
  } catch (error) {
    if (!(error instanceof StateMigrationConflictError)) throw error;
    const workspace = await assessWorkspace(cwd);
    const state = defaultState();
    return {
      status: "blocked",
      configured: false,
      activeModel: null,
      sandboxMode: state.config.sandboxMode ?? "strict",
      workspace,
      capabilities: { readonly: "blocked", mutation: "blocked", delivery: "blocked" },
      issues: [{
        code: "state-migration-conflict",
        stage: "recovery",
        severity: "blocking",
        recoverable: true,
        message: error.message,
        preserved: [error.legacyDir, error.destinationDir],
        nextActions: [{ action: "doctor", label: "Inspect state locations" }],
      }],
      ...(args.command === "doctor" ? { smokeTest: { status: "not-run" as const, model: null } } : {}),
    };
  }
}

function isMutationTask(kind: TaskKind): boolean {
  return kind === "implement" || kind === "scaffold" || kind === "setup";
}

async function handleInit(
  args: RunnerArguments,
  cwd: string,
  available: PiModel[],
  dependencies: RunnerDependencies,
  modelConfiguration: ModelConfiguration,
): Promise<Extract<RunnerOutput, { configured: boolean }>> {
  if (args.reset) {
    await clearModelConfiguration(cwd);
    const state = await clearConfiguration(cwd);
    return initStatus(state, [], [], args, true);
  }

  const detected = available.map(modelId);
  await setAvailableModels(cwd, detected);
  const selectedPriority = args.modelPriority ?? (args.modelPriorityFile
    ? parseStringArrayJson(await dependencies.readFile(args.modelPriorityFile), "model priority file")
    : undefined);
  if (selectedPriority) {
    const unavailable = selectedPriority.filter((model) => !detected.includes(model));
    if (unavailable.length) throw new Error(`Selected Pi models are not available: ${unavailable.join(", ")}`);
    await saveModelPriority(cwd, modelConfiguration, selectedPriority);
    await setModelPriority(cwd, selectedPriority);
  }
  const profile = args.profile ?? (args.profileFile
    ? parseObjectJson(await dependencies.readFile(args.profileFile), "profile file")
    : undefined);
  if (profile) await saveProfile(cwd, parseProfile(profile));
  const state = await loadState(cwd);
  const currentModelConfiguration = await loadModelConfiguration(cwd, state.config.modelPriority);
  return initStatus(state, modelPriority(currentModelConfiguration), detected, args, false);
}

function parseStringArrayJson(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${label} must contain a JSON string array`);
  }
  return parsed;
}

function parseObjectJson(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function initStatus(
  state: Awaited<ReturnType<typeof loadState>>,
  priority: string[],
  detected: string[],
  args: RunnerArguments,
  reset: boolean,
): Extract<RunnerOutput, { configured: boolean }> {
  const activeModel = priority.find((model) => detected.includes(model)) ?? null;
  return {
    configured: Boolean(activeModel || state.config.profile),
    reconfigure: args.reconfigure,
    reset,
    activeModel,
    modelPriority: priority,
    detectedModels: detected,
    profile: state.config.profile ?? null,
    sandboxMode: state.config.sandboxMode ?? "strict",
    jobs: state.jobs.length,
  };
}

async function runWithFallback(options: {
  kind: TaskKind;
  cwd: string;
  prompt: string;
  mode: "readonly" | "implement";
  candidates: PiModel[];
  dependencies: RunnerDependencies;
  sandboxRunner?: SandboxRunner;
  policyEngine?: PolicyEngine;
  onApproval?: RunnerDependencies["createSession"] extends (options: infer T) => unknown
    ? T extends { onApproval?: infer A } ? A : never
    : never;
  thinkingLevel?: ThinkingLevel;
  deadline: number;
  signal?: AbortSignal;
}): Promise<WorkerResult> {
  let last = failure(options.kind, "No model attempt completed.");
  for (let index = 0; index < options.candidates.length; index += 1) {
    const remainingMs = options.deadline - Date.now();
    if (remainingMs <= 0) return statusResult(options.kind, "timed-out", "Pi job timed out.");
    const model = options.candidates[index]!;
    try {
      const session = await options.dependencies.createSession({
        cwd: options.cwd,
        mode: options.mode,
        model,
        ...(options.sandboxRunner ? { sandboxRunner: options.sandboxRunner } : {}),
        ...(options.policyEngine ? { policyEngine: options.policyEngine } : {}),
        ...(options.onApproval ? { onApproval: options.onApproval } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      });
      const effectiveThinkingLevel = session.thinkingLevel as ThinkingLevel | undefined;
      last = await executeSession({
        kind: options.kind,
        model: modelId(model),
        prompt: options.prompt,
        session,
        timeoutMs: remainingMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      last = {
        ...last,
        ...(options.thinkingLevel ? { requestedThinkingLevel: options.thinkingLevel } : {}),
        ...(effectiveThinkingLevel ? { effectiveThinkingLevel } : {}),
      };
    } catch (error) {
      last = failure(options.kind, error instanceof Error ? error.message : String(error), modelId(model));
    }
    const attempts = index + 1;
    last = { ...last, attempts, fallbackUsed: attempts > 1 };
    if (last.success) return last;
    if (last.status === "cancelled" || last.status === "timed-out") return last;
    if (options.mode === "implement" && !(await inspectWorktree(options.cwd)).clean) return last;
  }
  return last;
}

async function runOrchestration(options: {
  cwd: string;
  host: Host;
  prompt: string;
  profile?: SwarmProfile | undefined;
  candidates: PiModel[];
  dependencies: RunnerDependencies;
  sandboxRunner?: SandboxRunner;
  policyEngine?: PolicyEngine;
  onApproval?: RunnerDependencies["createSession"] extends (options: infer T) => unknown
    ? T extends { onApproval?: infer A } ? A : never
    : never;
  thinkingLevel?: ThinkingLevel;
  deadline: number;
  signal?: AbortSignal;
}): Promise<WorkerResult> {
  const perspectives = [
    "Correctness and failure modes",
    "Architecture, maintainability, and security",
    "Testing, compatibility, and user experience",
  ];
  const results = await Promise.all(
    perspectives.map((perspective) =>
      runWithFallback({
        kind: "orchestrate",
        cwd: options.cwd,
        mode: "readonly",
        candidates: options.candidates,
        dependencies: options.dependencies,
        ...(options.sandboxRunner ? { sandboxRunner: options.sandboxRunner } : {}),
        ...(options.policyEngine ? { policyEngine: options.policyEngine } : {}),
        ...(options.onApproval ? { onApproval: options.onApproval } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        deadline: options.deadline,
        ...(options.signal ? { signal: options.signal } : {}),
        prompt: buildWorkerPrompt({
          host: options.host,
          kind: "orchestrate",
          prompt: options.prompt,
          profile: options.profile,
          perspective,
        }),
      }),
    ),
  );
  const success = results.every((result) => result.success);
  const status = success
    ? "succeeded"
    : results.some((result) => result.status === "cancelled")
      ? "cancelled"
      : results.some((result) => result.status === "timed-out")
        ? "timed-out"
        : "failed";
  return {
    kind: "orchestrate",
    status,
    success,
    model: results.find((result) => result.model)?.model ?? null,
    output: results
      .map((result, index) => `## ${perspectives[index]}\n\n${result.output}`)
      .join("\n\n"),
    changedFiles: [],
    diffStat: "",
    verification: { status: "not-run", commands: [] },
    attempts: results.reduce((total, result) => total + (result.attempts ?? 0), 0),
    fallbackUsed: results.some((result) => result.fallbackUsed),
    error: success ? null : "One or more orchestration workers failed.",
  };
}

async function handlePolicyApproval(options: {
  cwd: string;
  jobId: string;
  workerToken: string;
  action: PolicyAction;
  decision: PolicyDecision;
  fingerprint: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<"approved" | "denied" | "expired"> {
  return withApprovalQueue(options.jobId, async () => {
    if (options.signal?.aborted) throw new Error("Approval wait was cancelled");
    const approval = await requestJobApproval(options.cwd, options.jobId, options.workerToken, {
      actionFingerprint: options.fingerprint,
      toolName: options.action.toolName,
      actionSummary: summarizePolicyAction(options.action),
      decision: options.decision,
      expiresAt: new Date(options.deadline).toISOString(),
    });
    return waitForApprovalResolution(
      options.cwd,
      options.jobId,
      options.workerToken,
      approval.id,
      options.signal,
    );
  });
}

async function withApprovalQueue<T>(jobId: string, run: () => Promise<T>): Promise<T> {
  const previous = approvalQueues.get(jobId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  approvalQueues.set(jobId, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (approvalQueues.get(jobId) === current) approvalQueues.delete(jobId);
  }
}

async function approveRoleEscalation(options: {
  cwd: string;
  jobId: string;
  workerToken: string;
  snapshot: PolicySnapshot;
  deadline: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const action: PolicyAction = {
    toolName: "role-escalation",
    input: { from: "mechanical-executor", to: "executor" },
    cwd: options.cwd,
  };
  const fingerprint = actionFingerprint(action);
  const approval = await requestJobApproval(options.cwd, options.jobId, options.workerToken, {
    actionFingerprint: fingerprint,
    toolName: action.toolName,
    actionSummary: "Escalate mechanical-executor to executor after a side-effect-free failure",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: [],
      reason: "Background role escalation requires supervisor approval.",
      constraints: ["The job remains in its isolated worktree."],
      policyHash: options.snapshot.hash,
    },
    expiresAt: new Date(options.deadline).toISOString(),
  });
  const resolution = await waitForApprovalResolution(
    options.cwd, options.jobId, options.workerToken, approval.id, options.signal,
  );
  if (resolution !== "approved") return false;
  const leases = createJobLeaseProvider(options.cwd, options.jobId);
  const lease = await leases.find(fingerprint, options.snapshot);
  return lease ? leases.consume(lease) : false;
}

function summarizePolicyAction(action: PolicyAction): string {
  if (action.domain) return `${action.toolName} ${action.domain}:${action.port ?? "default"}`;
  if (action.path) return `${action.toolName} ${action.path}`;
  const command = typeof action.input.command === "string" ? action.input.command : JSON.stringify(action.input);
  return `${action.toolName} ${command.slice(0, 1_500)}`;
}

async function publicNetworkTarget(host: string): Promise<boolean> {
  try {
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !privateAddress(address));
  } catch {
    return false;
  }
}

function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  return value === "::1" || value === "0.0.0.0" || value === "169.254.169.254" ||
    value.startsWith("127.") || value.startsWith("10.") || value.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value) || value.startsWith("169.254.") ||
    value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

function parseDelegationSpec(value: string): DelegationSpec {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || typeof parsed.request !== "string" || !parsed.request.trim()) {
    throw new Error("Delegation spec must be a JSON object with a non-empty request");
  }
  const strings = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    request: parsed.request,
    ...(typeof parsed.why === "string" ? { why: parsed.why } : {}),
    ...(strings(parsed.constraints) ? { constraints: strings(parsed.constraints)! } : {}),
    ...(strings(parsed.doneCriteria) ? { doneCriteria: strings(parsed.doneCriteria)! } : {}),
    ...(strings(parsed.relevantPaths) ? { relevantPaths: strings(parsed.relevantPaths)! } : {}),
  };
}

function legacyPolicySnapshot(request: JobRequest, models: string[]): PolicySnapshot {
  const role = request.role ?? defaultRoleForTask(request.kind);
  const rolePolicy = resolveRolePolicy(role, {}, models);
  return createPolicySnapshot({
    sandboxMode: request.sandboxMode ?? "strict",
    approvalMode: "deny",
    rolePolicy,
    adaptivePolicy: normalizeAdaptivePolicy(undefined),
  });
}

function modelInventory(
  catalog: ModelCatalog,
  configuration: ModelConfiguration,
  args: RunnerArguments,
): Extract<RunnerOutput, { models: unknown }> {
  const available = catalog.available();
  const source = args.allModels ? catalog.all?.() ?? available : available;
  const models = args.provider
    ? source.filter((model) => model.provider === args.provider)
    : source;
  const providers: Record<string, number> = {};
  for (const model of models) providers[model.provider] = (providers[model.provider] ?? 0) + 1;
  return {
    models: describeModels(models),
    active: modelPriority(configuration).find((candidate) =>
      available.some((model) => modelId(model) === candidate),
    ) ?? null,
    providers,
  };
}

function parseProfile(value: Record<string, unknown>): SwarmProfile {
  return {
    ...(typeof value.goal === "string" ? { goal: value.goal } : {}),
    ...(Array.isArray(value.dirs) && value.dirs.every((item) => typeof item === "string")
      ? { dirs: value.dirs as string[] }
      : {}),
    ...(Array.isArray(value.tasks) && value.tasks.every((item) => typeof item === "string")
      ? { tasks: value.tasks as string[] }
      : {}),
    configuredAt: typeof value.configuredAt === "string" ? value.configuredAt : new Date().toISOString(),
  };
}

function withMetadata(
  result: WorkerResult,
  host: Host,
  jobId: string,
  attempts: number,
): WorkerResult {
  return {
    ...result,
    host,
    jobId,
    attempts,
    fallbackUsed: result.fallbackUsed ?? attempts > 1,
    error: result.success ? null : result.error ?? result.output,
  };
}

function failure(kind: TaskKind, output: string, model: string | null = null): WorkerResult {
  return statusResult(kind, "failed", output, model);
}

function statusResult(
  kind: TaskKind,
  status: WorkerResult["status"],
  output: string,
  model: string | null = null,
): WorkerResult {
  return {
    kind,
    status,
    success: status === "succeeded",
    model,
    output,
    changedFiles: [],
    diffStat: "",
    verification: { status: "not-run", commands: [] },
    error: output,
  };
}

function defaultTimeoutMs(kind: TaskKind): number {
  return kind === "orchestrate" || isMutationTask(kind) ? 60 * 60_000 : 30 * 60_000;
}
