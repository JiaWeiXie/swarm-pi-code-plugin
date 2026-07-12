import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertPolicySnapshotValid, createPolicySnapshot, defaultRoleForTask, resolveRolePolicy } from "../src/orchestration/roles.js";
import { ClassifierDecisionCache, PolicyEngine, actionFingerprint } from "../src/policy/engine.js";
import { compileEffectiveProjectPolicy, loadRepositoryDenyRules } from "../src/policy/project-policy.js";

test("role registry keeps task compatibility and requested thinking defaults", () => {
  assert.equal(defaultRoleForTask("plan"), "planner");
  assert.equal(resolveRolePolicy("planner").thinkingLevel, "xhigh");
  assert.equal(resolveRolePolicy("reviewer").thinkingLevel, "high");
  assert.equal(resolveRolePolicy("executor").thinkingLevel, "high");
  assert.equal(resolveRolePolicy("project-architect").thinkingLevel, "xhigh");
  assert.equal(resolveRolePolicy("scaffolder").thinkingLevel, "high");
  assert.equal(resolveRolePolicy("environment-engineer").thinkingLevel, "high");
  assert.equal(defaultRoleForTask("scaffold"), "scaffolder");
  assert.equal(defaultRoleForTask("setup"), "environment-engineer");
  assert.deepEqual(resolveRolePolicy("executor", {
    executor: { models: ["test/model"], thinkingLevel: "low", maxAttempts: 9 },
  }).models, ["test/model"]);
  assert.equal(resolveRolePolicy("executor", { executor: { maxAttempts: 9 } }).maxAttempts, 2);
  assert.equal(resolveRolePolicy("mechanical-executor", {}, [], { mechanicalExecutor: true }).executionModes.includes("background"), true);
  assert.equal(resolveRolePolicy("executor", {}, [], { mechanicalExecutor: true }).executionModes.includes("background"), false);
});

test("bootstrap roles separate scaffolding from dependency lifecycle execution", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-bootstrap-policy-"));
  const scaffolder = createPolicySnapshot({ sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("scaffolder") });
  assert.equal((await new PolicyEngine({ snapshot: scaffolder }).authorize({ toolName: "bash", input: { command: "npm install" }, cwd: workspace })).decision, "deny");
  const environment = createPolicySnapshot({ sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("environment-engineer") });
  assert.equal((await new PolicyEngine({ snapshot: environment }).authorize({ toolName: "bash", input: { command: "npm install" }, cwd: workspace })).decision, "require-approval");
  assert.notEqual((await new PolicyEngine({ snapshot: environment }).authorize({ toolName: "bash", input: { command: "npm install --ignore-scripts" }, cwd: workspace })).decision, "allow");
});

test("policy engine enforces hard denies before classifier decisions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-policy-"));
  const rolePolicy = resolveRolePolicy("executor");
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy,
    adaptivePolicy: { classifierModels: ["test/model"] },
  });
  let classifierCalls = 0;
  const engine = new PolicyEngine({
    snapshot,
    classifier: {
      async classify(action) {
        classifierCalls += 1;
        return { decision: "allow", risk: "high", capabilities: action.toolName === "bash" ? ["shell.execute"] : [], reason: "allow", constraints: [], policyHash: snapshot.hash };
      },
    },
  });
  const outside = await engine.authorize({ toolName: "read", input: { path: "/etc/passwd" }, path: "/etc/passwd", cwd: workspace });
  assert.equal(outside.decision, "deny");
  const git = await engine.authorize({ toolName: "bash", input: { command: "git push origin main" }, cwd: workspace });
  assert.equal(git.decision, "deny");
  assert.equal(classifierCalls, 0);
  const bounded = await engine.authorize({ toolName: "bash", input: { command: "npm test" }, cwd: workspace });
  assert.equal(bounded.decision, "require-approval");
  assert.equal(classifierCalls, 1);
});

test("strict mode preserves scoped implementation writes without exposing Bash", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-strict-policy-"));
  const snapshot = createPolicySnapshot({ sandboxMode: "strict", approvalMode: "deny", rolePolicy: resolveRolePolicy("executor") });
  const engine = new PolicyEngine({ snapshot });
  assert.equal((await engine.authorize({ toolName: "write", input: { path: "src/file.ts" }, path: "src/file.ts", cwd: workspace })).decision, "allow");
  assert.equal((await engine.authorize({ toolName: "bash", input: { command: "npm test" }, cwd: workspace })).decision, "deny");
});

test("deny rules override ask and allow rules regardless of declaration order", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-rule-order-"));
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("scout"),
    adaptivePolicy: { rules: [
      { id: "allow", effect: "allow", capability: "network.connect", domain: "example.com" },
      { id: "deny", effect: "deny", capability: "network.connect", domain: "example.com" },
    ] },
  });
  const result = await new PolicyEngine({ snapshot }).authorize({ toolName: "network", input: {}, cwd: workspace, domain: "example.com", port: 443 });
  assert.equal(result.decision, "deny");
  assert.match(result.reason, /deny/);
});

test("v2 policy snapshot embeds the effective project policy and its scope hash", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-snapshot-v2-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({ cwd: workspace, profile: { dirs: ["src"], tasks: ["implementation"] } });
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
  });
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.effectiveProjectPolicy, effectiveProjectPolicy);
  assert.equal(snapshot.scopeHash, effectiveProjectPolicy.scopeHash);
  assert.doesNotThrow(() => assertPolicySnapshotValid(snapshot));
});

test("a snapshot without an effective project policy stays version 1", () => {
  const snapshot = createPolicySnapshot({ sandboxMode: "strict", approvalMode: "deny", rolePolicy: resolveRolePolicy("executor") });
  assert.equal(snapshot.version, 1);
  assert.throws(() => assertPolicySnapshotValid(snapshot), /version 2/);
});

test("snapshot validation rejects tampered fields", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-snapshot-tamper-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({ cwd: workspace, profile: { dirs: ["src"], tasks: ["implementation"] } });
  const base = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
  });
  const clone = () => structuredClone(base);

  const tamperedTaskKinds = clone();
  tamperedTaskKinds.effectiveProjectPolicy.allowedTaskKinds = ["ask"];
  assert.throws(() => assertPolicySnapshotValid(tamperedTaskKinds), /policy-rejected|hash/i);

  const tamperedScope = clone();
  tamperedScope.scopeHash = "0".repeat(64);
  assert.throws(() => assertPolicySnapshotValid(tamperedScope), /scope hash|hash/i);

  const tamperedRole = clone();
  tamperedRole.rolePolicy = resolveRolePolicy("scout");
  assert.throws(() => assertPolicySnapshotValid(tamperedRole), /hash/i);

  const tamperedHash = clone();
  tamperedHash.hash = "0".repeat(64);
  assert.throws(() => assertPolicySnapshotValid(tamperedHash), /hash/i);
});

test("v2 snapshot hash ignores object key insertion order", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-snapshot-order-"));
  const forward = await compileEffectiveProjectPolicy({ cwd: workspace, profile: { dirs: ["lib", "src"], tasks: ["planning", "implementation"] } });
  const reordered = await compileEffectiveProjectPolicy({ cwd: workspace, profile: { dirs: ["src", "lib"], tasks: ["implementation", "planning"] } });
  const left = createPolicySnapshot({ sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("executor"), effectiveProjectPolicy: forward });
  const right = createPolicySnapshot({ sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("executor"), effectiveProjectPolicy: reordered });
  assert.equal(left.hash, right.hash);
});

test("policy fingerprints are stable and repository policy can only deny", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-repo-policy-"));
  const left = actionFingerprint({ toolName: "bash", input: { timeout: 3, command: "npm test" }, cwd: workspace });
  const right = actionFingerprint({ toolName: "bash", input: { command: "npm test", timeout: 3 }, cwd: workspace });
  assert.equal(left, right);
  await fs.writeFile(path.join(workspace, ".swarm-pi-policy.json"), JSON.stringify({
    rules: [{ id: "no-network", effect: "deny", capability: "network.connect", domain: "example.com" }],
  }));
  assert.equal((await loadRepositoryDenyRules(workspace))[0]?.id, "repo:no-network");
  await fs.writeFile(path.join(workspace, ".swarm-pi-policy.json"), JSON.stringify({
    rules: [{ effect: "allow", capability: "network.connect" }],
  }));
  await assert.rejects(loadRepositoryDenyRules(workspace), /only add deny/);
});

test("classifier cache reuses validated approvals but never caches denies", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-classifier-cache-"));
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    adaptivePolicy: { classifierModels: ["test/model"] },
  });
  const cache = new ClassifierDecisionCache();
  let calls = 0;
  const engine = new PolicyEngine({
    snapshot,
    classifierCache: cache,
    classifier: {
      async classify(action) {
        calls += 1;
        return {
          decision: action.input.command === "deny" ? "deny" : "allow",
          risk: action.input.command === "deny" ? "critical" : "high",
          capabilities: ["shell.execute"],
          reason: "classified",
          constraints: [],
          policyHash: snapshot.hash,
        };
      },
    },
  });
  const bounded = { toolName: "bash", input: { command: "npm test" }, cwd: workspace };
  assert.equal((await engine.authorize(bounded)).decision, "require-approval");
  assert.equal((await engine.authorize(bounded)).decision, "require-approval");
  assert.equal(calls, 1);

  const denied = { toolName: "bash", input: { command: "deny" }, cwd: workspace };
  assert.equal((await engine.authorize(denied)).decision, "deny");
  assert.equal((await engine.authorize(denied)).decision, "deny");
  assert.equal(calls, 3);
});

test("classifier cache coalesces concurrent calls and expires entries", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-classifier-singleflight-"));
  const snapshot = createPolicySnapshot({ sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("executor") });
  let now = 1_000;
  const cache = new ClassifierDecisionCache(100, 256, () => now);
  let calls = 0;
  const engine = new PolicyEngine({
    snapshot,
    classifierCache: cache,
    classifier: {
      async classify() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { decision: "allow", risk: "high", capabilities: ["shell.execute"], reason: "classified", constraints: [], policyHash: snapshot.hash };
      },
    },
  });
  const action = { toolName: "bash", input: { command: "npm test" }, cwd: workspace };
  const results = await Promise.all([engine.authorize(action), engine.authorize(action)]);
  assert.deepEqual(results.map((result) => result.decision), ["require-approval", "require-approval"]);
  assert.equal(calls, 1);
  now += 101;
  await engine.authorize(action);
  assert.equal(calls, 2);
});
