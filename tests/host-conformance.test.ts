import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  Host,
  HostAdjudicationReceipt,
  HostAssistancePolicy,
  WorkerAssessment,
} from "../src/core/contracts.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { compileEffectiveProjectPolicy } from "../src/policy/project-policy.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";
import { approveJob, requestJobApproval, startJob } from "../src/state/jobs.js";

const hostPolicy: HostAssistancePolicy = {
  enabled: true,
  mode: "on",
  contextClasses: ["workspace", "web", "docs", "paper", "connector", "skill"],
  privateConnector: "ask",
  maxRequests: 4,
  maxFanOut: 2,
  reviewMode: "host-first",
  autoApprovalScope: "read-only",
  autoApproveDiscoveryGates: true,
};

const assessment: WorkerAssessment = {
  purpose: "Read one project source file for the requested analysis.",
  blockedBy: "The adaptive policy requested independent confirmation.",
  minimumAccess: ["filesystem.read-workspace"],
  targets: ["src/example.ts"],
  sideEffects: ["No mutation."],
  dataExposure: ["Project-internal source remains local."],
  failureModes: ["The file is absent or outside the configured root."],
  mitigations: ["Use the exact relative target and stop on a scope error."],
  reversibility: "read-only",
  rollback: "No state changes are made.",
  verification: ["Confirm the target and policy hash before reading."],
  proposedRisk: "low",
  fallback: "Ask the user or continue without the file.",
};

async function adjudicate(host: Host) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `swarm-host-conformance-${host}-`));
  await fs.mkdir(path.join(cwd, "src"));
  await fs.writeFile(path.join(cwd, "src/example.ts"), "export const fixture = true;\n");
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["src"], tasks: ["analysis"] },
  });
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance: hostPolicy,
  });
  const job = await startJob(cwd, {
    host,
    kind: "ask",
    prompt: "Inspect src/example.ts without modifying it.",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    approvalMode: "wait",
    policySnapshot: snapshot,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const fingerprint = "c".repeat(64);
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: fingerprint,
    toolName: "read",
    actionSummary: "read src/example.ts",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["filesystem.read-workspace"],
      reason: "fixture requires Host review",
      constraints: ["src/example.ts only"],
      policyHash: snapshot.hash,
    },
    workerAssessment: assessment,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const receipt: HostAdjudicationReceipt = {
    principal: "host-model",
    host,
    model: `${host}/fixture-model`,
    decision: "allow",
    assessedRisk: "low",
    rationale: "The exact read-only action matches the original intent and project root.",
    constraints: ["src/example.ts only", "No mutation"],
    intentMatch: true,
    actionFingerprint: fingerprint,
    policyHash: snapshot.hash,
    autoResolved: true,
    decidedAt: new Date().toISOString(),
  };
  const result = await approveJob(cwd, job.id, approval.id, "once", receipt);
  return {
    decision: result.lease.adjudication?.decision,
    assessedRisk: result.lease.adjudication?.assessedRisk,
    constraints: result.lease.adjudication?.constraints,
    fingerprint: result.lease.actionFingerprint,
    principal: result.lease.principal,
    host: result.lease.adjudication?.host,
    model: result.lease.adjudication?.model,
  };
}

test("Codex and Claude apply equivalent Host-first decisions to the same fixture", async () => {
  const codex = await adjudicate("codex");
  const claude = await adjudicate("claude");
  assert.deepEqual(
    {
      decision: codex.decision,
      assessedRisk: codex.assessedRisk,
      constraints: codex.constraints,
      fingerprint: codex.fingerprint,
      principal: codex.principal,
    },
    {
      decision: claude.decision,
      assessedRisk: claude.assessedRisk,
      constraints: claude.constraints,
      fingerprint: claude.fingerprint,
      principal: claude.principal,
    },
  );
  assert.equal(codex.host, "codex");
  assert.equal(claude.host, "claude");
  assert.notEqual(codex.model, claude.model);
});
