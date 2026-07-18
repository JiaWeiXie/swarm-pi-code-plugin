import { createHash } from "node:crypto";
import path from "node:path";
import { analyzeShellCommand, isReadOnlyGitBranch, isReadOnlyShellCommand, isReadOnlyShellInvocation, isVersionProbeInvocation, parseGitInvocation, shellPathOperands, } from "./read-only-shell.js";
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
        const mandatoryDecision = hardDeny(action, this.snapshot);
        if (mandatoryDecision?.decision === "deny") {
            return this.record(action, mandatoryDecision, fingerprint);
        }
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
        if (mandatoryDecision)
            return this.record(action, mandatoryDecision, fingerprint);
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
        if (this.snapshot.sandboxMode === "lenient" ||
            this.snapshot.sandboxMode === "autopilot" ||
            this.snapshot.sandboxMode === "full-access") {
            return this.record(action, decision("allow", riskFor(action), capabilities, this.snapshot.sandboxMode === "full-access"
                ? "Allowed by full-access sandbox policy (no OS sandbox)."
                : this.snapshot.sandboxMode === "autopilot"
                    ? "Allowed by autopilot sandbox policy."
                    : "Allowed by lenient sandbox policy.", this.snapshot), fingerprint);
        }
        if (isReadonlyTool(action.toolName)) {
            return this.record(action, decision("allow", "low", capabilities, "Adaptive read-only fast path.", this.snapshot), fingerprint);
        }
        const effectAssessment = assessPolicyActionEffect(action);
        if (effectAssessment.effect === "read-only") {
            return this.record(action, decision("allow", "low", capabilities, "Adaptive deterministic read-only fast path.", this.snapshot), fingerprint);
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
export function assessPolicyActionEffect(action) {
    const capabilities = capabilitiesFor(action);
    if (isReadonlyTool(action.toolName)) {
        return {
            version: 1,
            source: "deterministic-tool",
            effect: "read-only",
            reversibility: "read-only",
            capabilities,
            reasonCode: "read-only-tool",
        };
    }
    if (action.toolName === "bash" && typeof action.input.command === "string") {
        const readOnly = isReadOnlyShellCommand(action.input.command, action.cwd);
        return {
            version: 1,
            source: "deterministic-shell",
            effect: readOnly ? "read-only" : "unknown",
            reversibility: readOnly ? "read-only" : "partially-reversible",
            capabilities,
            reasonCode: readOnly ? "read-only-shell" : "unproven-shell-effect",
        };
    }
    if (action.toolName === "write" || action.toolName === "edit") {
        return {
            version: 1,
            source: "deterministic-tool",
            effect: "reversible-workspace-write",
            reversibility: "reversible",
            capabilities,
            reasonCode: "reversible-file-tool",
        };
    }
    if (action.domain) {
        return {
            version: 1,
            source: "deterministic-tool",
            effect: "network",
            reversibility: "partially-reversible",
            capabilities,
            reasonCode: "network-action",
        };
    }
    return {
        version: 1,
        source: "deterministic-tool",
        effect: "unknown",
        reversibility: "partially-reversible",
        capabilities,
        reasonCode: "unclassified-action",
    };
}
function hardDeny(action, snapshot) {
    if (action.toolName === "bash" && typeof action.input.command === "string") {
        const analysis = analyzeShellCommand(action.input.command);
        if (analysis.commands.some(isPrivilegeEscalationInvocation)) {
            return decision("deny", "critical", ["shell.execute"], "Privilege escalation commands are immutable denials.", snapshot);
        }
        const hasGitWrite = analysis.commands.some(isGitWriteInvocation);
        const hasDeployment = analysis.commands.some(isDeploymentInvocation);
        if (hasGitWrite && !autopilotAllowsOutward(snapshot, "git")) {
            return decision("deny", "critical", ["shell.execute"], "Git delivery commands are immutable denials.", snapshot);
        }
        if (hasDeployment && !autopilotAllowsOutward(snapshot, "deploy")) {
            return decision("deny", "critical", ["shell.execute"], "Deployment commands are immutable denials.", snapshot);
        }
        if (hasGitWrite || hasDeployment) {
            // Autopilot permits this outward/irreversible action, but it always passes
            // through a human approval gate. The git/deploy ceiling in jobs.ts blocks
            // host-model auto-approval, so the first (each-time) or first-only
            // (first-then-auto, via a job-scoped lease) decision falls to the user.
            return approvalDecision(["shell.execute"], hasGitWrite
                ? "Autopilot git write requires human approval."
                : "Autopilot deployment requires human approval.", snapshot);
        }
        if (analysis.commands.some(isHostProvisioningInvocation)) {
            return decision("deny", "critical", ["shell.execute"], "Global package and host provisioning commands are immutable denials.", snapshot);
        }
        if (snapshot.rolePolicy.role === "scaffolder" &&
            analysis.commands.some(isDependencyInstallInvocation)) {
            return decision("deny", "high", ["shell.execute"], "Dependency installation belongs to the supervised environment-engineer phase.", snapshot);
        }
        if (snapshot.rolePolicy.role === "environment-engineer" &&
            analysis.commands.some((invocation) => isDependencyInstallInvocation(invocation) &&
                !invocation.args.some((arg, index) => arg === "--ignore-scripts" ||
                    arg === "--mode=skip-build" ||
                    (arg === "--mode" && invocation.args[index + 1] === "skip-build")))) {
            return approvalDecision(["shell.execute"], "Package lifecycle and native build execution requires supervisor approval.", snapshot);
        }
        if (shellPathOperands(analysis).some(isProtectedShellPath)) {
            return decision("deny", "critical", ["shell.execute"], "Shell access to protected control and credential paths is denied.", snapshot);
        }
        const routineShellBypass = autopilotAllowsRoutineShell(snapshot);
        if (!routineShellBypass &&
            shellPathOperands(analysis).some((value) => shellPathEscapesWorkspace(value, action.cwd))) {
            return approvalDecision(["shell.execute"], "Workspace-external shell paths require supervisor approval.", snapshot);
        }
        if (!routineShellBypass) {
            const reviewReason = shellHumanReviewReason(analysis);
            if (reviewReason) {
                return approvalDecision(["shell.execute"], reviewReason, snapshot);
            }
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
    const claimedCapabilities = [...new Set(value.capabilities)];
    const normalized = claimedCapabilities.length !== capabilities.length ||
        claimedCapabilities.some((item) => !capabilities.includes(item));
    const materialUnexpectedCapabilities = claimedCapabilities.filter((item) => !capabilities.includes(item) && item !== "filesystem.read-workspace" && item !== "git.read");
    const classifierEvidence = {
        claimedCapabilities,
        runtimeCapabilities: [...capabilities],
        normalized,
    };
    if (value.risk === "critical" && value.decision !== "deny") {
        return {
            ...decision("deny", "critical", capabilities, "Critical classifier decisions cannot be approved.", snapshot),
            classifierEvidence,
        };
    }
    if (value.risk === "high" && value.decision === "allow") {
        return {
            ...approvalDecision(capabilities, value.reason || "High-risk action requires approval.", snapshot, value.model),
            classifierEvidence,
        };
    }
    if (materialUnexpectedCapabilities.length > 0 && value.decision === "allow") {
        return {
            ...approvalDecision(capabilities, `Classifier reported an unproven material effect: ${materialUnexpectedCapabilities.join(", ")}.`, snapshot, value.model),
            classifierEvidence,
        };
    }
    return {
        ...value,
        capabilities,
        constraints: [
            ...(Array.isArray(value.constraints) ? value.constraints : []),
            ...(normalized
                ? ["Classifier capability claims normalized to runtime-derived effects."]
                : []),
        ],
        classifierEvidence,
    };
}
function isPrivilegeEscalationInvocation(invocation) {
    return invocation.executable === "sudo" || invocation.executable === "su";
}
function isGitWriteInvocation(invocation) {
    if (invocation.executable !== "git")
        return false;
    const parsed = parseGitInvocation(invocation.args);
    if (!parsed)
        return false;
    if (["add", "commit", "checkout", "switch", "merge", "rebase", "reset", "push"].includes(parsed.subcommand)) {
        return true;
    }
    if (parsed.subcommand === "branch")
        return !isReadOnlyGitBranch(parsed.args);
    if (parsed.subcommand === "tag") {
        return !(parsed.args.length === 0 ||
            parsed.args.some((arg) => [
                "-l",
                "--list",
                "--contains",
                "--no-contains",
                "--merged",
                "--no-merged",
                "--points-at",
                "--format",
                "--sort",
            ].some((option) => arg === option || arg.startsWith(`${option}=`))));
    }
    if (parsed.subcommand === "worktree")
        return parsed.args[0] !== "list";
    return false;
}
function isDeploymentInvocation(invocation) {
    if (invocation.executable === "kubectl")
        return ["apply", "delete"].includes(invocation.args[0] ?? "");
    if (invocation.executable === "helm")
        return ["install", "upgrade", "uninstall"].includes(invocation.args[0] ?? "");
    return (invocation.executable === "terraform" && ["apply", "destroy"].includes(invocation.args[0] ?? ""));
}
/**
 * Autopilot may cross specific outward/irreversible shell boundaries that are
 * otherwise immutable hard-denials. This is only ever true in the permissive
 * shell modes with the explicit per-boundary opt-in set; even then the action
 * still passes through a human approval gate (never host-model auto-approval,
 * which the git/deploy ceiling in jobs.ts rejects).
 */
function autopilotAllowsOutward(snapshot, kind) {
    if (snapshot.sandboxMode !== "autopilot" && snapshot.sandboxMode !== "full-access") {
        return false;
    }
    if (snapshot.version !== 3)
        return false;
    return kind === "git"
        ? snapshot.hostAssistance.autoGitWrites === true
        : snapshot.hostAssistance.autoDelivery === true;
}
/**
 * Whether routine shell commands that otherwise require supervisor approval
 * (build/test, rm/mv/cp, curl/wget, interpreters, redirection, workspace-external
 * paths) run unattended. This is intrinsic to the Autopilot and full-access modes;
 * plain Lenient (and every other mode) keeps its gates. It never relaxes the
 * immutable denials (privilege escalation, control paths, secrets, git metadata)
 * or the git/deploy gates.
 */
function autopilotAllowsRoutineShell(snapshot) {
    return snapshot.sandboxMode === "autopilot" || snapshot.sandboxMode === "full-access";
}
function isHostProvisioningInvocation(invocation) {
    if (["brew", "apt", "apt-get", "dnf", "yum", "pacman"].includes(invocation.executable)) {
        return invocation.args.some((arg) => arg === "install" || arg === "upgrade");
    }
    if (!["npm", "pnpm"].includes(invocation.executable))
        return false;
    const lifecycle = invocation.args.some((arg) => ["install", "i", "add"].includes(arg));
    const global = invocation.args.some((arg) => arg === "-g" || arg === "--global");
    return lifecycle && global;
}
function isDependencyInstallInvocation(invocation) {
    if (!["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv"].includes(invocation.executable)) {
        return false;
    }
    return invocation.args.some((arg) => ["install", "i", "ci", "add", "sync"].includes(arg));
}
function isProtectedShellPath(value) {
    const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
    return (segments.includes(".git") ||
        segments.includes(".swarm-pi-code-plugin") ||
        segments.some((segment) => [".env", ".env.local", ".swarm-pi-policy.json"].includes(segment)));
}
function shellPathEscapesWorkspace(value, cwd) {
    const normalized = value.replaceAll("\\", "/");
    if (normalized.split("/").includes(".."))
        return true;
    if (!path.isAbsolute(value))
        return false;
    const relative = path.relative(path.resolve(cwd), path.resolve(value));
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
function shellHumanReviewReason(analysis) {
    if (analysis.malformed ||
        analysis.hasExpansion ||
        analysis.hasCommandSubstitution ||
        analysis.hasBackticks ||
        analysis.hasHereDoc ||
        analysis.hasControlFlow ||
        analysis.hasAssignments ||
        analysis.redirectionTargets.length > 0) {
        return "Shell expansion, control flow, or redirection requires supervisor approval.";
    }
    if (analysis.commands.some((invocation) => [
        "sh",
        "bash",
        "zsh",
        "fish",
        "env",
        "exec",
        "eval",
        "builtin",
        "nohup",
        "nice",
        "timeout",
        "setsid",
        "parallel",
        "source",
        ".",
        "xargs",
        "python",
        "python3",
        "node",
        "ruby",
        "perl",
        "awk",
        "osascript",
    ].includes(invocation.executable) && !isVersionProbeInvocation(invocation))) {
        return "Shell wrappers and interpreters require supervisor approval.";
    }
    if (analysis.commands.some((invocation) => [
        "rm",
        "rmdir",
        "unlink",
        "mv",
        "cp",
        "touch",
        "mkdir",
        "chmod",
        "chown",
        "ln",
        "truncate",
        "install",
        "tee",
        "dd",
        "patch",
        "curl",
        "wget",
        "ssh",
        "scp",
        "rsync",
    ].includes(invocation.executable))) {
        return "Filesystem mutation and shell network tools require supervisor approval.";
    }
    if (analysis.commands.some(isBuildOrTestInvocation)) {
        return "Build, test, and package lifecycle commands require supervisor approval.";
    }
    if (analysis.commands.some((invocation) => ["git", "find", "rg", "fd", "sed", "sort", "tree", "file", "diff", "cmp", "tail"].includes(invocation.executable) && !isReadOnlyShellInvocation(invocation))) {
        return "Unproven write or executable flags require supervisor approval.";
    }
    if (analysis.commands.some((invocation) => {
        if (invocation.executable !== "command")
            return false;
        return invocation.args.length !== 2 || invocation.args[0] !== "-v";
    })) {
        return "Shell command wrappers require supervisor approval.";
    }
    return null;
}
function isBuildOrTestInvocation(invocation) {
    if (["make", "ninja", "gradle", "gradlew", "mvn", "bazel", "xcodebuild"].includes(invocation.executable)) {
        return true;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(invocation.executable)) {
        return invocation.args.some((arg) => ["test", "run", "exec", "build", "install", "i", "ci", "add"].includes(arg));
    }
    if (invocation.executable === "cargo") {
        return invocation.args.some((arg) => ["test", "build", "check", "run", "install"].includes(arg));
    }
    if (["pytest", "go", "dotnet", "swift", "swiftc"].includes(invocation.executable))
        return true;
    return false;
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
