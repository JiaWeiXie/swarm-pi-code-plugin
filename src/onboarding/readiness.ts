import type { ReadinessReport, SandboxMode, SetupIssue } from "../core/contracts.js";
import { assessWorkspace } from "../git/worktree.js";
import { detectSandboxAvailability } from "../sandbox/availability.js";
import type { SwarmState } from "../state/state.js";

export async function inspectReadiness(options: {
  cwd: string;
  state: SwarmState;
  modelPriority: string[];
  availableModels: string[];
  registryError?: string | null;
}): Promise<ReadinessReport> {
  const workspace = await assessWorkspace(options.cwd);
  const sandboxMode = options.state.config.sandboxMode ?? "strict";
  const activeModel = options.modelPriority.find((model) => options.availableModels.includes(model)) ?? null;
  const issues: SetupIssue[] = [];
  if (!activeModel) {
    issues.push(issue("no-active-model", "models", "blocking", "No configured Pi model is currently available.", [
      { action: "configure", label: "Open model connections" },
    ]));
  }
  if (options.registryError) {
    issues.push(issue("model-registry-error", "connections", activeModel ? "warning" : "blocking", options.registryError, [
      { action: "doctor", label: "Run connection diagnostics" },
    ]));
  }
  if (sandboxMode !== "strict") {
    const sandbox = detectSandboxAvailability();
    if (!sandbox.available) {
      issues.push(issue("sandbox-backend-unavailable", "execution-safety", "blocking", sandbox.reason ?? "Sandbox backend is unavailable.", [
        { action: "use-strict", label: "Use Strict mode" },
        { action: "doctor", label: "Open sandbox diagnostics" },
      ]));
    }
  }
  if (!workspace.git) {
    issues.push(issue("workspace-not-versioned", "workspace", "warning",
      workspace.disposition === "non-git-empty"
        ? "This folder is not a Git repository; project creation is available."
        : "This existing folder is not a Git repository and requires inspection before adoption.",
      [{ action: workspace.disposition === "non-git-empty" ? "scaffold" : "inspect-adoption", label: workspace.disposition === "non-git-empty" ? "Design a new project" : "Inspect this folder" }],
    ));
  }
  if (workspace.disposition === "user-dirty") {
    issues.push(issue("workspace-user-dirty", "workspace", "warning", "The worktree contains user changes; mutation requires an isolated strategy.", [
      { action: "isolated-head", label: "Run from HEAD" },
      { action: "isolated-snapshot", label: "Include a local snapshot" },
    ]));
  }
  if (workspace.disposition === "unsafe") {
    issues.push(issue("workspace-unsafe", "workspace", "blocking", "The workspace contains conflicts or unsafe filesystem entries.", [
      { action: "inspect-workspace", label: "Review blocking entries" },
    ]));
  }
  const status = issues.some((entry) => entry.severity === "blocking")
    ? "blocked"
    : issues.length > 0
      ? "degraded"
      : "ready";
  return { status, configured: Boolean(activeModel), activeModel, sandboxMode, workspace, issues };
}

function issue(
  code: string,
  stage: SetupIssue["stage"],
  severity: SetupIssue["severity"],
  message: string,
  nextActions: SetupIssue["nextActions"],
): SetupIssue {
  return { code, stage, severity, recoverable: true, message, preserved: ["existing configuration", "original request"], nextActions };
}

export function sandboxModeForReport(value: unknown): SandboxMode {
  return value === "adaptive" || value === "lenient" ? value : "strict";
}
