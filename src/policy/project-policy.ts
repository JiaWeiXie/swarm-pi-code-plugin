import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  BoundProjectPolicy,
  Capability,
  EffectiveProjectPolicy,
  PolicyRule,
  ProjectOperation,
  ProjectPolicyRejection,
  RoleId,
  TaskKind,
} from "../core/contracts.js";
import type { SwarmProfile } from "../state/state.js";

const CAPABILITIES = new Set<Capability>([
  "filesystem.read-workspace", "filesystem.write-workspace", "filesystem.write-temp",
  "git.read", "shell.execute", "network.connect",
]);

const TASK_KINDS: TaskKind[] = ["ask", "review", "plan", "implement", "orchestrate", "scaffold", "setup"];
const OPERATIONS: ProjectOperation[] = ["read", "search", "write", "shell"];
const TASK_ALIASES: Record<string, TaskKind[]> = {
  implementation: ["implement"],
  planning: ["plan"],
  "code-review": ["review"],
  analysis: ["ask", "orchestrate"],
  scaffolding: ["scaffold"],
  "development-setup": ["setup"],
};

/** An error suitable for serialization by later policy enforcement phases. */
export class ProjectPolicyError extends Error {
  constructor(readonly rejection: ProjectPolicyRejection) {
    super(rejection.message);
    this.name = "ProjectPolicyError";
  }
}

export async function loadRepositoryDenyRules(cwd: string): Promise<PolicyRule[]> {
  const file = path.join(cwd, ".swarm-pi-policy.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Invalid repository policy: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Repository policy must be an object");
  const rules = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(rules) || rules.length > 128) throw new Error("Repository policy rules must be an array of at most 128 entries");
  return rules.map((value, index) => normalizeDenyRule(value, index));
}

export async function compileEffectiveProjectPolicy(options: {
  cwd: string;
  profile?: SwarmProfile;
  repositoryDenyRules?: PolicyRule[];
}): Promise<EffectiveProjectPolicy> {
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

export async function bindProjectPolicy(
  policy: EffectiveProjectPolicy,
  executionRoot: string,
): Promise<BoundProjectPolicy> {
  validatePolicy(policy);
  const root = await fs.realpath(path.resolve(executionRoot));
  const roots = {} as Record<ProjectOperation, string[]>;
  for (const operation of OPERATIONS) {
    await verifyRoots(root, policy.roots[operation]);
    roots[operation] = await Promise.all(policy.roots[operation].map((prefix) => canonicalPath(path.resolve(root, prefix))));
  }
  return { effective: policy, executionRoot: root, roots };
}

export function assertTaskAdmitted(policy: EffectiveProjectPolicy, kind: TaskKind): void {
  if (!policy.allowedTaskKinds.includes(kind)) {
    throw rejection("task-kind-not-allowed", "admission", `Task kind '${kind}' is not allowed by this project policy`, policy);
  }
}

export async function assertPathAllowed(
  policy: BoundProjectPolicy,
  operation: ProjectOperation,
  candidate: string,
): Promise<string> {
  const lexical = path.resolve(policy.executionRoot, candidate);
  if (!isInside(policy.executionRoot, lexical)) {
    throw rejection("project-scope-violation", "preflight", `Path is outside the execution workspace: ${candidate}`, policy.effective, [candidate]);
  }
  let canonical: string;
  try {
    canonical = await canonicalPath(lexical);
  } catch {
    throw rejection("project-scope-violation", "preflight", `Path could not be resolved within an allowed ${operation} root: ${candidate}`, policy.effective, [candidate]);
  }
  if (!isInside(policy.executionRoot, canonical) || !policy.roots[operation].some((root) => isInside(root, canonical))) {
    throw rejection("project-scope-violation", "preflight", `Path escapes an allowed ${operation} root: ${candidate}`, policy.effective, [candidate]);
  }
  return canonical;
}

export async function assertChangedPathsAllowed(policy: BoundProjectPolicy, changedPaths: string[]): Promise<void> {
  const violations: string[] = [];
  for (const changedPath of changedPaths) {
    try {
      await assertPathAllowed(policy, "write", changedPath);
    } catch (error) {
      if (error instanceof ProjectPolicyError) violations.push(changedPath);
      else throw error;
    }
  }
  if (violations.length) {
    throw rejection("project-scope-violation", "postflight", "Changed paths exceed allowed write roots", policy.effective, violations);
  }
}

export function renderProjectPolicy(policy: EffectiveProjectPolicy): string {
  const roots = OPERATIONS.map((operation) => `${operation}: ${policy.roots[operation].join(", ")}`).join("; ");
  return `Project policy ${policy.hash}: tasks [${policy.allowedTaskKinds.join(", ")}]; roots [${roots}]`;
}

function normalizeDenyRule(value: unknown, index: number): PolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Repository policy rule ${index + 1} must be an object`);
  const rule = value as Record<string, unknown>;
  if (rule.effect !== "deny") throw new Error("Repository policy may only add deny rules");
  if (typeof rule.capability !== "string" || !CAPABILITIES.has(rule.capability as Capability)) {
    throw new Error(`Repository policy rule ${index + 1} has an invalid capability`);
  }
  return {
    id: typeof rule.id === "string" && rule.id ? `repo:${rule.id}` : `repo:${index + 1}`,
    effect: "deny",
    capability: rule.capability as Capability,
    ...(stringArray(rule.roles) ? { roles: stringArray(rule.roles) as RoleId[] } : {}),
    ...(stringArray(rule.taskKinds) ? { taskKinds: stringArray(rule.taskKinds) as TaskKind[] } : {}),
    ...(typeof rule.pathPrefix === "string" ? { pathPrefix: rule.pathPrefix } : {}),
    ...(typeof rule.domain === "string" ? { domain: rule.domain } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function normalizeTaskKinds(tasks: string[] | undefined): TaskKind[] {
  if (!tasks) return [...TASK_KINDS].sort();
  const kinds = new Set<TaskKind>();
  for (const task of tasks) {
    if (TASK_ALIASES[task]) TASK_ALIASES[task].forEach((kind) => kinds.add(kind));
    else if ((TASK_KINDS as string[]).includes(task)) kinds.add(task as TaskKind);
  }
  if (tasks.length && !kinds.size) throw rejection("project-scope-invalid", "admission", "No configured task kinds are valid");
  return [...kinds].sort();
}

function normalizeRoots(dirs: string[] | undefined): string[] {
  if (dirs === undefined) return ["."];
  const roots = dirs.map((dir) => {
    if (typeof dir !== "string" || dir.includes("\0") || dir.includes("\\")) throw invalidRoot("contains an invalid value");
    const normalized = dir.replace(/\/+$/, "");
    if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) throw invalidRoot(`'${dir}' is absolute or empty`);
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "..")) throw invalidRoot(`'${dir}' contains traversal or empty segments`);
    if (segments.some((segment) => segment === ".") && normalized !== ".") throw invalidRoot(`'${dir}' contains an invalid dot segment`);
    return normalized;
  }).sort();
  return roots.filter((root, index) => !roots.slice(0, index).some((parent) => parent === root || parent === "." || root.startsWith(`${parent}/`)));
}

function operationRoots(roots: string[]): Record<ProjectOperation, string[]> {
  return { read: [...roots], search: [...roots], write: [...roots], shell: [...roots] };
}

async function verifyRoots(workspace: string, roots: string[]): Promise<void> {
  for (const root of roots) {
    const lexical = path.resolve(workspace, root);
    const canonical = await canonicalPath(lexical);
    if (!isInside(workspace, canonical)) throw invalidRoot(`'${root}' resolves outside the workspace`);
  }
}

async function canonicalPath(candidate: string): Promise<string> {
  let current = candidate;
  const tail: string[] = [];
  while (true) {
    try {
      await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
      continue;
    }
    // Keep realpath outside the ENOENT recovery: an existing dangling symlink must fail resolution.
    return path.join(await fs.realpath(current), ...tail.reverse());
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalRules(rules: PolicyRule[]): PolicyRule[] {
  return rules.map((rule) => canonicalValue(rule) as PolicyRule).sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue).sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareCodePoints(a, b)).map(([key, item]) => [key, canonicalValue(item)]));
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function validatePolicy(policy: EffectiveProjectPolicy): void {
  const expectedScope = hash({ allowedTaskKinds: [...policy.allowedTaskKinds].sort(), roots: canonicalValue(policy.roots) });
  const expectedHash = hash({ scopeHash: expectedScope, repositoryDenyRules: canonicalRules(policy.repositoryDenyRules) });
  if (policy.version !== 1 || policy.workspaceRoot !== "." || expectedScope !== policy.scopeHash || expectedHash !== policy.hash) {
    throw rejection("policy-snapshot-invalid", "materialization", "Project policy snapshot is invalid", policy);
  }
}

function invalidRoot(message: string): ProjectPolicyError {
  return rejection("project-scope-invalid", "admission", `Project root ${message}`);
}

function rejection(
  errorCode: ProjectPolicyRejection["errorCode"],
  stage: ProjectPolicyRejection["stage"],
  message: string,
  policy?: EffectiveProjectPolicy,
  violatingPaths?: string[],
): ProjectPolicyError {
  return new ProjectPolicyError({
    event: "policy-rejected", errorCode, stage, recoverable: false, message, preserved: [],
    nextActions: [{ action: "review-project-policy", label: "Review project policy" }],
    ...(policy ? { policyHash: policy.hash, scopeHash: policy.scopeHash } : {}),
    ...(violatingPaths?.length ? { violatingPaths } : {}),
  });
}
