export type Host = "claude" | "codex";

export type TaskKind = "ask" | "review" | "plan" | "implement" | "orchestrate" | "scaffold" | "setup";

export type WorkerMode = "readonly" | "implement";

export type ExecutionMode = "supervised" | "background";

export type SandboxMode = "strict" | "adaptive" | "lenient";

export type ApprovalMode = "deny" | "wait";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type WorkerRoleId =
  | "scout"
  | "planner"
  | "reviewer"
  | "analyst"
  | "mechanical-executor"
  | "executor"
  | "security-executor"
  | "project-architect"
  | "scaffolder"
  | "environment-engineer";

export type InternalRoleId = "verifier" | "classifier";

export type RoleId = WorkerRoleId | InternalRoleId;

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PolicyDecisionKind = "allow" | "deny" | "require-approval";

export type Capability =
  | "filesystem.read-workspace"
  | "filesystem.write-workspace"
  | "filesystem.write-temp"
  | "git.read"
  | "shell.execute"
  | "network.connect";

export type WorkerStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "orphaned"
  | "not-implemented";

export type JobStatus = "queued" | "running" | "awaiting-approval" | WorkerStatus;

export type NotificationStatus = "pending" | "acknowledged";

export type ReadinessStatus = "ready" | "degraded" | "blocked";

export type WorkspaceDisposition =
  | "clean"
  | "safe-dirty"
  | "user-dirty"
  | "unsafe"
  | "git-unborn"
  | "non-git-empty"
  | "non-git-existing";

export type WorkspaceStrategy = "auto" | "isolated-head" | "isolated-snapshot";

export interface SetupIssue {
  code: string;
  stage: "runtime" | "state" | "connections" | "models" | "roles" | "execution-safety" | "workspace" | "recovery";
  severity: "warning" | "blocking";
  recoverable: boolean;
  message: string;
  preserved: string[];
  nextActions: Array<{ action: string; label: string }>;
}

export interface WorkspaceEntryAssessment {
  path: string;
  status: string;
  category: "runtime" | "ephemeral" | "user" | "unsafe";
  reason: string;
}

export interface WorkspaceAssessment {
  root: string;
  git: boolean;
  head: string | null;
  disposition: WorkspaceDisposition;
  entries: WorkspaceEntryAssessment[];
  fingerprint: string;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  configured: boolean;
  activeModel: string | null;
  sandboxMode: SandboxMode;
  workspace: WorkspaceAssessment;
  capabilities: {
    readonly: ReadinessStatus;
    mutation: ReadinessStatus;
    delivery: ReadinessStatus;
  };
  issues: SetupIssue[];
}

export type JobPhase = "queued" | "preflight" | "delegating" | "postflight" | "verifying" | "checkpointing";

export interface WorkerNextAction {
  action: string;
  label: string;
  requiresConfirmation: boolean;
  jobId?: string;
}

export interface ScaffoldSpec {
  version: 1;
  request: string;
  projectName: string;
  targetMode: "empty" | "adopt";
  runtime?: string;
  packageManager?: string;
  structure?: string[];
  dependencies?: string[];
  verificationCommands?: string[];
  allowLifecycleScripts?: boolean;
  doneCriteria?: string[];
}

export interface DelegationSpec {
  request: string;
  why?: string;
  constraints?: string[];
  doneCriteria?: string[];
  relevantPaths?: string[];
}

export interface RolePolicy {
  role: RoleId;
  taskKinds: TaskKind[];
  executionModes: ExecutionMode[];
  capabilities: Capability[];
  thinkingLevel: ThinkingLevel;
  models: string[];
  maxAttempts: number;
  verification: "none" | "agent";
}

export interface PolicyRule {
  id: string;
  effect: "deny" | "ask" | "allow";
  capability: Capability;
  roles?: RoleId[];
  taskKinds?: TaskKind[];
  pathPrefix?: string;
  domain?: string;
}

export interface AdaptivePolicyConfig {
  classifierModels: string[];
  classifierThinkingLevel: ThinkingLevel;
  approvalPolicy: ApprovalMode;
  trustedDomains: string[];
  rules: PolicyRule[];
  diagnostics: boolean;
}

export interface BackgroundRolePolicy {
  mechanicalExecutor: boolean;
}

export interface LegacyPolicySnapshot {
  version: 1;
  hash: string;
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  rolePolicy: RolePolicy;
  escalationPolicy?: RolePolicy;
  adaptivePolicy: AdaptivePolicyConfig;
  createdAt: string;
}

export interface PolicySnapshotV2 {
  version: 2;
  hash: string;
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  rolePolicy: RolePolicy;
  escalationPolicy?: RolePolicy;
  adaptivePolicy: AdaptivePolicyConfig;
  effectiveProjectPolicy: EffectiveProjectPolicy;
  scopeHash: string;
  createdAt: string;
}

export type PolicySnapshot = LegacyPolicySnapshot | PolicySnapshotV2;

export type ProjectOperation = "read" | "search" | "write" | "shell";

export interface EffectiveProjectPolicy {
  version: 1;
  workspaceRoot: ".";
  allowedTaskKinds: TaskKind[];
  roots: Record<ProjectOperation, string[]>;
  repositoryDenyRules: PolicyRule[];
  scopeHash: string;
  hash: string;
}

export interface BoundProjectPolicy {
  effective: EffectiveProjectPolicy;
  executionRoot: string;
  roots: Record<ProjectOperation, string[]>;
}

export interface ProjectPolicyRejection {
  event: "policy-rejected";
  errorCode:
    | "task-kind-not-allowed"
    | "project-scope-invalid"
    | "project-scope-violation"
    | "policy-snapshot-invalid";
  stage: "admission" | "preflight" | "postflight" | "materialization";
  recoverable: boolean;
  message: string;
  preserved: string[];
  nextActions: Array<{ action: string; label: string }>;
  policyHash?: string;
  scopeHash?: string;
  violatingPaths?: string[];
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  risk: RiskLevel;
  capabilities: Capability[];
  reason: string;
  constraints: string[];
  policyHash: string;
  scopeHash?: string;
  model?: string;
}

export interface ApprovalRequest {
  id: string;
  jobId: string;
  generation: number;
  actionFingerprint: string;
  scopeHash?: string;
  toolName: string;
  actionSummary: string;
  decision: PolicyDecision;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  scope?: "once" | "job";
  notificationId: string;
  notification?: NotificationStatus;
}

export interface CapabilityLease {
  id: string;
  jobId: string;
  generation: number;
  policyHash: string;
  scopeHash?: string;
  role: RoleId;
  actionFingerprint: string;
  scope: "once" | "job";
  capabilities: Capability[];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface JobNotification {
  id: string;
  kind: "approval" | "terminal";
  status: NotificationStatus;
  createdAt: string;
  acknowledgedAt?: string;
  approvalId?: string;
}

export interface WorkerRequest {
  host: Host;
  kind: TaskKind;
  cwd: string;
  prompt: string;
  mode: WorkerMode;
  executionMode: ExecutionMode;
  sandboxMode: SandboxMode;
  timeoutMs: number;
  model?: string;
  role?: WorkerRoleId;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  delegationSpec?: DelegationSpec;
  policySnapshot?: PolicySnapshot;
  workspaceStrategy?: WorkspaceStrategy;
  target?: string;
  scaffoldSpec?: ScaffoldSpec;
  adoptExisting?: boolean;
}

export interface WorkerResult {
  kind: TaskKind;
  status: WorkerStatus;
  success: boolean;
  output: string;
  model: string | null;
  changedFiles: string[];
  diffStat: string;
  runtimeSideEffects?: string[];
  nextActions?: WorkerNextAction[];
  verification: {
    status: "not-run" | "passed" | "failed";
    commands: string[];
  };
  host?: Host;
  jobId?: string;
  attempts?: number;
  fallbackUsed?: boolean;
  error?: string | null;
  errorCode?: string | null;
  role?: WorkerRoleId;
  requestedThinkingLevel?: ThinkingLevel;
  effectiveThinkingLevel?: ThinkingLevel;
  orchestrationTrace?: Array<{ role: RoleId; model: string | null; status: string }>;
  policySummary?: {
    mode: SandboxMode;
    hash: string;
    allowed: number;
    denied: number;
    approvals: number;
  };
  agentVerification?: {
    status: "not-run" | "passed" | "refuted" | "inconclusive" | "failed";
    output: string;
    model: string | null;
  };
  artifact?: {
    worktree?: string;
    branch?: string;
    commit?: string;
    deliverable: boolean;
    kind?: "implementation" | "scaffold" | "snapshot";
    target?: string;
    targetFingerprint?: string;
    materializedAt?: string;
  };
}

export interface AuditJobSummary {
  id: string;
  status: string;
  host?: Host;
  kind?: TaskKind;
  executionMode?: ExecutionMode;
  sandboxMode?: SandboxMode;
  timeoutMs?: number;
  model?: string;
  role?: WorkerRoleId;
  generation?: number;
  phase?: JobPhase;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  lastProgressAt?: string;
}

export interface AuditRequestSummary {
  requestVersion?: 1 | 2 | 3;
  id: string;
  host: Host;
  kind: TaskKind;
  executionMode: ExecutionMode;
  sandboxMode?: SandboxMode;
  timeoutMs: number;
  model?: string;
  role?: WorkerRoleId;
  thinkingLevel?: ThinkingLevel;
  approvalMode?: ApprovalMode;
  workspaceStrategy?: WorkspaceStrategy;
  target?: string;
  adoptExisting?: boolean;
  providerSnapshotHash?: string;
  createdAt: string;
}

export interface AuditPolicyEvent {
  timestamp?: string;
  tool?: string;
  fingerprint?: string;
  decision?: PolicyDecisionKind;
  risk?: RiskLevel;
  reason?: string;
  action?: Record<string, unknown>;
  classifierCache?: "miss" | "hit" | "coalesced";
  model?: string;
  policyHash?: string;
}

export interface AuditApproval {
  id: string;
  jobId: string;
  generation: number;
  actionFingerprint: string;
  scopeHash?: string;
  toolName: string;
  actionSummary: string;
  decision: PolicyDecision;
  status: ApprovalRequest["status"];
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  scope?: "once" | "job";
}

export interface AuditLease {
  id: string;
  jobId: string;
  generation: number;
  policyHash: string;
  scopeHash?: string;
  role: RoleId;
  actionFingerprint: string;
  scope: "once" | "job";
  capabilities: Capability[];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface AuditResultSummary {
  kind: TaskKind;
  status: WorkerStatus;
  success: boolean;
  model: string | null;
  changedFiles: string[];
  diffStat: string;
  runtimeSideEffects?: string[];
  verification: WorkerResult["verification"];
  host?: Host;
  jobId?: string;
  attempts?: number;
  fallbackUsed?: boolean;
  error?: string | null;
  errorCode?: string | null;
  role?: WorkerRoleId;
  requestedThinkingLevel?: ThinkingLevel;
  effectiveThinkingLevel?: ThinkingLevel;
  orchestrationTrace?: WorkerResult["orchestrationTrace"];
  policySummary?: WorkerResult["policySummary"];
  agentVerification?: { status: NonNullable<WorkerResult["agentVerification"]>["status"]; output: string; model: string | null };
  artifact?: WorkerResult["artifact"];
}

export interface JobAuditExportV1 {
  schema: "swarm-pi-code-plugin/job-audit";
  version: 1;
  exportedAt: string;
  job: AuditJobSummary;
  request: AuditRequestSummary;
  policy: {
    snapshot: PolicySnapshot | null;
    events: AuditPolicyEvent[];
  };
  approvals: AuditApproval[];
  leases: AuditLease[];
  result: AuditResultSummary;
  changes: { patch: string | null; sourceSha256: string | null };
  integrity: {
    policySnapshot: { hash: string; verified: true } | null;
    providerSnapshot: { hash: string; verified: true } | null;
    sourceSha256: {
      request: string;
      result: string;
      prompt: string;
      policyEvents: string | null;
    };
  };
  redactions: { secrets: number; paths: number };
}

export interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  name: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  ready: boolean;
  modelCount: number;
  availableModelCount: number;
  auth: {
    source: string | null;
    label: string | null;
  };
  selection: "primary" | "fallback" | null;
  custom: boolean;
}
