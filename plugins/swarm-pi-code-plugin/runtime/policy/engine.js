import { createHash } from "node:crypto";
import path from "node:path";
/** A bounded, job-scoped cache for validated classifier decisions. */
export class ClassifierDecisionCache {
    ttlMs;
    maxEntries;
    now;
    entries = new Map();
    constructor(ttlMs = 5 * 60_000, maxEntries = 256, now = Date.now) {
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.now = now;
    }
    key(actionFingerprint, snapshot) {
        return `${snapshot.hash}:${actionFingerprint}`;
    }
    get(key) {
        this.prune();
        const entry = this.entries.get(key);
        if (!entry)
            return null;
        return structuredClone(entry.decision);
    }
    set(key, decision) {
        if (decision.decision === "deny")
            return;
        this.prune();
        const createdAt = this.now();
        this.entries.set(key, {
            decision: structuredClone(decision),
            createdAt,
            expiresAt: createdAt + this.ttlMs,
        });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (!oldest)
                break;
            this.entries.delete(oldest);
        }
    }
    delete(key) {
        this.entries.delete(key);
    }
    size() {
        this.prune();
        return this.entries.size;
    }
    prune() {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now)
                this.entries.delete(key);
        }
    }
}
export class PolicyEngine {
    snapshot;
    classifier;
    leases;
    classifierCache;
    classifierInflight = new Map();
    onDecision;
    constructor(options) {
        this.snapshot = options.snapshot;
        this.classifier = options.classifier;
        this.leases = options.leases;
        this.classifierCache = options.classifierCache ?? new ClassifierDecisionCache();
        this.onDecision = options.onDecision;
    }
    async authorize(action, signal) {
        const fingerprint = actionFingerprint(action);
        const hardDenied = hardDeny(action, this.snapshot);
        if (hardDenied)
            return this.record(action, hardDenied, fingerprint);
        const capabilities = capabilitiesFor(action);
        const missing = capabilities.filter((capability) => !this.snapshot.rolePolicy.capabilities.includes(capability));
        if (missing.length > 0) {
            return this.record(action, decision("deny", "critical", capabilities, `Role ${this.snapshot.rolePolicy.role} does not have ${missing.join(", ")}.`, this.snapshot), fingerprint);
        }
        const rule = matchingRule(action, capabilities, this.snapshot);
        if (rule?.effect === "deny") {
            return this.record(action, decision("deny", "high", capabilities, `Denied by policy rule ${rule.id}.`, this.snapshot), fingerprint);
        }
        const lease = await this.leases?.find(fingerprint, this.snapshot);
        if (lease && (await this.leases.consume(lease))) {
            return this.record(action, decision("allow", "high", capabilities, `Allowed by lease ${lease.id}.`, this.snapshot), fingerprint);
        }
        if (rule?.effect === "allow") {
            return this.record(action, decision("allow", "low", capabilities, `Allowed by policy rule ${rule.id}.`, this.snapshot), fingerprint);
        }
        if (rule?.effect === "ask") {
            return this.record(action, approvalDecision(capabilities, `Policy rule ${rule.id} requires approval.`, this.snapshot), fingerprint);
        }
        if (this.snapshot.sandboxMode === "strict") {
            const allowed = isReadonlyTool(action.toolName) ||
                action.toolName === "write" ||
                action.toolName === "edit";
            return this.record(action, decision(allowed ? "allow" : "deny", allowed ? "low" : "high", capabilities, allowed ? "Strict read-only fast path." : "Strict mode does not expose this capability.", this.snapshot), fingerprint);
        }
        if (this.snapshot.sandboxMode === "lenient") {
            return this.record(action, decision("allow", riskFor(action), capabilities, "Allowed by lenient sandbox policy.", this.snapshot), fingerprint);
        }
        if (isReadonlyTool(action.toolName)) {
            return this.record(action, decision("allow", "low", capabilities, "Adaptive read-only fast path.", this.snapshot), fingerprint);
        }
        if (action.domain &&
            trustedDomain(action.domain, this.snapshot.adaptivePolicy.trustedDomains)) {
            return this.record(action, decision("allow", "medium", capabilities, "Allowed trusted network destination.", this.snapshot), fingerprint);
        }
        if (!this.classifier) {
            const fallback = this.snapshot.approvalMode === "wait"
                ? approvalDecision(capabilities, "Classifier unavailable; supervisor approval is required.", this.snapshot)
                : decision("deny", "high", capabilities, "Classifier unavailable and no approval channel exists.", this.snapshot);
            return this.record(action, fallback, fingerprint);
        }
        const cacheKey = this.classifierCache.key(fingerprint, this.snapshot);
        const cached = this.classifierCache.get(cacheKey);
        if (cached) {
            try {
                const validated = validateClassifierDecision(cached, capabilities, this.snapshot);
                if (validated.decision !== "deny") {
                    return this.record(action, validated, fingerprint, { classifierCache: "hit" });
                }
            }
            catch {
                this.classifierCache.delete(cacheKey);
            }
        }
        const inflight = this.classifierInflight.get(cacheKey);
        if (inflight) {
            try {
                const classified = await inflight;
                return this.record(action, classified, fingerprint, { classifierCache: "coalesced" });
            }
            catch (error) {
                const fallback = classifierFallback(capabilities, this.snapshot, error);
                return this.record(action, fallback, fingerprint, { classifierCache: "coalesced" });
            }
        }
        const classification = this.classify(action, signal);
        this.classifierInflight.set(cacheKey, classification);
        try {
            const classified = await classification;
            if (classified.decision !== "deny")
                this.classifierCache.set(cacheKey, classified);
            return this.record(action, classified, fingerprint, { classifierCache: "miss" });
        }
        catch (error) {
            return this.record(action, classifierFallback(capabilities, this.snapshot, error), fingerprint, { classifierCache: "miss" });
        }
        finally {
            if (this.classifierInflight.get(cacheKey) === classification)
                this.classifierInflight.delete(cacheKey);
        }
    }
    async classify(action, signal) {
        const classified = await this.classifier.classify(action, this.snapshot, signal);
        return validateClassifierDecision(classified, capabilitiesFor(action), this.snapshot);
    }
    async record(action, value, fingerprint, metadata) {
        await this.onDecision?.(action, value, fingerprint, metadata);
        return value;
    }
}
function classifierFallback(capabilities, snapshot, error) {
    const message = error instanceof Error ? error.message : String(error);
    return snapshot.approvalMode === "wait"
        ? approvalDecision(capabilities, `Classifier failed: ${message}`, snapshot)
        : decision("deny", "high", capabilities, `Classifier failed closed: ${message}`, snapshot);
}
export function actionFingerprint(action) {
    return createHash("sha256")
        .update(JSON.stringify({
        toolName: action.toolName,
        input: stable(action.input),
        path: action.path ? path.resolve(action.cwd, action.path) : undefined,
        domain: action.domain?.toLowerCase(),
        port: action.port,
    }))
        .digest("hex");
}
export function capabilitiesFor(action) {
    if (action.domain)
        return ["network.connect"];
    if (action.toolName === "bash")
        return ["shell.execute"];
    if (action.toolName === "write" || action.toolName === "edit")
        return ["filesystem.write-workspace"];
    if (["read", "grep", "find", "ls"].includes(action.toolName))
        return ["filesystem.read-workspace"];
    return [];
}
function hardDeny(action, snapshot) {
    if (action.toolName === "bash" && typeof action.input.command === "string") {
        const command = action.input.command;
        if (/\b(?:sudo|su)\b|\bgit\s+(?:add|commit|checkout|switch|branch|merge|rebase|reset|push|tag|worktree)\b|\b(?:kubectl\s+(?:apply|delete)|helm\s+(?:install|upgrade|uninstall)|terraform\s+(?:apply|destroy))\b/.test(command)) {
            return decision("deny", "critical", ["shell.execute"], "Git delivery, privilege changes, and deployment commands are immutable denials.", snapshot);
        }
        if (/\b(?:brew|apt(?:-get)?|dnf|yum|pacman)\s+(?:install|upgrade)\b|\bnpm\s+(?:install|i)\s+(?:-g|--global)\b|\bpnpm\s+(?:add|install)\s+(?:-g|--global)\b/.test(command)) {
            return decision("deny", "critical", ["shell.execute"], "Global package and host provisioning commands are immutable denials.", snapshot);
        }
        if (snapshot.rolePolicy.role === "scaffolder" &&
            /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv)\s+(?:install|ci|add|sync)\b/.test(command)) {
            return decision("deny", "high", ["shell.execute"], "Dependency installation belongs to the supervised environment-engineer phase.", snapshot);
        }
        if (snapshot.rolePolicy.role === "environment-engineer" &&
            /\b(?:npm|pnpm|yarn|bun|pip|pip3|uv)\s+(?:install|ci|add|sync)\b/.test(command) &&
            !/--ignore-scripts|--mode[= ]skip-build/.test(command)) {
            return approvalDecision(["shell.execute"], "Package lifecycle and native build execution requires supervisor approval.", snapshot);
        }
        if (/(?:^|[\s'"])(?:\.git|\.swarm-pi-code-plugin|\.env(?:\.local)?)(?:[\s/'"]|$)/.test(command)) {
            return decision("deny", "critical", ["shell.execute"], "Shell access to protected control and credential paths is denied.", snapshot);
        }
    }
    if (action.domain && isForbiddenDomain(action.domain)) {
        return decision("deny", "critical", ["network.connect"], "Local, private, and metadata destinations are immutable denials.", snapshot);
    }
    if (action.path) {
        const absolute = path.resolve(action.cwd, action.path);
        const relative = path.relative(path.resolve(action.cwd), absolute);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return decision("deny", "critical", capabilitiesFor(action), "Path is outside the assigned workspace.", snapshot);
        }
        if (relative.split(path.sep).includes(".git") ||
            relative.startsWith(".swarm-pi-code-plugin") ||
            relative === ".env" ||
            relative === ".env.local" ||
            relative === ".swarm-pi-policy.json") {
            return decision("deny", "critical", capabilitiesFor(action), "Git metadata and plugin control state are immutable denials.", snapshot);
        }
    }
    return null;
}
function matchingRule(action, capabilities, snapshot) {
    const matches = snapshot.adaptivePolicy.rules.filter((rule) => capabilities.includes(rule.capability) &&
        (!rule.roles || rule.roles.includes(snapshot.rolePolicy.role)) &&
        (!rule.taskKinds ||
            rule.taskKinds.some((kind) => snapshot.rolePolicy.taskKinds.includes(kind))) &&
        (!rule.pathPrefix ||
            Boolean(action.path &&
                isWithin(path.resolve(action.cwd, rule.pathPrefix), path.resolve(action.cwd, action.path)))) &&
        (!rule.domain || Boolean(action.domain && trustedDomain(action.domain, [rule.domain]))));
    return (matches.find((rule) => rule.effect === "deny") ??
        matches.find((rule) => rule.effect === "ask") ??
        matches.find((rule) => rule.effect === "allow"));
}
function validateClassifierDecision(value, capabilities, snapshot) {
    if (!["allow", "deny", "require-approval"].includes(value.decision))
        throw new Error("invalid decision");
    if (!["low", "medium", "high", "critical"].includes(value.risk))
        throw new Error("invalid risk");
    if (value.policyHash !== snapshot.hash)
        throw new Error("policy hash mismatch");
    if (value.capabilities.some((item) => !capabilities.includes(item)))
        throw new Error("classifier broadened capabilities");
    if (value.risk === "critical" && value.decision !== "deny") {
        return decision("deny", "critical", capabilities, "Critical classifier decisions cannot be approved.", snapshot);
    }
    if (value.risk === "high" && value.decision === "allow") {
        return approvalDecision(capabilities, value.reason || "High-risk action requires approval.", snapshot, value.model);
    }
    return {
        ...value,
        capabilities,
        constraints: Array.isArray(value.constraints) ? value.constraints : [],
    };
}
function decision(kind, risk, capabilities, reason, snapshot, model) {
    return {
        decision: kind,
        risk,
        capabilities,
        reason,
        constraints: [],
        policyHash: snapshot.hash,
        ...(model ? { model } : {}),
    };
}
function approvalDecision(capabilities, reason, snapshot, model) {
    return decision(snapshot.approvalMode === "wait" ? "require-approval" : "deny", "high", capabilities, reason, snapshot, model);
}
function isReadonlyTool(name) {
    return ["read", "grep", "find", "ls"].includes(name);
}
function riskFor(action) {
    return action.domain || action.toolName === "bash"
        ? "medium"
        : action.toolName === "write" || action.toolName === "edit"
            ? "medium"
            : "low";
}
function trustedDomain(domain, patterns) {
    const normalized = domain.toLowerCase().replace(/\.$/, "");
    return patterns.some((pattern) => {
        const candidate = pattern.toLowerCase();
        return candidate.startsWith("*.")
            ? normalized.endsWith(candidate.slice(1)) && normalized !== candidate.slice(2)
            : normalized === candidate;
    });
}
function isForbiddenDomain(domain) {
    const value = domain.toLowerCase().replace(/[[\]]/g, "");
    return (value === "localhost" ||
        value === "0.0.0.0" ||
        value === "::1" ||
        value === "169.254.169.254" ||
        value.startsWith("127.") ||
        value.startsWith("10.") ||
        value.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(value) ||
        value.startsWith("169.254.") ||
        value.startsWith("fc") ||
        value.startsWith("fd"));
}
function stable(value) {
    if (Array.isArray(value))
        return value.map(stable);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stable(item)]));
    }
    return value;
}
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)));
}
