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

interface HostAdjudicationOutcome {
  decision: HostAdjudicationReceipt["decision"] | undefined;
  assessedRisk: HostAdjudicationReceipt["assessedRisk"] | undefined;
  constraints: string[] | undefined;
  fingerprint: string;
  principal: string | undefined;
  host: Host | undefined;
  model: string | undefined;
}

async function adjudicate(host: Host): Promise<HostAdjudicationOutcome> {
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

test("every supported Host applies equivalent Host-first decisions to the same fixture", async () => {
  const hosts: Host[] = ["codex", "claude", "agent-plugin"];
  const results = new Map<Host, HostAdjudicationOutcome>();
  for (const host of hosts) {
    results.set(host, await adjudicate(host));
  }
  const shared = (host: Host) => {
    const result = results.get(host);
    assert.ok(result, `missing adjudication result: ${host}`);
    return {
      decision: result.decision,
      assessedRisk: result.assessedRisk,
      constraints: result.constraints,
      fingerprint: result.fingerprint,
      principal: result.principal,
    };
  };
  for (const host of hosts.slice(1)) {
    assert.deepEqual(shared(host), shared("codex"), `capability lease drift: ${host}`);
  }
  for (const host of hosts) {
    assert.equal(results.get(host)?.host, host);
    assert.equal(results.get(host)?.model, `${host}/fixture-model`);
  }
  assert.equal(new Set(hosts.map((host) => results.get(host)?.model)).size, hosts.length);
});
