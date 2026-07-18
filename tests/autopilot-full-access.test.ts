import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { HostAssistancePolicy, SandboxMode } from "../src/core/contracts.js";
import { PolicyEngine } from "../src/policy/engine.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { compileEffectiveProjectPolicy } from "../src/policy/project-policy.js";
import { createUnsandboxedRunner } from "../src/sandbox/runner.js";
import { sandboxModeForReport } from "../src/onboarding/readiness.js";

const baseHostAssistance: HostAssistancePolicy = {
  enabled: true,
  mode: "on",
  contextClasses: ["workspace", "web", "docs", "paper", "connector", "skill"],
  privateConnector: "ask",
  maxRequests: 3,
  maxFanOut: 2,
  reviewMode: "host-first",
  autoApprovalScope: "reversible",
  autoApproveDiscoveryGates: true,
  outwardApprovalGranularity: "each-time",
  autoGitWrites: false,
  autoDelivery: false,
};

async function fullAccessSnapshot(
  workspace: string,
  overrides: Partial<HostAssistancePolicy> = {},
) {
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd: workspace,
    profile: { dirs: ["."], tasks: ["implement"] },
  });
  return createPolicySnapshot({
    sandboxMode: "full-access",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance: { ...baseHostAssistance, ...overrides },
  });
}

test("sandboxModeForReport accepts full-access and keeps legacy values fail-closed", () => {
  assert.equal(sandboxModeForReport("full-access"), "full-access");
  assert.equal(sandboxModeForReport("autopilot"), "autopilot");
  assert.equal(sandboxModeForReport("lenient"), "lenient");
  assert.equal(sandboxModeForReport("nonsense"), "strict");
  assert.equal(sandboxModeForReport(undefined), "strict");
});

test("full-access auto-allows routine shell but keeps immutable hard-denies", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-full-access-"));
  const snapshot = await fullAccessSnapshot(workspace);
  const engine = new PolicyEngine({ snapshot });

  // Routine shell that plain lenient/adaptive would gate now runs unattended.
  for (const command of ["npm run build", "rm foo.txt", "node script.js", "curl https://x"]) {
    const result = await engine.authorize({ toolName: "bash", input: { command }, cwd: workspace });
    assert.equal(result.decision, "allow", command);
  }

  // Without the opt-in, git delivery stays an immutable denial even in full-access.
  const git = await engine.authorize({
    toolName: "bash",
    input: { command: "git commit -m x" },
    cwd: workspace,
  });
  assert.equal(git.decision, "deny");

  // Privilege escalation is never relaxed.
  const sudo = await engine.authorize({
    toolName: "bash",
    input: { command: "sudo rm -rf /" },
    cwd: workspace,
  });
  assert.equal(sudo.decision, "deny");
});

test("autoGitWrites and autoDelivery relax git/deploy to a human approval gate", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-autopilot-"));
  const snapshot = await fullAccessSnapshot(workspace, { autoGitWrites: true, autoDelivery: true });
  const engine = new PolicyEngine({ snapshot });

  const git = await engine.authorize({
    toolName: "bash",
    input: { command: "git push origin main" },
    cwd: workspace,
  });
  assert.equal(git.decision, "require-approval");

  const deploy = await engine.authorize({
    toolName: "bash",
    input: { command: "kubectl apply -f deploy.yaml" },
    cwd: workspace,
  });
  assert.equal(deploy.decision, "require-approval");

  // sudo is still an immutable denial, never a mere approval.
  const sudo = await engine.authorize({
    toolName: "bash",
    input: { command: "sudo systemctl restart x" },
    cwd: workspace,
  });
  assert.equal(sudo.decision, "deny");
});

test("routine-shell bypass is scoped to the autopilot/full-access modes, never adaptive/lenient", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-routine-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd: workspace,
    profile: { dirs: ["."], tasks: ["implement"] },
  });
  const snapshotFor = (sandboxMode: SandboxMode) =>
    createPolicySnapshot({
      sandboxMode,
      approvalMode: "wait",
      rolePolicy: resolveRolePolicy("executor"),
      effectiveProjectPolicy,
      decisionMode: "balance",
      hostAssistance: { ...baseHostAssistance },
    });
  const decide = async (snapshot: ReturnType<typeof snapshotFor>, command: string) =>
    (
      await new PolicyEngine({ snapshot }).authorize({
        toolName: "bash",
        input: { command },
        cwd: workspace,
      })
    ).decision;

  // Lenient and adaptive are unchanged: routine shell still needs approval.
  assert.equal(await decide(snapshotFor("lenient"), "npm run build"), "require-approval");
  assert.equal(await decide(snapshotFor("adaptive"), "npm run build"), "require-approval");
  // The autopilot mode auto-allows routine shell (Lenient isolation, no gate).
  assert.equal(await decide(snapshotFor("autopilot"), "npm run build"), "allow");
  assert.equal(await decide(snapshotFor("autopilot"), "rm foo.txt"), "allow");
  // ...but still denies sudo.
  assert.equal(await decide(snapshotFor("autopilot"), "sudo reboot"), "deny");
});

test("the git opt-in alone does not enable deployment", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-git-only-"));
  const snapshot = await fullAccessSnapshot(workspace, {
    autoGitWrites: true,
    autoDelivery: false,
  });
  const engine = new PolicyEngine({ snapshot });

  const deploy = await engine.authorize({
    toolName: "bash",
    input: { command: "terraform apply" },
    cwd: workspace,
  });
  assert.equal(deploy.decision, "deny");
});

test("the outward opt-in does not relax denials for adaptive mode", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-adaptive-outward-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd: workspace,
    profile: { dirs: ["."], tasks: ["implement"] },
  });
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance: { ...baseHostAssistance, autoGitWrites: true },
  });
  const git = await new PolicyEngine({ snapshot }).authorize({
    toolName: "bash",
    input: { command: "git commit -m x" },
    cwd: workspace,
  });
  assert.equal(git.decision, "deny");
});

test("the outward opt-in does not relax denials for plain lenient mode", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-lenient-outward-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd: workspace,
    profile: { dirs: ["."], tasks: ["implement"] },
  });
  const snapshot = createPolicySnapshot({
    sandboxMode: "lenient",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance: { ...baseHostAssistance, autoGitWrites: true, autoDelivery: true },
  });
  const engine = new PolicyEngine({ snapshot });
  const git = await engine.authorize({
    toolName: "bash",
    input: { command: "git commit -m x" },
    cwd: workspace,
  });
  const deploy = await engine.authorize({
    toolName: "bash",
    input: { command: "kubectl apply -f deploy.yaml" },
    cwd: workspace,
  });
  assert.equal(git.decision, "deny");
  assert.equal(deploy.decision, "deny");
});

test("the full-access runner runs bash without the plugin sandbox and strips plugin secrets", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-unwrapped-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-outside-"));
  const marker = path.join(outside, "written-outside-workspace.txt");
  const runner = await createUnsandboxedRunner({
    cwd: workspace,
    mode: "implement",
    env: { ...process.env, SWARM_PI_CODE_PLUGIN_OPENAI_API_KEY: "must-not-leak" },
  });
  try {
    const tool = runner.createBashTool();
    // Writing outside the workspace proves there is no filesystem sandbox, and the
    // plugin's own secret is absent from the shell environment.
    await tool.execute(
      "unwrapped",
      { command: `printf '%s' "$SWARM_PI_CODE_PLUGIN_OPENAI_API_KEY" > '${marker}'` },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(fs.existsSync(marker), true);
    assert.equal(fs.readFileSync(marker, "utf8"), "");
  } finally {
    await runner.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
