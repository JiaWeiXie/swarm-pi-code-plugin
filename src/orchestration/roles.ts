import { createHash } from "node:crypto";

import type {
  AdaptivePolicyConfig,
  ApprovalMode,
  BackgroundRolePolicy,
  Capability,
  EffectiveProjectPolicy,
  ExecutionMode,
  LegacyPolicySnapshot,
  PolicySnapshot,
  PolicySnapshotV2,
  PolicySnapshotV3,
  AdvisorPolicy,
  DecisionMode,
  HostAssistancePolicy,
  RoleId,
  RolePolicy,
  SandboxMode,
  TaskKind,
  ThinkingLevel,
  WorkerRoleId,
} from "../core/contracts.js";
import { assertEffectiveProjectPolicyValid, ProjectPolicyError } from "../policy/project-policy.js";

export type RolePolicyOverrides = Partial<
  Record<
    WorkerRoleId,
    {
      models?: string[];
      thinkingLevel?: ThinkingLevel;
      maxAttempts?: number;
    }
  >
>;

export const MAX_HOST_ASSISTANCE_REQUESTS = 6;
export const MAX_HOST_ASSISTANCE_FAN_OUT = 3;
export const MAX_ADVISOR_REQUESTS = 3;
export const MAX_ADVISOR_PERSPECTIVES = 4;

const READONLY: Capability[] = [
  "filesystem.read-workspace",
  "filesystem.write-temp",
  "git.read",
  "shell.execute",
  "network.connect",
];
const IMPLEMENT: Capability[] = [...READONLY, "filesystem.write-workspace"];

const DEFAULT_ROLES: Record<RoleId, RolePolicy> = {
  scout: role("scout", ["ask"], ["supervised", "background"], READONLY, "low", "none"),
  planner: role("planner", ["plan"], ["supervised", "background"], READONLY, "xhigh", "none"),
  reviewer: role("reviewer", ["review"], ["supervised", "background"], READONLY, "high", "none"),
  analyst: role(
    "analyst",
    ["orchestrate", "discover"],
    ["supervised", "background"],
    READONLY,
    "medium",
    "none",
  ),
  "mechanical-executor": role(
    "mechanical-executor",
    ["implement"],
    ["supervised"],
    IMPLEMENT,
    "low",
    "agent",
  ),
  executor: role("executor", ["implement"], ["supervised"], IMPLEMENT, "high", "agent"),
  "security-executor": role(
    "security-executor",
    ["ask", "review", "implement"],
    ["supervised"],
    IMPLEMENT,
    "high",
    "agent",
  ),
  "project-architect": role(
    "project-architect",
    ["plan"],
    ["supervised", "background"],
    READONLY,
    "xhigh",
    "none",
  ),
  scaffolder: role(
    "scaffolder",
    ["scaffold"],
    ["supervised", "background"],
    IMPLEMENT,
    "high",
    "agent",
  ),
  "environment-engineer": role(
    "environment-engineer",
    ["setup"],
    ["supervised"],
    IMPLEMENT,
    "high",
    "agent",
  ),
  experimenter: role("experimenter", ["discover"], ["supervised"], IMPLEMENT, "high", "agent"),
  verifier: role("verifier", ["review"], ["supervised"], READONLY, "medium", "none"),
  classifier: role("classifier", ["ask"], ["supervised"], [], "medium", "none"),
  "review-coordinator": role(
    "review-coordinator",
    ["review", "discover", "plan", "orchestrate"],
    ["supervised"],
    READONLY,
    "high",
    "none",
  ),
  advisor: role(
    "advisor",
    ["review", "discover", "plan", "orchestrate"],
    ["supervised"],
    READONLY,
    "high",
    "none",
  ),
};

export const DEFAULT_ADAPTIVE_POLICY: AdaptivePolicyConfig = {
  classifierModels: [],
  classifierThinkingLevel: "medium",
  approvalPolicy: "deny",
  trustedDomains: [],
  rules: [],
  diagnostics: false,
};

export const DEFAULT_BACKGROUND_ROLE_POLICY: BackgroundRolePolicy = {
  mechanicalExecutor: false,
};

export function defaultRoleForTask(kind: TaskKind): WorkerRoleId {
  switch (kind) {
    case "ask":
      return "scout";
    case "plan":
      return "planner";
    case "review":
      return "reviewer";
    case "orchestrate":
      return "analyst";
    case "implement":
      return "executor";
    case "scaffold":
      return "scaffolder";
    case "setup":
      return "environment-engineer";
    case "discover":
      return "analyst";
  }
}

export function resolveRolePolicy(
  roleId: RoleId,
  overrides: RolePolicyOverrides = {},
  globalModels: string[] = [],
  background: BackgroundRolePolicy = DEFAULT_BACKGROUND_ROLE_POLICY,
): RolePolicy {
  const base = DEFAULT_ROLES[roleId];
  const override = isWorkerRole(roleId) ? overrides[roleId] : undefined;
  const executionModes: ExecutionMode[] =
    roleId === "mechanical-executor" && background.mechanicalExecutor
      ? unique<ExecutionMode>([...base.executionModes, "background"])
      : [...base.executionModes];
  return {
    ...base,
    role: roleId,
    taskKinds: [...base.taskKinds],
    executionModes,
    capabilities: [...base.capabilities],
    thinkingLevel:
      override?.thinkingLevel && isThinkingLevel(override.thinkingLevel)
        ? override.thinkingLevel
        : base.thinkingLevel,
    models: [...(override?.models?.length ? override.models : globalModels)],
    maxAttempts: clampAttempts(override?.maxAttempts ?? base.maxAttempts),
  };
}

export function assertRoleCompatible(
  policy: RolePolicy,
  kind: TaskKind,
  executionMode: ExecutionMode,
): void {
  if (!policy.taskKinds.includes(kind)) throw new Error(`Role ${policy.role} cannot run ${kind}`);
  if (!policy.executionModes.includes(executionMode)) {
    throw new Error(`Role ${policy.role} does not support ${executionMode} execution`);
  }
}

export function createPolicySnapshot(input: {
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  rolePolicy: RolePolicy;
  escalationPolicy?: RolePolicy;
  adaptivePolicy?: Partial<AdaptivePolicyConfig>;
}): LegacyPolicySnapshot;
export function createPolicySnapshot(input: {
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  rolePolicy: RolePolicy;
  escalationPolicy?: RolePolicy;
  adaptivePolicy?: Partial<AdaptivePolicyConfig>;
  effectiveProjectPolicy: EffectiveProjectPolicy;
}): PolicySnapshotV2;
export function createPolicySnapshot(input: {
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  rolePolicy: RolePolicy;
  escalationPolicy?: RolePolicy;
  adaptivePolicy?: Partial<AdaptivePolicyConfig>;
  effectiveProjectPolicy: EffectiveProjectPolicy;
  decisionMode: DecisionMode;
  parentPolicyHash?: string;
  hostAssistance?: HostAssistancePolicy;
  advisor?: AdvisorPolicy;
  doctrine?: "first-principles-qds-v1";
  contextBudget?: number;
}): PolicySnapshotV3;
export function createPolicySnapshot(input: {
  sandboxMode: SandboxMode;
  approvalMode: ApprovalMode;
  rolePolicy: RolePolicy;
  escalationPolicy?: RolePolicy;
  adaptivePolicy?: Partial<AdaptivePolicyConfig>;
  effectiveProjectPolicy?: EffectiveProjectPolicy;
  decisionMode?: DecisionMode;
  parentPolicyHash?: string;
  hostAssistance?: HostAssistancePolicy;
  advisor?: AdvisorPolicy;
  doctrine?: "first-principles-qds-v1";
  contextBudget?: number;
}): PolicySnapshot {
  const adaptivePolicy = normalizeAdaptivePolicy(input.adaptivePolicy);
  const createdAt = new Date().toISOString();
  if (input.effectiveProjectPolicy) {
    if (input.decisionMode) {
      const canonical = {
        version: 3 as const,
        sandboxMode: input.sandboxMode,
        approvalMode: input.approvalMode,
        rolePolicy: input.rolePolicy,
        ...(input.escalationPolicy ? { escalationPolicy: input.escalationPolicy } : {}),
        adaptivePolicy,
        effectiveProjectPolicy: input.effectiveProjectPolicy,
        scopeHash: input.effectiveProjectPolicy.scopeHash,
        ...(input.parentPolicyHash ? { parentPolicyHash: input.parentPolicyHash } : {}),
        decisionMode: input.decisionMode,
        hostAssistance: input.hostAssistance ?? defaultHostAssistancePolicy(),
        advisor: input.advisor ?? defaultAdvisorPolicy(),
        ...(input.doctrine ? { doctrine: input.doctrine } : {}),
        contextBudget: input.contextBudget ?? 4,
      };
      return { ...canonical, hash: policySnapshotHash(canonical), createdAt };
    }
    const canonical = {
      version: 2 as const,
      sandboxMode: input.sandboxMode,
      approvalMode: input.approvalMode,
      rolePolicy: input.rolePolicy,
      ...(input.escalationPolicy ? { escalationPolicy: input.escalationPolicy } : {}),
      adaptivePolicy,
      effectiveProjectPolicy: input.effectiveProjectPolicy,
      scopeHash: input.effectiveProjectPolicy.scopeHash,
    };
    return {
      ...canonical,
      hash: policySnapshotHash(canonical),
      createdAt,
    };
  }
  const canonical = {
    version: 1 as const,
    sandboxMode: input.sandboxMode,
    approvalMode: input.approvalMode,
    rolePolicy: input.rolePolicy,
    ...(input.escalationPolicy ? { escalationPolicy: input.escalationPolicy } : {}),
    adaptivePolicy,
  };
  return {
    ...canonical,
    hash: policySnapshotHash(canonical),
    createdAt,
  };
}

export function policySnapshotHash(
  snapshot: Pick<
    PolicySnapshot,
    | "version"
    | "sandboxMode"
    | "approvalMode"
    | "rolePolicy"
    | "escalationPolicy"
    | "adaptivePolicy"
  >,
): string {
  const canonical = {
    version: snapshot.version,
    sandboxMode: snapshot.sandboxMode,
    approvalMode: snapshot.approvalMode,
    rolePolicy: snapshot.rolePolicy,
    ...(snapshot.escalationPolicy ? { escalationPolicy: snapshot.escalationPolicy } : {}),
    adaptivePolicy: snapshot.adaptivePolicy,
    ...("effectiveProjectPolicy" in snapshot
      ? { effectiveProjectPolicy: snapshot.effectiveProjectPolicy }
      : {}),
    ...("scopeHash" in snapshot ? { scopeHash: snapshot.scopeHash } : {}),
    ...("parentPolicyHash" in snapshot && snapshot.parentPolicyHash
      ? { parentPolicyHash: snapshot.parentPolicyHash }
      : {}),
    ...("decisionMode" in snapshot ? { decisionMode: snapshot.decisionMode } : {}),
    ...("hostAssistance" in snapshot ? { hostAssistance: snapshot.hostAssistance } : {}),
    ...("advisor" in snapshot ? { advisor: snapshot.advisor } : {}),
    ...("doctrine" in snapshot ? { doctrine: snapshot.doctrine } : {}),
    ...("contextBudget" in snapshot ? { contextBudget: snapshot.contextBudget } : {}),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assertPolicySnapshotValid(
  snapshot: PolicySnapshot,
): asserts snapshot is PolicySnapshotV2 | PolicySnapshotV3 {
  if (!isRecord(snapshot) || (snapshot.version !== 2 && snapshot.version !== 3))
    throw invalidSnapshot("Policy snapshot must use version 2 or 3");
  const candidate = snapshot as unknown as PolicySnapshotV2 | PolicySnapshotV3;
  if (!isEffectiveProjectPolicyShape(candidate.effectiveProjectPolicy)) {
    throw invalidSnapshot("Policy snapshot effective project policy is malformed");
  }
  try {
    assertEffectiveProjectPolicyValid(candidate.effectiveProjectPolicy);
  } catch (error) {
    if (error instanceof ProjectPolicyError)
      throw invalidSnapshot("Policy snapshot effective project policy hash is invalid");
    throw invalidSnapshot("Policy snapshot effective project policy is invalid");
  }
  if (typeof candidate.hash !== "string" || typeof candidate.scopeHash !== "string") {
    throw invalidSnapshot("Policy snapshot hashes are malformed");
  }
  if (candidate.scopeHash !== candidate.effectiveProjectPolicy.scopeHash) {
    throw invalidSnapshot("Policy snapshot scope hash does not match its effective project policy");
  }
  if (candidate.hash !== policySnapshotHash(candidate))
    throw invalidSnapshot("Policy snapshot hash is invalid");
  if (
    candidate.version === 3 &&
    (!isDecisionMode(candidate.decisionMode) ||
      !isHostAssistancePolicy(candidate.hostAssistance) ||
      !isAdvisorPolicy(candidate.advisor) ||
      (candidate.parentPolicyHash !== undefined &&
        !/^[a-f0-9]{64}$/.test(candidate.parentPolicyHash)) ||
      !Number.isInteger(candidate.contextBudget) ||
      candidate.contextBudget < 0 ||
      candidate.contextBudget > 64 ||
      (candidate.doctrine !== undefined && candidate.doctrine !== "first-principles-qds-v1"))
  ) {
    throw invalidSnapshot("Policy snapshot v3 controls are malformed");
  }
}

export function defaultHostAssistancePolicy(): HostAssistancePolicy {
  return {
    enabled: true,
    mode: "on",
    contextClasses: ["workspace", "web", "docs", "paper", "connector", "skill"],
    privateConnector: "ask",
    maxRequests: 4,
    maxFanOut: 2,
    reviewMode: "host-first",
    autoApprovalScope: "reversible",
    autoApproveDiscoveryGates: true,
  };
}

export function defaultAdvisorPolicy(): AdvisorPolicy {
  return {
    enabled: false,
    targets: ["discover", "plan", "review", "orchestrate"],
    maxRequests: 2,
    maxPerspectives: 3,
  };
}

function isDecisionMode(value: unknown): value is DecisionMode {
  return value === "cost" || value === "balance" || value === "power";
}

function isHostAssistancePolicy(value: unknown): value is HostAssistancePolicy {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    ["inherit", "on", "off"].includes(value.mode as string) &&
    (value.mode !== "off" || value.enabled === false) &&
    Array.isArray(value.contextClasses) &&
    value.contextClasses.every((item) =>
      ["workspace", "web", "docs", "paper", "connector", "skill"].includes(item as string),
    ) &&
    (value.privateConnector === "ask" || value.privateConnector === "deny") &&
    Number.isInteger(value.maxRequests) &&
    (value.maxRequests as number) >= 0 &&
    (value.maxRequests as number) <= MAX_HOST_ASSISTANCE_REQUESTS &&
    Number.isInteger(value.maxFanOut) &&
    (value.maxFanOut as number) >= 0 &&
    (value.maxFanOut as number) <= MAX_HOST_ASSISTANCE_FAN_OUT &&
    (value.reviewMode === undefined ||
      value.reviewMode === "user-only" ||
      value.reviewMode === "host-first") &&
    (value.autoApprovalScope === undefined ||
      value.autoApprovalScope === "context-only" ||
      value.autoApprovalScope === "read-only" ||
      value.autoApprovalScope === "reversible") &&
    (value.autoApproveDiscoveryGates === undefined ||
      typeof value.autoApproveDiscoveryGates === "boolean")
  );
}

function isAdvisorPolicy(value: unknown): value is AdvisorPolicy {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.targets) &&
    value.targets.every((item) =>
      [
        "ask",
        "review",
        "plan",
        "implement",
        "orchestrate",
        "scaffold",
        "setup",
        "discover",
      ].includes(item as string),
    ) &&
    Number.isInteger(value.maxRequests) &&
    (value.maxRequests as number) >= 0 &&
    (value.maxRequests as number) <= MAX_ADVISOR_REQUESTS &&
    Number.isInteger(value.maxPerspectives) &&
    (value.maxPerspectives as number) >= 0 &&
    (value.maxPerspectives as number) <= MAX_ADVISOR_PERSPECTIVES
  );
}

function isEffectiveProjectPolicyShape(input: unknown): input is EffectiveProjectPolicy {
  if (!isRecord(input)) return false;
  const value = input as Record<string, unknown>;
  const operations = ["read", "search", "write", "shell"] as const;
  if (!isRecord(value.roots)) return false;
  const roots = value.roots;
  return (
    value.version === 1 &&
    value.workspaceRoot === "." &&
    Array.isArray(value.allowedTaskKinds) &&
    value.allowedTaskKinds.every((kind) => typeof kind === "string") &&
    operations.every(
      (operation) =>
        Array.isArray(roots[operation]) &&
        roots[operation].every((root) => isCanonicalPolicyRoot(root)),
    ) &&
    Array.isArray(value.repositoryDenyRules) &&
    typeof value.scopeHash === "string" &&
    typeof value.hash === "string"
  );
}

function isCanonicalPolicyRoot(value: unknown): value is string {
  if (value === ".") return true;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0")
  )
    return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSnapshot(message: string): ProjectPolicyError {
  return new ProjectPolicyError({
    event: "policy-rejected",
    errorCode: "policy-snapshot-invalid",
    stage: "materialization",
    recoverable: false,
    message,
    preserved: [],
    nextActions: [],
  });
}

export function normalizeAdaptivePolicy(
  value: Partial<AdaptivePolicyConfig> | undefined,
): AdaptivePolicyConfig {
  return {
    classifierModels: strings(value?.classifierModels),
    classifierThinkingLevel: thinking(value?.classifierThinkingLevel, "medium"),
    approvalPolicy: value?.approvalPolicy === "wait" ? "wait" : "deny",
    trustedDomains: unique(strings(value?.trustedDomains).map(normalizeDomain).filter(Boolean)),
    rules: Array.isArray(value?.rules) ? value.rules.map((rule) => structuredClone(rule)) : [],
    diagnostics: value?.diagnostics === true,
  };
}

export function listDefaultRoles(): RolePolicy[] {
  return Object.keys(DEFAULT_ROLES).map((id) => structuredClone(DEFAULT_ROLES[id as RoleId]));
}

export function isWorkerRole(value: string): value is WorkerRoleId {
  return [
    "scout",
    "planner",
    "reviewer",
    "analyst",
    "mechanical-executor",
    "executor",
    "security-executor",
    "project-architect",
    "scaffolder",
    "environment-engineer",
    "experimenter",
  ].includes(value);
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function role(
  id: RoleId,
  taskKinds: TaskKind[],
  executionModes: ExecutionMode[],
  capabilities: Capability[],
  thinkingLevel: ThinkingLevel,
  verification: RolePolicy["verification"],
): RolePolicy {
  return {
    role: id,
    taskKinds,
    executionModes,
    capabilities,
    thinkingLevel,
    models: [],
    maxAttempts: 2,
    verification,
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function thinking(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return typeof value === "string" && isThinkingLevel(value) ? value : fallback;
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, "*.").replace(/\.$/, "");
}

function clampAttempts(value: number): number {
  return Number.isInteger(value) ? Math.min(2, Math.max(1, value)) : 2;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
