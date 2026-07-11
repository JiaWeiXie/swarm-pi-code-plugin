import { createHash } from "node:crypto";
const READONLY = [
    "filesystem.read-workspace",
    "filesystem.write-temp",
    "git.read",
    "shell.execute",
    "network.connect",
];
const IMPLEMENT = [...READONLY, "filesystem.write-workspace"];
const DEFAULT_ROLES = {
    scout: role("scout", ["ask"], ["supervised", "background"], READONLY, "low", "none"),
    planner: role("planner", ["plan"], ["supervised", "background"], READONLY, "xhigh", "none"),
    reviewer: role("reviewer", ["review"], ["supervised", "background"], READONLY, "high", "none"),
    analyst: role("analyst", ["orchestrate"], ["supervised", "background"], READONLY, "medium", "none"),
    "mechanical-executor": role("mechanical-executor", ["implement"], ["supervised"], IMPLEMENT, "low", "agent"),
    executor: role("executor", ["implement"], ["supervised"], IMPLEMENT, "high", "agent"),
    "security-executor": role("security-executor", ["ask", "review", "implement"], ["supervised"], IMPLEMENT, "high", "agent"),
    "project-architect": role("project-architect", ["plan"], ["supervised", "background"], READONLY, "xhigh", "none"),
    scaffolder: role("scaffolder", ["scaffold"], ["supervised", "background"], IMPLEMENT, "high", "agent"),
    "environment-engineer": role("environment-engineer", ["setup"], ["supervised"], IMPLEMENT, "high", "agent"),
    verifier: role("verifier", ["review"], ["supervised"], READONLY, "medium", "none"),
    classifier: role("classifier", ["ask"], ["supervised"], [], "medium", "none"),
};
export const DEFAULT_ADAPTIVE_POLICY = {
    classifierModels: [],
    classifierThinkingLevel: "medium",
    approvalPolicy: "deny",
    trustedDomains: [],
    rules: [],
    diagnostics: false,
};
export const DEFAULT_BACKGROUND_ROLE_POLICY = {
    mechanicalExecutor: false,
};
export function defaultRoleForTask(kind) {
    switch (kind) {
        case "ask": return "scout";
        case "plan": return "planner";
        case "review": return "reviewer";
        case "orchestrate": return "analyst";
        case "implement": return "executor";
        case "scaffold": return "scaffolder";
        case "setup": return "environment-engineer";
    }
}
export function resolveRolePolicy(roleId, overrides = {}, globalModels = [], background = DEFAULT_BACKGROUND_ROLE_POLICY) {
    const base = DEFAULT_ROLES[roleId];
    const override = isWorkerRole(roleId) ? overrides[roleId] : undefined;
    const executionModes = roleId === "mechanical-executor" && background.mechanicalExecutor
        ? unique([...base.executionModes, "background"])
        : [...base.executionModes];
    return {
        ...base,
        role: roleId,
        taskKinds: [...base.taskKinds],
        executionModes,
        capabilities: [...base.capabilities],
        thinkingLevel: override?.thinkingLevel && isThinkingLevel(override.thinkingLevel)
            ? override.thinkingLevel
            : base.thinkingLevel,
        models: [...(override?.models?.length ? override.models : globalModels)],
        maxAttempts: clampAttempts(override?.maxAttempts ?? base.maxAttempts),
    };
}
export function assertRoleCompatible(policy, kind, executionMode) {
    if (!policy.taskKinds.includes(kind))
        throw new Error(`Role ${policy.role} cannot run ${kind}`);
    if (!policy.executionModes.includes(executionMode)) {
        throw new Error(`Role ${policy.role} does not support ${executionMode} execution`);
    }
}
export function createPolicySnapshot(input) {
    const adaptivePolicy = normalizeAdaptivePolicy(input.adaptivePolicy);
    const createdAt = new Date().toISOString();
    const canonical = {
        version: 1,
        sandboxMode: input.sandboxMode,
        approvalMode: input.approvalMode,
        rolePolicy: input.rolePolicy,
        ...(input.escalationPolicy ? { escalationPolicy: input.escalationPolicy } : {}),
        adaptivePolicy,
    };
    return {
        ...canonical,
        hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
        createdAt,
    };
}
export function normalizeAdaptivePolicy(value) {
    return {
        classifierModels: strings(value?.classifierModels),
        classifierThinkingLevel: thinking(value?.classifierThinkingLevel, "medium"),
        approvalPolicy: value?.approvalPolicy === "wait" ? "wait" : "deny",
        trustedDomains: unique(strings(value?.trustedDomains).map(normalizeDomain).filter(Boolean)),
        rules: Array.isArray(value?.rules) ? value.rules.map((rule) => structuredClone(rule)) : [],
        diagnostics: value?.diagnostics === true,
    };
}
export function listDefaultRoles() {
    return Object.keys(DEFAULT_ROLES).map((id) => structuredClone(DEFAULT_ROLES[id]));
}
export function isWorkerRole(value) {
    return ["scout", "planner", "reviewer", "analyst", "mechanical-executor", "executor", "security-executor",
        "project-architect", "scaffolder", "environment-engineer"]
        .includes(value);
}
export function isThinkingLevel(value) {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
function role(id, taskKinds, executionModes, capabilities, thinkingLevel, verification) {
    return { role: id, taskKinds, executionModes, capabilities, thinkingLevel, models: [], maxAttempts: 2, verification };
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function thinking(value, fallback) {
    return typeof value === "string" && isThinkingLevel(value) ? value : fallback;
}
function normalizeDomain(value) {
    return value.trim().toLowerCase().replace(/^\*\./, "*.").replace(/\.$/, "");
}
function clampAttempts(value) {
    return Number.isInteger(value) ? Math.min(2, Math.max(1, value)) : 2;
}
function unique(values) {
    return [...new Set(values)];
}
