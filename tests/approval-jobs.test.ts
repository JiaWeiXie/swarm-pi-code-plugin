import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { HostAdjudicationReceipt, WorkerAssessment } from "../src/core/contracts.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { compileEffectiveProjectPolicy } from "../src/policy/project-policy.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";
import {
  approveJob,
  createJobLeaseProvider,
  denyJobApproval,
  getJob,
  listJobs,
  readJobRequest,
  recordJobApprovalAdjudication,
  requestJobApproval,
  startJob,
  waitForJob,
} from "../src/state/jobs.js";

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-approval-"));
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
  });
  const job = await startJob(cwd, {
    host: "codex",
    kind: "ask",
    prompt: "inspect",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    approvalMode: "wait",
    policySnapshot: snapshot,
  });
  return { cwd, snapshot, job };
}

test("approval transitions remain non-terminal and create a single-use lease", async () => {
  const { cwd, snapshot, job } = await fixture();
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: "fingerprint",
    toolName: "bash",
    actionSummary: "bash npm test",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["shell.execute"],
      reason: "review",
      constraints: [],
      policyHash: snapshot.hash,
    },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  assert.equal((await getJob(cwd, job.id)).job.status, "awaiting-approval");
  const waiting = await waitForJob(cwd, job.id, 1_000);
  assert.equal("event" in waiting && waiting.event, "approval-required");
  const approved = await approveJob(cwd, job.id, approval.id, "once");
  assert.equal(approved.job.status, "running");
  const leases = createJobLeaseProvider(cwd, job.id);
  const lease = await leases.find("fingerprint", snapshot);
  assert.ok(lease);
  assert.equal(await leases.consume(lease), true);
  assert.equal(await leases.consume(lease), false);
  await assert.rejects(approveJob(cwd, job.id, approval.id), /already consumed|already approved/);
  const approvalNotification = approved.job.notifications?.find((item) => item.kind === "approval");
  assert.ok(approvalNotification);
  assert.equal(approvalNotification.status, "acknowledged");
  assert.equal(approved.approval.notification, "acknowledged");
});

test("denied approvals resume the worker without issuing a lease", async () => {
  const { cwd, snapshot, job } = await fixture();
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: "deny-me",
    toolName: "network",
    actionSummary: "network example.com:443",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["network.connect"],
      reason: "review",
      constraints: [],
      policyHash: snapshot.hash,
    },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const denied = await denyJobApproval(cwd, job.id, approval.id);
  assert.equal(denied.approval.status, "denied");
  assert.equal(denied.job.status, "running");
  assert.equal(await createJobLeaseProvider(cwd, job.id).find("deny-me", snapshot), null);
  assert.equal(denied.approval.notification, "acknowledged");
  assert.equal((await listJobs(cwd, true)).length, 0);
});

test("startJob selects request version 4 for a v2 policy snapshot with model configuration", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-request-v4-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["src"], tasks: ["implementation"] },
  });
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
  });
  const job = await startJob(cwd, {
    host: "codex",
    kind: "implement",
    prompt: "apply",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "executor",
    policySnapshot: snapshot,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const request = await readJobRequest(cwd, job.id);
  assert.equal(request.requestVersion, 4);
  assert.equal(request.policySnapshot?.version, 2);
  const record = (await getJob(cwd, job.id)).job;
  assert.equal(record.policyHash, snapshot.hash);
  assert.equal(record.scopeHash, effectiveProjectPolicy.scopeHash);
});

test("startJob refuses a v2 policy snapshot without model configuration", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-request-v4-guard-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["src"], tasks: ["implementation"] },
  });
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy,
  });
  await assert.rejects(
    startJob(cwd, {
      host: "codex",
      kind: "implement",
      prompt: "apply",
      cwd,
      executionMode: "supervised",
      sandboxMode: "adaptive",
      timeoutMs: 60_000,
      role: "executor",
      policySnapshot: snapshot,
    }),
    /version 2 requires modelConfiguration/,
  );
});

test("startJob keeps legacy request versions for v1 snapshots", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-request-legacy-"));
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
  });
  const withoutModel = await startJob(cwd, {
    host: "codex",
    kind: "ask",
    prompt: "inspect",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    policySnapshot: snapshot,
  });
  assert.equal((await readJobRequest(cwd, withoutModel.id)).requestVersion, 2);
  const withModel = await startJob(cwd, {
    host: "codex",
    kind: "ask",
    prompt: "inspect",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    policySnapshot: snapshot,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const request = await readJobRequest(cwd, withModel.id);
  assert.equal(request.requestVersion, 3);
  assert.equal((await getJob(cwd, withModel.id)).job.policyHash, snapshot.hash);
  assert.equal((await getJob(cwd, withModel.id)).job.scopeHash, undefined);
});

test("startJob persists an optional projectGoal in the durable request", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-request-goal-"));
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
  });
  const common = {
    host: "codex" as const,
    kind: "ask" as const,
    prompt: "inspect",
    cwd,
    executionMode: "supervised" as const,
    sandboxMode: "adaptive" as const,
    timeoutMs: 60_000,
    role: "scout" as const,
    policySnapshot: snapshot,
  };

  const withGoal = await startJob(cwd, { ...common, projectGoal: "ship the widget" });
  assert.equal((await readJobRequest(cwd, withGoal.id)).projectGoal, "ship the widget");

  const withoutGoal = await startJob(cwd, common);
  assert.equal("projectGoal" in (await readJobRequest(cwd, withoutGoal.id)), false);
});

test("a capability lease is bound to the exact policy snapshot, so a scope change invalidates it", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-lease-binding-"));
  const effectiveA = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["src"], tasks: ["implementation"] },
  });
  const snapshotA = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy: effectiveA,
  });
  // Same project scope, different snapshot-affecting setting (sandbox mode): scopeHash equal, snapshot hash differs.
  const snapshotSameScope = createPolicySnapshot({
    sandboxMode: "lenient",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy: effectiveA,
  });
  // Different project scope: both scopeHash and snapshot hash differ.
  const effectiveB = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["lib"], tasks: ["implementation"] },
  });
  const snapshotB = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
    effectiveProjectPolicy: effectiveB,
  });

  const job = await startJob(cwd, {
    host: "codex",
    kind: "implement",
    prompt: "apply",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "executor",
    approvalMode: "wait",
    policySnapshot: snapshotA,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: "write-src",
    toolName: "write",
    actionSummary: "write src/new.ts",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["filesystem.write-workspace"],
      reason: "review",
      constraints: [],
      policyHash: snapshotA.hash,
    },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  // A job-scoped lease so a later rejection cannot be explained by one-shot consumption.
  await approveJob(cwd, job.id, approval.id, "job");
  const leases = createJobLeaseProvider(cwd, job.id);

  // The lease authorizes its action only under the exact granting snapshot.
  assert.ok(await leases.find("write-src", snapshotA));

  // Same scope but a different snapshot hash: not found (matching fingerprint alone is insufficient).
  assert.equal(snapshotSameScope.scopeHash, snapshotA.scopeHash);
  assert.notEqual(snapshotSameScope.hash, snapshotA.hash);
  assert.equal(await leases.find("write-src", snapshotSameScope), null);

  // Changing the project directory scope changes both scopeHash and the complete hash: not found.
  assert.notEqual(snapshotB.scopeHash, snapshotA.scopeHash);
  assert.notEqual(snapshotB.hash, snapshotA.hash);
  assert.equal(await leases.find("write-src", snapshotB), null);
});

test("Host-first can issue one exact reversible lease but cannot expand Strict mode", async () => {
  const assessment: WorkerAssessment = {
    purpose: "Apply the requested bounded source edit.",
    blockedBy: "The adaptive policy requires independent approval for this write.",
    minimumAccess: ["filesystem.write-workspace"],
    targets: ["src/new.ts"],
    sideEffects: ["Create one source file."],
    dataExposure: ["No data leaves the workspace."],
    failureModes: ["The new source file fails typecheck."],
    mitigations: ["Limit the write to one file and run typecheck."],
    reversibility: "reversible",
    rollback: "Delete the newly created job-owned file before delivery.",
    verification: ["Run the targeted typecheck."],
    proposedRisk: "medium",
    fallback: "Leave the request pending for the user.",
  };
  async function createHostFirstJob(sandboxMode: "adaptive" | "strict") {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `swarm-host-lease-${sandboxMode}-`));
    const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
      cwd,
      profile: { dirs: ["src"], tasks: ["implementation"] },
    });
    const snapshot = createPolicySnapshot({
      sandboxMode,
      approvalMode: "wait",
      rolePolicy: resolveRolePolicy("executor"),
      effectiveProjectPolicy,
      decisionMode: "balance",
      hostAssistance: {
        enabled: true,
        mode: "on",
        contextClasses: ["workspace", "web", "docs", "paper", "connector", "skill"],
        privateConnector: "ask",
        maxRequests: 4,
        maxFanOut: 2,
        reviewMode: "host-first",
        autoApprovalScope: "reversible",
        autoApproveDiscoveryGates: true,
      },
    });
    const job = await startJob(cwd, {
      host: "codex",
      kind: "implement",
      prompt: "create src/new.ts",
      cwd,
      executionMode: "supervised",
      sandboxMode,
      timeoutMs: 60_000,
      role: "executor",
      approvalMode: "wait",
      policySnapshot: snapshot,
      modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
    });
    const fingerprint = "a".repeat(64);
    const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
      actionFingerprint: fingerprint,
      toolName: "write",
      actionSummary: "write src/new.ts",
      decision: {
        decision: "require-approval",
        risk: "high",
        capabilities: ["filesystem.write-workspace"],
        reason: "independent review required",
        constraints: ["src/new.ts only"],
        policyHash: snapshot.hash,
      },
      workerAssessment: assessment,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const receipt: HostAdjudicationReceipt = {
      principal: "host-model",
      host: "codex",
      model: "host/test-model",
      decision: "allow",
      assessedRisk: "medium",
      rationale: "The write is bounded, reversible, and already authorized by the task.",
      constraints: ["One exact action", "Run typecheck"],
      intentMatch: true,
      actionFingerprint: fingerprint,
      policyHash: snapshot.hash,
      autoResolved: true,
      decidedAt: new Date().toISOString(),
    };
    return { cwd, job, approval, receipt, snapshot };
  }

  const adaptive = await createHostFirstJob("adaptive");
  const badReceipt = { ...adaptive.receipt, policyHash: "b".repeat(64) };
  await assert.rejects(
    approveJob(adaptive.cwd, adaptive.job.id, adaptive.approval.id, "once", badReceipt),
    /policy hash/,
  );
  const approved = await approveJob(
    adaptive.cwd,
    adaptive.job.id,
    adaptive.approval.id,
    "once",
    adaptive.receipt,
  );
  assert.equal(approved.lease.principal, "host-model");
  assert.equal(approved.lease.scope, "once");
  assert.equal(approved.lease.adjudication?.actionFingerprint, adaptive.receipt.actionFingerprint);
  assert.ok(
    await createJobLeaseProvider(adaptive.cwd, adaptive.job.id).find(
      adaptive.receipt.actionFingerprint,
      adaptive.snapshot,
    ),
  );

  const strict = await createHostFirstJob("strict");
  await assert.rejects(
    approveJob(strict.cwd, strict.job.id, strict.approval.id, "once", strict.receipt),
    /Strict mode/,
  );
  assert.equal((await getJob(strict.cwd, strict.job.id)).job.pendingApprovalId, strict.approval.id);
  const askUserReceipt: HostAdjudicationReceipt = {
    ...strict.receipt,
    decision: "ask-user",
    assessedRisk: "high",
    intentMatch: false,
    autoResolved: false,
    rationale: "Strict mode and the remaining uncertainty require the user's decision.",
  };
  const fallback = await recordJobApprovalAdjudication(
    strict.cwd,
    strict.job.id,
    strict.approval.id,
    askUserReceipt,
  );
  assert.equal(fallback.outcome, "ask-user");
  assert.equal(fallback.approval.status, "pending");
  assert.equal(fallback.job.leases?.length ?? 0, 0);
  const denied = await recordJobApprovalAdjudication(
    strict.cwd,
    strict.job.id,
    strict.approval.id,
    {
      ...askUserReceipt,
      decision: "hard-deny",
      autoResolved: true,
      rationale: "The requested capability must not expand Strict mode.",
    },
  );
  assert.equal(denied.outcome, "hard-deny");
  assert.equal(denied.approval.status, "denied");
  assert.equal(denied.job.leases?.length ?? 0, 0);
});

test("Host-first can independently allow a trusted read-only shell inspection", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-host-readonly-shell-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd,
    profile: { tasks: ["discovery"] },
  });
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("analyst"),
    effectiveProjectPolicy,
    decisionMode: "cost",
    hostAssistance: {
      enabled: true,
      mode: "on",
      contextClasses: ["workspace", "web", "docs", "paper", "connector", "skill"],
      privateConnector: "ask",
      maxRequests: 4,
      maxFanOut: 2,
      reviewMode: "host-first",
      autoApprovalScope: "reversible",
      autoApproveDiscoveryGates: true,
    },
  });
  const job = await startJob(cwd, {
    host: "codex",
    kind: "discover",
    prompt: "inspect repository state",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "analyst",
    approvalMode: "wait",
    policySnapshot: snapshot,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const assessment: WorkerAssessment = {
    purpose: "Inspect tracked repository state without mutation.",
    blockedBy: "The classifier broadened a read-only shell capability.",
    minimumAccess: ["shell.execute"],
    targets: ["git diff -- README.md | grep -E 'rm -rf|git push'"],
    sideEffects: ["No mutation capability is requested."],
    dataExposure: ["No data leaves the workspace."],
    failureModes: ["The inspection command may fail without changing state."],
    mitigations: ["Bind the lease to the exact command fingerprint."],
    reversibility: "read-only",
    rollback: "No rollback is required.",
    verification: ["Confirm the original worktree remains unchanged."],
    proposedRisk: "low",
    fallback: "Leave the request pending for the user.",
  };
  const fingerprint = "c".repeat(64);
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: fingerprint,
    toolName: "bash",
    actionSummary: "bash git diff -- README.md | grep -E 'rm -rf|git push'",
    trustedReadOnly: true,
    effectAssessment: {
      version: 1,
      source: "deterministic-shell",
      effect: "read-only",
      reversibility: "read-only",
      capabilities: ["shell.execute"],
      reasonCode: "read-only-shell",
    },
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["shell.execute"],
      reason: "Classifier failed: classifier broadened capabilities",
      constraints: [],
      policyHash: snapshot.hash,
    },
    workerAssessment: assessment,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const receipt: HostAdjudicationReceipt = {
    principal: "host-model",
    host: "codex",
    model: "host/test-model",
    decision: "allow",
    assessedRisk: "low",
    rationale: "The exact command is a local read-only inspection within the original intent.",
    constraints: ["One exact command", "No network", "No workspace mutation"],
    intentMatch: true,
    actionFingerprint: fingerprint,
    policyHash: snapshot.hash,
    autoResolved: true,
    decidedAt: new Date().toISOString(),
  };
  const approved = await approveJob(cwd, job.id, approval.id, "once", receipt);
  assert.equal(approved.approval.trustedReadOnly, true);
  assert.equal(approved.approval.effectAssessment?.effect, "read-only");
  assert.equal(approved.lease.principal, "host-model");

  const untrustedFingerprint = "d".repeat(64);
  const untrusted = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: untrustedFingerprint,
    toolName: "bash",
    actionSummary: "bash unknown-command",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["shell.execute"],
      reason: "Unknown shell effect",
      constraints: [],
      policyHash: snapshot.hash,
    },
    workerAssessment: { ...assessment, targets: ["unknown-command"] },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  await assert.rejects(
    approveJob(cwd, job.id, untrusted.id, "once", {
      ...receipt,
      actionFingerprint: untrustedFingerprint,
      decidedAt: new Date().toISOString(),
    }),
    /no mutation intent/,
  );
});
