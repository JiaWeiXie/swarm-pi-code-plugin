import { isIP } from "node:net";
import path from "node:path";

import type { Capability, PolicyRule, RoleId, TaskKind } from "../core/contracts.js";

export const POLICY_RULE_CAPABILITIES = [
  "filesystem.read-workspace",
  "filesystem.write-workspace",
  "filesystem.write-temp",
  "git.read",
  "shell.execute",
  "network.connect",
] as const satisfies readonly Capability[];

export const POLICY_RULE_ROLES = [
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
  "verifier",
  "classifier",
  "review-coordinator",
  "advisor",
] as const satisfies readonly RoleId[];

export const POLICY_RULE_TASK_KINDS = [
  "ask",
  "review",
  "plan",
  "implement",
  "orchestrate",
  "scaffold",
  "setup",
  "discover",
] as const satisfies readonly TaskKind[];

const EFFECTS = ["deny", "ask", "allow"] as const;
const RULE_KEYS = new Set([
  "id",
  "effect",
  "capability",
  "roles",
  "taskKinds",
  "pathPrefix",
  "domain",
]);
const PATH_CAPABILITIES = new Set<Capability>([
  "filesystem.read-workspace",
  "filesystem.write-workspace",
]);

/** Strictly validate and canonicalize rules used by new saves and new snapshots. */
export function normalizePolicyRulesStrict(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) throw new Error("Adaptive policy rules must be an array");
  if (value.length > 128) throw new Error("Adaptive policy supports at most 128 rules");

  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const rule = normalizePolicyRule(candidate, index);
    if (ids.has(rule.id)) throw ruleError(index, rule.id, "id must be unique");
    ids.add(rule.id);
    return rule;
  });
}

/**
 * Validate a new snapshot while preserving trusted `repo:` IDs already embedded in the
 * effective project policy. Browser/configuration submissions pass no trusted rules, so
 * callers cannot claim the reserved namespace themselves.
 */
export function normalizePolicyRulesForSnapshot(
  value: unknown,
  trustedRepositoryRules: readonly PolicyRule[],
): PolicyRule[] {
  if (!Array.isArray(value)) throw new Error("Adaptive policy rules must be an array");
  if (value.length > 128) throw new Error("Adaptive policy supports at most 128 rules");

  const trusted = new Set(trustedRepositoryRules.map(policyRuleSignature));
  const originalIds = new Map<number, string>();
  const occupiedIds = new Set(
    value.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.id === "string" ? [candidate.id] : [],
    ),
  );
  const rewritten = value.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !candidate.id.startsWith("repo:")
    )
      return candidate;
    if (!trusted.has(policyRuleSignature(candidate))) {
      throw ruleError(
        index,
        candidate.id,
        "reserved repository rule is not present in the effective project policy",
      );
    }
    let replacement = `internal-repository-rule-${index + 1}`;
    while (occupiedIds.has(replacement)) replacement = `${replacement}-internal`;
    occupiedIds.add(replacement);
    originalIds.set(index, candidate.id);
    return { ...candidate, id: replacement };
  });

  return normalizePolicyRulesStrict(rewritten).map((rule, index) =>
    originalIds.has(index) ? { ...rule, id: originalIds.get(index)! } : rule,
  );
}

/**
 * Keep legacy state and snapshots readable without authorizing malformed rules.
 * Invalid or duplicate legacy entries are dropped; new submissions must use the strict API above.
 */
export function normalizePolicyRulesLegacy(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) return [];
  const result: PolicyRule[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of value.slice(0, 128).entries()) {
    try {
      const rule = normalizePolicyRule(candidate, index);
      if (ids.has(rule.id)) continue;
      ids.add(rule.id);
      result.push(rule);
    } catch {
      // Legacy malformed rules fail closed by being omitted from the effective configuration.
    }
  }
  return result;
}

function normalizePolicyRule(value: unknown, index: number): PolicyRule {
  if (!isRecord(value)) throw ruleError(index, undefined, "must be an object");
  const unknown = Object.keys(value).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length > 0)
    throw ruleError(
      index,
      stringValue(value.id),
      `contains unknown fields: ${unknown.sort().join(", ")}`,
    );

  const id = stringValue(value.id);
  if (!id || id.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw ruleError(
      index,
      id,
      "id must be 1–64 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  if (!EFFECTS.includes(value.effect as (typeof EFFECTS)[number])) {
    throw ruleError(index, id, "effect must be deny, ask, or allow");
  }
  if (!POLICY_RULE_CAPABILITIES.includes(value.capability as Capability)) {
    throw ruleError(index, id, "capability is not supported");
  }

  const capability = value.capability as Capability;
  const roles = optionalSelector(value.roles, POLICY_RULE_ROLES, index, id, "roles");
  const taskKinds = optionalSelector(
    value.taskKinds,
    POLICY_RULE_TASK_KINDS,
    index,
    id,
    "taskKinds",
  );
  const pathPrefix = optionalPathPrefix(value.pathPrefix, capability, index, id);
  const domain = optionalDomain(value.domain, capability, index, id);
  if (pathPrefix && domain)
    throw ruleError(index, id, "cannot combine pathPrefix and domain selectors");

  return {
    id,
    effect: value.effect as PolicyRule["effect"],
    capability,
    ...(roles ? { roles } : {}),
    ...(taskKinds ? { taskKinds } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(domain ? { domain } : {}),
  };
}

function optionalSelector<T extends string>(
  value: unknown,
  allowed: readonly T[],
  index: number,
  id: string,
  field: "roles" | "taskKinds",
): T[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw ruleError(index, id, `${field} must be a non-empty string array`);
  }
  const invalid = value.filter((item) => !allowed.includes(item as T));
  if (invalid.length > 0)
    throw ruleError(
      index,
      id,
      `${field} contains unsupported values: ${[...new Set(invalid)].sort().join(", ")}`,
    );
  if (new Set(value).size !== value.length)
    throw ruleError(index, id, `${field} must not contain duplicates`);
  return [...value] as T[];
}

function optionalPathPrefix(
  value: unknown,
  capability: Capability,
  index: number,
  id: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value !== value.trim())
    throw ruleError(index, id, "pathPrefix must be a non-empty canonical relative path");
  if (!PATH_CAPABILITIES.has(capability)) {
    throw ruleError(
      index,
      id,
      "pathPrefix is only valid for filesystem.read-workspace or filesystem.write-workspace",
    );
  }
  if (
    value === "." ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw ruleError(
      index,
      id,
      "pathPrefix must be a canonical POSIX workspace-relative path without traversal or a trailing slash",
    );
  }
  return value;
}

function optionalDomain(
  value: unknown,
  capability: Capability,
  index: number,
  id: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    throw ruleError(index, id, "domain must be a non-empty hostname");
  if (capability !== "network.connect")
    throw ruleError(index, id, "domain is only valid for network.connect");

  let domain = value.trim().toLowerCase();
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  const wildcard = domain.startsWith("*.");
  const hostname = wildcard ? domain.slice(2) : domain;
  const labels = hostname.split(".");
  if (
    !hostname ||
    domain.length > 253 ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw ruleError(
      index,
      id,
      "domain must be a lowercase hostname or *.hostname without a URL, port, IP, localhost, or credentials",
    );
  }
  return `${wildcard ? "*." : ""}${hostname}`;
}

function ruleError(index: number, id: string | undefined, message: string): Error {
  return new Error(`Adaptive policy rule ${index + 1}${id ? ` (${id})` : ""}: ${message}`);
}

function policyRuleSignature(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(canonicalValue)
      .sort((left, right) => compareCodePoints(JSON.stringify(left), JSON.stringify(right)));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
