import fs from "node:fs/promises";
import path from "node:path";
const CAPABILITIES = new Set([
    "filesystem.read-workspace", "filesystem.write-workspace", "filesystem.write-temp",
    "git.read", "shell.execute", "network.connect",
]);
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
