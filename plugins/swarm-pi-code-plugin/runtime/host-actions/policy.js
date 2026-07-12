import { createHash, randomUUID } from "node:crypto";
const REMOTE_ACTIONS = new Set([
    "remote-write", "message", "deploy", "transaction",
]);
export function assertHostActionAllowed(options) {
    if (!options.policy.enabled)
        throw new Error("Host Actions are disabled by workspace policy");
    if (options.parentKind !== "implement" && options.parentKind !== "setup") {
        throw new Error(`Host Action requires original mutation intent; parent task is ${options.parentKind}`);
    }
    if (options.parentRole === "advisor" || options.parentRole === "review-coordinator") {
        throw new Error(`Role cannot create Host Actions: ${options.parentRole}`);
    }
    if (!options.policy.allowedActionClasses.includes(options.recommendation.actionClass)) {
        throw new Error(`Host Action class is disabled: ${options.recommendation.actionClass}`);
    }
    if (REMOTE_ACTIONS.has(options.recommendation.actionClass) && !options.policy.remoteActionsEnabled) {
        throw new Error(`Remote Host Actions are disabled: ${options.recommendation.actionClass}`);
    }
}
export function createActionFamilyLease(options) {
    const now = options.now ?? new Date();
    const scopeKey = createHash("sha256").update(JSON.stringify({
        actionClass: options.recommendation.actionClass,
        target: options.recommendation.target ?? null,
        policyHash: options.snapshot.hash,
        scopeHash: options.snapshot.version === 1 ? null : options.snapshot.scopeHash,
    })).digest("hex");
    return {
        id: randomUUID(),
        jobId: options.jobId,
        generation: options.generation,
        policyHash: options.snapshot.hash,
        ...(options.snapshot.version === 1 ? {} : { scopeHash: options.snapshot.scopeHash }),
        role: options.role,
        actionFingerprint: scopeKey,
        scope: "once",
        capabilities: options.recommendation.actionClass === "local-mutation" || options.recommendation.actionClass === "draft"
            ? ["filesystem.write-workspace"]
            : ["network.connect"],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + options.policy.ttlMs).toISOString(),
        principal: "host-broker",
        actionFamily: {
            actionClass: options.recommendation.actionClass,
            ...(options.recommendation.target ? { target: options.recommendation.target } : {}),
            scopeKey,
            maxUses: options.policy.maxUses,
            used: 0,
            maxCost: options.policy.maxCost,
        },
    };
}
export function createHostActionReceipt(options) {
    return {
        parentJobId: options.parentJobId,
        recommendationId: options.recommendationId,
        childJobId: options.childJobId,
        actionClass: options.recommendation.actionClass,
        ...(options.recommendation.target ? { target: options.recommendation.target } : {}),
        principal: "host-broker",
        outcome: options.outcome,
        ...(options.artifactHash ? { artifactHash: options.artifactHash } : {}),
        createdAt: new Date().toISOString(),
    };
}
