import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
const CAPABILITIES = new Set([
    "filesystem.read-workspace", "filesystem.write-workspace", "filesystem.write-temp",
    "git.read", "shell.execute", "network.connect",
]);
const TASK_KINDS = ["ask", "review", "plan", "implement", "orchestrate", "scaffold", "setup", "discover"];
const OPERATIONS = ["read", "search", "write", "shell"];
const TASK_ALIASES = {
    implementation: ["implement"],
    planning: ["plan"],
    "code-review": ["review"],
    analysis: ["ask", "orchestrate"],
    scaffolding: ["scaffold"],
    "development-setup": ["setup"],
};
/** An error suitable for serialization by later policy enforcement phases. */
export class ProjectPolicyError extends Error {
    rejection;
    constructor(rejection) {
        super(rejection.message);
        this.rejection = rejection;
        this.name = "ProjectPolicyError";
    }
}
export async function loadRepositoryDenyRules(cwd) {
    const file = path.join(cwd, ".swarm-pi-policy.json");
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw new Error(`Invalid repository policy: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Repository policy must be an object");
    const rules = parsed.rules;
    if (!Array.isArray(rules) || rules.length > 128)
        throw new Error("Repository policy rules must be an array of at most 128 entries");
    return rules.map((value, index) => normalizeDenyRule(value, index));
}
export async function compileEffectiveProjectPolicy(options) {
    const workspace = await fs.realpath(path.resolve(options.cwd));
    const allowedTaskKinds = normalizeTaskKinds(options.profile?.tasks);
    const normalizedRoots = normalizeRoots(options.profile?.dirs);
    await verifyRoots(workspace, normalizedRoots);
    const roots = operationRoots(normalizedRoots);
    const repositoryDenyRules = canonicalRules(options.repositoryDenyRules ?? []);
    const scopeHash = hash({ allowedTaskKinds, roots });
    return {
        version: 1,
        workspaceRoot: ".",
        allowedTaskKinds,
        roots,
        repositoryDenyRules,
        scopeHash,
        hash: hash({ scopeHash, repositoryDenyRules }),
    };
}
export async function bindProjectPolicy(policy, executionRoot) {
    validatePolicy(policy);
    const root = await fs.realpath(path.resolve(executionRoot));
    const roots = {};
    for (const operation of OPERATIONS) {
        await verifyRoots(root, policy.roots[operation]);
        roots[operation] = await Promise.all(policy.roots[operation].map((prefix) => canonicalPath(path.resolve(root, prefix))));
    }
    return { effective: policy, executionRoot: root, roots };
}
export function assertTaskAdmitted(policy, kind) {
    if (!policy.allowedTaskKinds.includes(kind)) {
        throw rejection("task-kind-not-allowed", "admission", `Task kind '${kind}' is not allowed by this project policy`, policy);
    }
}
export async function assertPathAllowed(policy, operation, candidate) {
    const lexical = path.resolve(policy.executionRoot, candidate);
    if (!isInside(policy.executionRoot, lexical)) {
        throw rejection("project-scope-violation", "preflight", `Path is outside the execution workspace: ${candidate}`, policy.effective, [candidate]);
    }
    let canonical;
    try {
        canonical = await canonicalPath(lexical);
    }
    catch {
        throw rejection("project-scope-violation", "preflight", `Path could not be resolved within an allowed ${operation} root: ${candidate}`, policy.effective, [candidate]);
    }
    if (!isInside(policy.executionRoot, canonical) || !policy.roots[operation].some((root) => isInside(root, canonical))) {
        throw rejection("project-scope-violation", "preflight", `Path escapes an allowed ${operation} root: ${candidate}`, policy.effective, [candidate]);
    }
    return canonical;
}
export async function assertChangedPathsAllowed(policy, changedPaths) {
    const violations = [];
    for (const changedPath of changedPaths) {
        try {
            await assertPathAllowed(policy, "write", changedPath);
        }
        catch (error) {
            if (error instanceof ProjectPolicyError)
                violations.push(changedPath);
            else
                throw error;
        }
    }
    if (violations.length) {
        throw rejection("project-scope-violation", "postflight", "Changed paths exceed allowed write roots", policy.effective, violations);
    }
}
/** Validate a durable effective-policy snapshot before it is bound to a workspace. */
export function assertEffectiveProjectPolicyValid(policy) {
    validatePolicy(policy);
}
export function renderProjectPolicy(policy) {
    const roots = OPERATIONS.map((operation) => `${operation}: ${policy.roots[operation].join(", ")}`).join("; ");
    return `Project policy ${policy.hash}: tasks [${policy.allowedTaskKinds.join(", ")}]; roots [${roots}]`;
}
function normalizeDenyRule(value, index) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Repository policy rule ${index + 1} must be an object`);
    const rule = value;
    if (rule.effect !== "deny")
        throw new Error("Repository policy may only add deny rules");
    if (typeof rule.capability !== "string" || !CAPABILITIES.has(rule.capability)) {
        throw new Error(`Repository policy rule ${index + 1} has an invalid capability`);
    }
    return {
        id: typeof rule.id === "string" && rule.id ? `repo:${rule.id}` : `repo:${index + 1}`,
        effect: "deny",
        capability: rule.capability,
        ...(stringArray(rule.roles) ? { roles: stringArray(rule.roles) } : {}),
        ...(stringArray(rule.taskKinds) ? { taskKinds: stringArray(rule.taskKinds) } : {}),
        ...(typeof rule.pathPrefix === "string" ? { pathPrefix: rule.pathPrefix } : {}),
        ...(typeof rule.domain === "string" ? { domain: rule.domain } : {}),
    };
}
function stringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
function normalizeTaskKinds(tasks) {
    if (!tasks)
        return [...TASK_KINDS].sort();
    const kinds = new Set();
    for (const task of tasks) {
        if (TASK_ALIASES[task])
            TASK_ALIASES[task].forEach((kind) => kinds.add(kind));
        else if (TASK_KINDS.includes(task))
            kinds.add(task);
    }
    if (tasks.length && !kinds.size)
        throw rejection("project-scope-invalid", "admission", "No configured task kinds are valid");
    return [...kinds].sort();
}
function normalizeRoots(dirs) {
    if (dirs === undefined)
        return ["."];
    const roots = dirs.map((dir) => {
        if (typeof dir !== "string" || dir.includes("\0") || dir.includes("\\"))
            throw invalidRoot("contains an invalid value");
        const normalized = dir.replace(/\/+$/, "");
        if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized))
            throw invalidRoot(`'${dir}' is absolute or empty`);
        const segments = normalized.split("/");
        if (segments.some((segment) => !segment || segment === ".."))
            throw invalidRoot(`'${dir}' contains traversal or empty segments`);
        if (segments.some((segment) => segment === ".") && normalized !== ".")
            throw invalidRoot(`'${dir}' contains an invalid dot segment`);
        return normalized;
    }).sort();
    return roots.filter((root, index) => !roots.slice(0, index).some((parent) => parent === root || parent === "." || root.startsWith(`${parent}/`)));
}
function operationRoots(roots) {
    return { read: [...roots], search: [...roots], write: [...roots], shell: [...roots] };
}
async function verifyRoots(workspace, roots) {
    for (const root of roots) {
        const lexical = path.resolve(workspace, root);
        const canonical = await canonicalPath(lexical);
        if (!isInside(workspace, canonical))
            throw invalidRoot(`'${root}' resolves outside the workspace`);
    }
}
async function canonicalPath(candidate) {
    let current = candidate;
    const tail = [];
    while (true) {
        try {
            await fs.lstat(current);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = path.dirname(current);
            if (parent === current)
                throw error;
            tail.push(path.basename(current));
            current = parent;
            continue;
        }
        // Keep realpath outside the ENOENT recovery: an existing dangling symlink must fail resolution.
        return path.join(await fs.realpath(current), ...tail.reverse());
    }
}
function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function compareCodePoints(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
function canonicalRules(rules) {
    return rules.map((rule) => canonicalValue(rule)).sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue).sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareCodePoints(a, b)).map(([key, item]) => [key, canonicalValue(item)]));
    return value;
}
function hash(value) {
    return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}
function validatePolicy(policy) {
    const expectedScope = hash({ allowedTaskKinds: [...policy.allowedTaskKinds].sort(), roots: canonicalValue(policy.roots) });
    const expectedHash = hash({ scopeHash: expectedScope, repositoryDenyRules: canonicalRules(policy.repositoryDenyRules) });
    if (policy.version !== 1 || policy.workspaceRoot !== "." || expectedScope !== policy.scopeHash || expectedHash !== policy.hash) {
        throw rejection("policy-snapshot-invalid", "materialization", "Project policy snapshot is invalid", policy);
    }
}
function invalidRoot(message) {
    return rejection("project-scope-invalid", "admission", `Project root ${message}`);
}
function rejection(errorCode, stage, message, policy, violatingPaths) {
    return new ProjectPolicyError({
        event: "policy-rejected", errorCode, stage, recoverable: false, message, preserved: [],
        nextActions: [{ action: "review-project-policy", label: "Review project policy" }],
        ...(policy ? { policyHash: policy.hash, scopeHash: policy.scopeHash } : {}),
        ...(violatingPaths?.length ? { violatingPaths } : {}),
    });
}
