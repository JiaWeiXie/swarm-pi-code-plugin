import { assessWorkspace } from "../git/worktree.js";
import { detectSandboxAvailability } from "../sandbox/availability.js";
export async function inspectReadiness(options) {
    const workspace = await assessWorkspace(options.cwd);
    const sandboxMode = options.state.config.sandboxMode ?? "strict";
    const activeModel = options.modelPriority.find((model) => options.availableModels.includes(model)) ?? null;
    const issues = [];
    if (!activeModel) {
        issues.push(issue("no-active-model", "models", "blocking", "No configured Pi model is currently available.", [{ action: "configure", label: "Open model connections" }]));
    }
    if (options.registryError) {
        issues.push(issue("model-registry-error", "connections", activeModel ? "warning" : "blocking", options.registryError, [{ action: "doctor", label: "Run connection diagnostics" }]));
    }
    if (activeModel &&
        options.modelPriority.filter((model) => options.availableModels.includes(model)).length < 2) {
        issues.push(issue("no-fallback-model", "models", "warning", "The active model has no available fallback; delegated work cannot recover from a provider outage.", [{ action: "configure", label: "Add a fallback model" }]));
    }
    // full-access needs no sandbox backend (it removes the OS sandbox entirely),
    // so it is grouped with strict here and never blocks on backend availability.
    if (sandboxMode !== "strict" && sandboxMode !== "full-access") {
        const sandbox = detectSandboxAvailability();
        if (!sandbox.available) {
            issues.push(issue("sandbox-backend-unavailable", "execution-safety", "blocking", sandbox.reason ?? "Sandbox backend is unavailable.", [
                { action: "use-strict", label: "Use Strict mode" },
                { action: "doctor", label: "Open sandbox diagnostics" },
            ]));
        }
    }
    if (sandboxMode === "full-access") {
        issues.push(issue("sandbox-full-access", "execution-safety", "warning", "Full-access mode removes the plugin's OS sandbox: the worker's shell runs unconfined by this plugin. Its actual reach depends entirely on the host's own sandbox, which this plugin cannot control. On a default Claude Code session (no /sandbox) the worker has unrestricted access to this machine.", [
            { action: "use-adaptive", label: "Use Adaptive mode instead" },
            { action: "configure", label: "Review execution safety" },
        ]));
    }
    if (sandboxMode === "autopilot") {
        issues.push(issue("sandbox-autopilot", "execution-safety", "warning", "Autopilot keeps the OS sandbox but runs routine shell (build/test, rm/mv/cp, curl/wget, interpreters, redirection) unattended without approval. sudo/su, plugin control paths, secrets, and git metadata stay enforced; git and deployment run only when their outward-boundary options are enabled, always through a human decision.", [{ action: "use-lenient", label: "Use Lenient mode instead" }]));
    }
    if (!workspace.git) {
        issues.push(issue("workspace-not-versioned", "workspace", "warning", workspace.disposition === "non-git-empty"
            ? "This folder is not a Git repository; project creation is available."
            : "This existing folder is not a Git repository and requires inspection before adoption.", [
            {
                action: workspace.disposition === "non-git-empty" ? "scaffold" : "inspect-adoption",
                label: workspace.disposition === "non-git-empty"
                    ? "Design a new project"
                    : "Inspect this folder",
            },
        ]));
    }
    if (workspace.disposition === "git-unborn") {
        const hasUserContent = workspace.entries.some((entry) => entry.category === "user");
        issues.push(issue("workspace-unborn-head", "workspace", "warning", "This Git repository has no initial commit. Read-only work is available, but implementation and delivery require scaffold or adoption first.", hasUserContent
            ? [{ action: "inspect-adoption", label: "Inspect and adopt existing files" }]
            : [{ action: "scaffold", label: "Design the initial project" }]));
    }
    if (workspace.disposition === "user-dirty") {
        issues.push(issue("workspace-user-dirty", "workspace", "warning", "The worktree contains user changes; mutation requires an isolated strategy.", [
            { action: "isolated-head", label: "Run from HEAD" },
            { action: "isolated-snapshot", label: "Include a local snapshot" },
        ]));
    }
    if (workspace.disposition === "unsafe") {
        issues.push(issue("workspace-unsafe", "workspace", "blocking", "The workspace contains conflicts or unsafe filesystem entries.", [{ action: "inspect-workspace", label: "Review blocking entries" }]));
    }
    const status = issues.some((entry) => entry.severity === "blocking")
        ? "blocked"
        : issues.length > 0
            ? "degraded"
            : "ready";
    const commonBlocked = issues.some((entry) => entry.severity === "blocking" && entry.stage !== "workspace");
    const readonlyBlocked = commonBlocked || workspace.disposition === "unsafe";
    const mutationBlocked = readonlyBlocked || workspace.disposition === "git-unborn" || !workspace.git;
    const deliveryBlocked = mutationBlocked || workspace.head === null;
    return {
        status,
        configured: Boolean(activeModel),
        activeModel,
        sandboxMode,
        workspace,
        capabilities: {
            readonly: readonlyBlocked ? "blocked" : "ready",
            mutation: mutationBlocked
                ? "blocked"
                : workspace.disposition === "user-dirty"
                    ? "degraded"
                    : "ready",
            delivery: deliveryBlocked
                ? "blocked"
                : workspace.disposition === "user-dirty"
                    ? "degraded"
                    : "ready",
        },
        issues,
    };
}
function issue(code, stage, severity, message, nextActions) {
    return {
        code,
        stage,
        severity,
        recoverable: true,
        message,
        preserved: ["existing configuration", "original request"],
        nextActions,
    };
}
export function sandboxModeForReport(value) {
    return value === "adaptive" ||
        value === "lenient" ||
        value === "autopilot" ||
        value === "full-access"
        ? value
        : "strict";
}
