export type Host = "claude" | "codex";

export type TaskKind =
  | "ask"
  | "review"
  | "plan"
  | "implement"
  | "orchestrate"
  | "scaffold"
  | "setup"
  | "discover";

export type WorkerMode = "readonly" | "implement";

export type ExecutionMode = "supervised" | "background";

export type SandboxMode = "strict" | "adaptive" | "lenient" | "autopilot" | "full-access";

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
  | "environment-engineer"
  | "experimenter";

export type InternalRoleId = "verifier" | "classifier" | "review-coordinator" | "advisor";

export type RoleId = WorkerRoleId | InternalRoleId;

export type DecisionMode = "cost" | "balance" | "power";
export type HostAssistanceMode = "inherit" | "on" | "off";
export type DoctrineId = "first-principles-qds-v1";
export type HostContextClass = "workspace" | "web" | "docs" | "paper" | "connector" | "skill";
export type DataClassification = "public" | "project-internal" | "private" | "secret";
export type HostAssistanceReviewMode = "user-only" | "host-first";
export type HostAutoApprovalScope = "context-only" | "read-only" | "reversible";
/**
 * Granularity for the outward/irreversible boundaries that Autopilot may
 * auto-cross (git writes, Host Action delivery). `each-time` requires a fresh
 * approval per action (once-scoped); `first-then-auto` grants a job-scoped lease
 * after the first approval so subsequent same-family actions run unattended.
 * Missing on legacy snapshots; legacy normalization keeps the stricter `each-time`.
 */
export type OutwardApprovalGranularity = "each-time" | "first-then-auto";
export type Reversibility = "read-only" | "reversible" | "partially-reversible" | "irreversible";

export interface HostAssistancePolicy {
  enabled: boolean;
  mode: HostAssistanceMode;
  contextClasses: HostContextClass[];
  privateConnector: "ask" | "deny";
  maxRequests: number;
  maxFanOut: number;
  /** Missing on legacy snapshots; legacy normalization keeps user-only review. */
  reviewMode?: HostAssistanceReviewMode;
  autoApprovalScope?: HostAutoApprovalScope;
  autoApproveDiscoveryGates?: boolean;
  /**
   * Autopilot outward-boundary controls. `autoGitWrites` lets Autopilot cross the
   * git commit/push/merge hard-deny; `autoDelivery` widens Host Action delivery.
   * Both are governed by `outwardApprovalGranularity`. Missing on legacy snapshots;
   * normalization keeps them off / `each-time`.
   */
  outwardApprovalGranularity?: OutwardApprovalGranularity;
  autoGitWrites?: boolean;
  autoDelivery?: boolean;
}

export interface WorkerAssessment {
  purpose: string;
  blockedBy: string;
  minimumAccess: string[];
  targets: string[];
  sideEffects: string[];
  dataExposure: string[];
  failureModes: string[];
  mitigations: string[];
  reversibility: Reversibility;
  rollback: string;
  verification: string[];
  proposedRisk: RiskLevel;
  fallback: string;
}

export type ActionEffectKind = "read-only" | "reversible-workspace-write" | "network" | "unknown";

/** Trusted runtime evidence; unlike WorkerAssessment, this is not worker-authored advice. */
export interface ActionEffectAssessment {
  version: 1;
  source: "deterministic-tool" | "deterministic-shell";
  effect: ActionEffectKind;
  reversibility: Reversibility;
  capabilities: Capability[];
  reasonCode:
    | "read-only-tool"
    | "read-only-shell"
    | "reversible-file-tool"
    | "network-action"
    | "unproven-shell-effect"
    | "unclassified-action";
}

export interface ClassifierEvidence {
  claimedCapabilities: string[];
  runtimeCapabilities: Capability[];
  normalized: boolean;
}

export interface HostAssistanceRequestBase {
  /** Optional only for persisted legacy requests; new tool calls require it. */
  workerAssessment?: WorkerAssessment;
}

export interface HostAssistanceCorrelation {
  jobId: string;
  generation: number;
  sessionId: string;
  attempt: number;
  perspective?: string;
}

export interface HostContextRequest extends HostAssistanceRequestBase {
  kind: "context";
  contextClass: HostContextClass;
  question: string;
  unknowns: string[];
  acceptanceCriteria: string[];
  freshness?: string;
  versionConstraint?: string;
  dataClassification: DataClassification;
  egressAllowed: boolean;
  budget: number;
}

export interface HumanDecisionRequest extends HostAssistanceRequestBase {
  kind: "decision";
  question: string;
  options: string[];
  context: string;
  dataClassification: DataClassification;
}

export interface ActionRecommendation extends HostAssistanceRequestBase {
  kind: "action-recommendation";
  actionClass: "local-mutation" | "draft" | "remote-write" | "message" | "deploy" | "transaction";
  summary: string;
  target?: string;
  rationale: string;
  expectedEvidence: string[];
  dataClassification: DataClassification;
}

export type HostAssistanceRequest =
  | HostContextRequest
  | HumanDecisionRequest
  | ActionRecommendation;

export interface HostContextClaim {
  claim: string;
  evidenceIds: string[];
  confidence: "low" | "medium" | "high";
}

export interface HostContextCitation {
  id: string;
  title: string;
  url?: string;
  version?: string;
  retrievedAt: string;
}

export interface HostContextBundle {
  kind: "context";
  requestId: string;
  answer: string;
  claims: HostContextClaim[];
  citations: HostContextCitation[];
  conflicts: string[];
  unknowns: string[];
  provenance: string[];
  redactions: string[];
  retrievedAt: string;
  hash: string;
}

export interface HumanDecisionResult {
  kind: "decision";
  requestId: string;
  decision: string;
  rationale?: string;
  decidedAt: string;
  hash: string;
}

export interface HostAssistanceUnavailable {
  kind: "unavailable";
  requestId: string;
  reason: "declined" | "expired" | "disabled" | "quota-exceeded" | "policy-denied" | "cancelled";
  message: string;
  resolvedAt: string;
  hash: string;
}

export interface ActionRecommendationReceipt {
  kind: "action-recommendation";
  requestId: string;
  status: "recorded" | "declined";
  message: string;
  recordedAt: string;
  hash: string;
}

export type HostAssistanceResult =
  | HostContextBundle
  | HumanDecisionResult
  | HostAssistanceUnavailable
  | ActionRecommendationReceipt;
export type HostAssistanceRequestStatus =
  | "pending"
  | "resolved"
  | "declined"
  | "expired"
  | "consumed";

export interface HostAssistanceRequestSummary {
  id: string;
  jobId: string;
  generation: number;
  sessionId: string;
  attempt: number;
  perspective?: string;
  kind: HostAssistanceRequest["kind"];
  contextClass?: HostContextClass;
  safeSummary: string;
  status: HostAssistanceRequestStatus;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  consumedAt?: string;
  notificationId: string;
  responseHash?: string;
  actionFingerprint?: string;
  adjudication?: HostAdjudicationReceipt;
}

export interface HostAssistanceRecord extends HostAssistanceRequestSummary {
  request: HostAssistanceRequest;
  response?: HostAssistanceResult;
}

export interface AssistanceTrace {
  requestId: string;
  correlation: HostAssistanceCorrelation;
  route?: string;
  approvalId?: string;
  resultHash?: string;
  deliveredAt?: string;
  consumedAt?: string;
}

export interface AdvisorPolicy {
  enabled: boolean;
  targets: TaskKind[];
  maxRequests: number;
  maxPerspectives: number;
}

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

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "awaiting-host"
  | "awaiting-decision"
  | WorkerStatus;

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
  stage:
    | "runtime"
    | "state"
    | "connections"
    | "models"
    | "roles"
    | "execution-safety"
    | "workspace"
    | "recovery";
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
  configurationStorage?: import("../state/state.js").ConfigurationStorage;
  workspace: WorkspaceAssessment;
  capabilities: {
    readonly: ReadinessStatus;
    mutation: ReadinessStatus;
    delivery: ReadinessStatus;
  };
  issues: SetupIssue[];
}

export type JobPhase =
  | "queued"
  | "preflight"
  | "delegating"
  | "postflight"
  | "verifying"
  | "checkpointing";

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

export type DiscoveryStage = "research" | "experiment" | "convergence";
export type ExperimentConclusion = "supported" | "refuted" | "inconclusive";

export interface EvidencePlan {
  unknowns: string[];
  sources: Array<"workspace" | "web" | "docs" | "paper" | "connector" | "skill">;
  acceptanceCriteria: string[];
  budget: number;
}

export interface EvidencePack {
  claims: Array<{ claim: string; evidenceIds: string[]; confidence: "low" | "medium" | "high" }>;
  citations: HostContextCitation[];
  conflicts: string[];
  unknowns: string[];
}

export interface ExperimentSpec {
  hypothesis: string;
  baseline: string;
  dependencies: string[];
  fixture: string;
  seedOrDataHash: string;
  setupCommand: string;
  runCommand: string;
  testCommand: string;
  verifyCommand: string;
  cleanupCommand: string;
  metrics: string[];
  tolerance: string;
  cleanReplayCommand: string;
}

export interface ExperimentExecutionEvidence {
  commandsRun: string[];
  testsRun: string[];
  evidence: string[];
  cleanReplayPassed: boolean;
}

export interface FeatureDefinition {
  summary: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
}

export interface DecisionLedgerEntry {
  decision: string;
  rationale: string;
  evidenceIds: string[];
}

export type DiscoveryStructuredArtifact =
  | { stage: "research"; evidencePlan: EvidencePlan; evidencePack: EvidencePack }
  | {
      stage: "experiment";
      experimentSpec: ExperimentSpec;
      execution: ExperimentExecutionEvidence;
      conclusion: ExperimentConclusion;
    }
  | {
      stage: "convergence";
      featureDefinition: FeatureDefinition;
      decisionLedger: DecisionLedgerEntry[];
    };

export interface DiscoveryStageReport {
  stage: DiscoveryStage;
  status: "passed" | "failed" | "inconclusive";
  evidence: string[];
  output: string;
  verification: string[];
  structuredArtifact?: DiscoveryStructuredArtifact;
  childJobId?: string;
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

export interface PolicySnapshotV3 extends Omit<PolicySnapshotV2, "version"> {
  version: 3;
  parentPolicyHash?: string;
  decisionMode: DecisionMode;
  hostAssistance: HostAssistancePolicy;
  advisor: AdvisorPolicy;
  doctrine?: DoctrineId;
  contextBudget: number;
}

export type PolicySnapshot = LegacyPolicySnapshot | PolicySnapshotV2 | PolicySnapshotV3;

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
  classifierEvidence?: ClassifierEvidence;
}

export interface ApprovalRequest {
  id: string;
  jobId: string;
  generation: number;
  actionFingerprint: string;
  scopeHash?: string;
  toolName: string;
  actionSummary: string;
  trustedReadOnly?: boolean;
  effectAssessment?: ActionEffectAssessment;
  decision: PolicyDecision;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  scope?: "once" | "job";
  notificationId: string;
  notification?: NotificationStatus;
  workerAssessment?: WorkerAssessment;
  adjudication?: HostAdjudicationReceipt;
}

export interface HostAdjudicationReceipt {
  principal: "host-model" | "user";
  host: Host;
  model?: string;
  decision: "allow" | "ask-user" | "hard-deny";
  assessedRisk: RiskLevel;
  rationale: string;
  constraints: string[];
  intentMatch: boolean;
  actionFingerprint: string;
  policyHash: string;
  autoResolved: boolean;
  decidedAt: string;
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
  principal?: "worker" | "host-broker" | "host-model" | "user";
  adjudication?: HostAdjudicationReceipt;
  actionFamily?: {
    actionClass: ActionRecommendation["actionClass"];
    target?: string;
    scopeKey: string;
    maxUses: number;
    used: number;
    maxCost?: number;
  };
}

export interface HostActionPolicy {
  enabled: boolean;
  allowedActionClasses: Array<ActionRecommendation["actionClass"]>;
  remoteActionsEnabled: boolean;
  maxUses: number;
  maxCost: number;
  ttlMs: number;
}

export interface HostActionReceipt {
  parentJobId: string;
  recommendationId: string;
  childJobId: string;
  actionClass: ActionRecommendation["actionClass"];
  target?: string;
  principal: "host-broker";
  outcome: "succeeded" | "failed" | "unknown";
  artifactHash?: string;
  createdAt: string;
}

export interface JobNotification {
  id: string;
  kind: "approval" | "host-assistance" | "human-decision" | "terminal";
  status: NotificationStatus;
  createdAt: string;
  acknowledgedAt?: string;
  approvalId?: string;
  hostRequestId?: string;
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
  projectGoal?: string;
  scaffoldSpec?: ScaffoldSpec;
  adoptExisting?: boolean;
  decisionMode?: DecisionMode;
  hostAssistance?: HostAssistanceMode;
  hostContextFile?: string;
  discoveryFrom?: string;
  reviewProfile?: "standard" | "lean";
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
  orchestrationTrace?: Array<{
    role: RoleId;
    model: string | null;
    status: string;
    round?: "candidate" | "validation";
    perspective?: string;
  }>;
  review?: {
    profile: "lean";
    strategy: "validated-panel";
    outcome: "passed" | "partial" | "inconclusive";
    rounds: {
      candidates: { succeeded: number; failed: number; submitted: number; selected: number };
      validation: { supported: number; refuted: number; inconclusive: number };
    };
    findings: Array<{
      tag: "delete" | "reuse" | "stdlib" | "native" | "yagni" | "clarify" | "shrink";
      path: string;
      startLine: number;
      endLine: number;
      summary: string;
      replacement: string;
      behaviorEvidence: string;
      verification: string;
      supportingReviewers: number;
    }>;
    truncatedCandidates: number;
  };
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
    kind?: "implementation" | "scaffold" | "snapshot" | "experiment" | "host-action";
    target?: string;
    targetFingerprint?: string;
    materializedAt?: string;
  };
  discovery?: {
    stages: DiscoveryStageReport[];
    experimentConclusion?: ExperimentConclusion;
  };
  hostAction?: HostActionReceipt;
  hostAdjudications?: HostAdjudicationSummary[];
  telemetry?: {
    attempts: WorkerTelemetryAttempt[];
  };
}

export interface WorkerTelemetryUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface WorkerTelemetryAttempt {
  attempt: number;
  /** Number of Pi 0.81+ automatic provider retries during this attempt. */
  automaticRetries?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: WorkerStatus;
  provider: string;
  model: string;
  role?: RoleId;
  usage?: WorkerTelemetryUsage;
}

export interface HostAdjudicationSummary {
  source: "approval" | "host-assistance";
  requestId: string;
  principal: HostAdjudicationReceipt["principal"];
  host: Host;
  model?: string;
  decision: HostAdjudicationReceipt["decision"];
  assessedRisk: RiskLevel;
  rationale: string;
  constraints: string[];
  actionFingerprint: string;
  policyHash: string;
  autoResolved: boolean;
  outcome: string;
  decidedAt: string;
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
  requestVersion?: 1 | 2 | 3 | 4 | 5;
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
  reviewProfile?: "standard" | "lean";
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
  classifierEvidence?: ClassifierEvidence;
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
  trustedReadOnly?: boolean;
  effectAssessment?: ActionEffectAssessment;
  decision: PolicyDecision;
  status: ApprovalRequest["status"];
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  scope?: "once" | "job";
  workerAssessment?: WorkerAssessment;
  adjudication?: HostAdjudicationReceipt;
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
  principal?: CapabilityLease["principal"];
  adjudication?: HostAdjudicationReceipt;
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
  agentVerification?: {
    status: NonNullable<WorkerResult["agentVerification"]>["status"];
    output: string;
    model: string | null;
  };
  artifact?: WorkerResult["artifact"];
  hostAdjudications?: HostAdjudicationSummary[];
  telemetry?: WorkerResult["telemetry"];
  review?: WorkerResult["review"];
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
  hostAssistance: HostAssistanceRecord[];
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
