import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportJobAudit } from "../src/audit/export.js";
import type { HostAssistancePolicy, WorkerAssessment } from "../src/core/contracts.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { compileEffectiveProjectPolicy } from "../src/policy/project-policy.js";
import { parseArguments } from "../src/runner/args.js";
import {
  approveJob,
  finishJob,
  jobDirectory,
  requestJobApproval,
  requestJobHostAssistance,
  resolveJobHostRequest,
  startJob,
} from "../src/state/jobs.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";

async function terminalFixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-audit-"));
  const policySnapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("executor"),
  });
  const modelConfiguration = defaultModelConfiguration();
  const job = await startJob(cwd, {
    host: "codex",
    kind: "implement",
    prompt: `Do not export this prompt secret=sk-prompt-secret ${cwd}`,
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "executor",
    approvalMode: "wait",
    policySnapshot,
    modelConfiguration,
  });
  await finishJob(
    cwd,
    job.id,
    {
      kind: "implement",
      status: "succeeded",
      success: true,
      output: `raw agent output secret=sk-output-secret ${cwd}`,
      model: "test/model",
      changedFiles: ["src/example.ts"],
      diffStat: "1 file changed",
      verification: { status: "passed", commands: ["mise run check"] },
      agentVerification: {
        status: "passed",
        output: "VERIFIED token=sk-verifier-secret",
        model: "test/verifier",
      },
      artifact: {
        worktree: `${cwd}/.worktree`,
        branch: "swarm/test",
        commit: "abc123",
        deliverable: true,
        kind: "implementation",
      },
    },
    `diff --git a/src/example.ts b/src/example.ts\n+const token = "sk-patch-secret";\n+const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";\n+const url = "https://user:password@example.com";\n+const key = "-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----";\n+// workspace ${cwd}\n`,
  );
  const directory = await jobDirectory(cwd, job.id);
  await fs.writeFile(
    path.join(directory, "policy-events.jsonl"),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      tool: "bash",
      fingerprint: "fingerprint",
      decision: "require-approval",
      risk: "high",
      reason: "Review bounded command",
      policyHash: policySnapshot.hash,
      classifierCache: "miss",
      classifierEvidence: {
        claimedCapabilities: ["shell.execute", "filesystem.read-workspace"],
        runtimeCapabilities: ["shell.execute"],
        normalized: true,
      },
    })}\n`,
  );
  return { cwd, job, directory };
}

test("audit export returns a safe single-job evidence package", async () => {
  const { cwd, job } = await terminalFixture();
  const audit = await exportJobAudit(cwd, job.id);
  const serialized = JSON.stringify(audit);
  assert.equal(audit.schema, "swarm-pi-code-plugin/job-audit");
  assert.equal(audit.version, 1);
  assert.equal(audit.job.status, "succeeded");
  assert.equal((audit.result as unknown as Record<string, unknown>).output, undefined);
  assert.equal(audit.result.agentVerification?.output.includes("[redacted]"), true);
  assert.equal(audit.changes.patch?.includes("[redacted]"), true);
  assert.equal(audit.policy.events[0]?.classifierCache, "miss");
  assert.equal(audit.policy.events[0]?.classifierEvidence?.normalized, true);
  assert.equal(audit.integrity.policySnapshot?.verified, true);
  assert.equal(audit.integrity.providerSnapshot?.verified, true);
  assert.doesNotMatch(serialized, /sk-(?:prompt|output|verifier|patch)-secret/);
  assert.doesNotMatch(serialized, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(serialized, /user:password@example\.com/);
  assert.doesNotMatch(serialized, /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(serialized, /Do not export this prompt/);
  assert.equal(serialized.includes(cwd), false);
});

test("audit export includes redacted WorkerAssessment, Host receipts, and lease principal", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-audit-host-first-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["."], tasks: ["analysis"] },
  });
  const hostAssistance: HostAssistancePolicy = {
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
  const policySnapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance,
  });
  const modelConfiguration = defaultModelConfiguration(["test-provider/test-model"]);
  const job = await startJob(cwd, {
    host: "codex",
    kind: "ask",
    prompt: "Read one local file and obtain public documentation.",
    cwd,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    approvalMode: "wait",
    policySnapshot,
    modelConfiguration,
  });
  const assessment: WorkerAssessment = {
    purpose: "Read bounded evidence for the current analysis.",
    blockedBy: "Independent Host review is required.",
    minimumAccess: ["filesystem.read-workspace"],
    targets: ["README.md"],
    sideEffects: ["No mutation."],
    dataExposure: ["Public documentation only."],
    failureModes: ["Evidence is stale."],
    mitigations: ["Require a dated citation."],
    reversibility: "read-only",
    rollback: "No state changes are made.",
    verification: ["Verify the citation and exact target."],
    proposedRisk: "low",
    fallback: "Continue without the missing evidence.",
  };
  const approvalFingerprint = "d".repeat(64);
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: approvalFingerprint,
    toolName: "read",
    actionSummary: "read README.md",
    effectAssessment: {
      version: 1,
      source: "deterministic-tool",
      effect: "read-only",
      reversibility: "read-only",
      capabilities: ["filesystem.read-workspace"],
      reasonCode: "read-only-tool",
    },
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["filesystem.read-workspace"],
      reason: "fixture",
      constraints: ["README.md only"],
      policyHash: policySnapshot.hash,
    },
    workerAssessment: assessment,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const receiptBase = {
    principal: "host-model" as const,
    host: "codex" as const,
    model: "host/test-model",
    decision: "allow" as const,
    assessedRisk: "low" as const,
    rationale: "The request is bounded, read-only, and matches the original task.",
    constraints: ["Read-only"],
    intentMatch: true,
    policyHash: policySnapshot.hash,
    autoResolved: true,
    decidedAt: new Date().toISOString(),
  };
  await approveJob(cwd, job.id, approval.id, "once", {
    ...receiptBase,
    actionFingerprint: approvalFingerprint,
  });
  const hostRequest = await requestJobHostAssistance(cwd, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "audit", attempt: 1 },
    request: {
      kind: "context",
      contextClass: "docs",
      question: "Find the public documentation.",
      unknowns: ["current behavior"],
      acceptanceCriteria: ["dated public citation"],
      dataClassification: "public",
      egressAllowed: true,
      budget: 1,
      workerAssessment: assessment,
    },
    policy: hostAssistance,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await resolveJobHostRequest(
    cwd,
    job.id,
    hostRequest.id,
    {
      requestId: hostRequest.id,
      answer: "Public answer.",
      claims: [],
      citations: [],
      provenance: ["public fixture"],
    },
    { ...receiptBase, actionFingerprint: hostRequest.actionFingerprint },
  );
  await finishJob(cwd, job.id, {
    kind: "ask",
    status: "succeeded",
    success: true,
    output: "done",
    model: "test-provider/test-model",
    changedFiles: [],
    diffStat: "",
    verification: { status: "passed", commands: [] },
  });
  const audit = await exportJobAudit(cwd, job.id);
  assert.equal(audit.approvals[0]?.workerAssessment?.reversibility, "read-only");
  assert.equal(audit.approvals[0]?.effectAssessment?.reasonCode, "read-only-tool");
  assert.equal(audit.approvals[0]?.adjudication?.principal, "host-model");
  assert.equal(audit.leases[0]?.principal, "host-model");
  assert.equal(
    audit.hostAssistance[0]?.request.workerAssessment?.verification[0],
    "Verify the citation and exact target.",
  );
  assert.equal(audit.hostAssistance[0]?.adjudication?.actionFingerprint.length, 64);
  assert.equal(audit.result.hostAdjudications?.length, 2);
  assert.deepEqual(audit.result.hostAdjudications?.map((item) => item.source).sort(), [
    "approval",
    "host-assistance",
  ]);
});

test("audit export rejects non-terminal jobs, malformed events, and traversal ids", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-audit-invalid-"));
  const policySnapshot = createPolicySnapshot({
    sandboxMode: "strict",
    approvalMode: "deny",
    rolePolicy: resolveRolePolicy("scout"),
  });
  const job = await startJob(cwd, {
    host: "codex",
    kind: "ask",
    prompt: "inspect",
    cwd,
    executionMode: "supervised",
    sandboxMode: "strict",
    timeoutMs: 60_000,
    role: "scout",
    policySnapshot,
  });
  await assert.rejects(exportJobAudit(cwd, job.id), /not terminal/);
  await assert.rejects(exportJobAudit(cwd, "../outside"), /Invalid job id/);

  const terminal = await terminalFixture();
  await fs.writeFile(path.join(terminal.directory, "policy-events.jsonl"), "not-json\n");
  await assert.rejects(exportJobAudit(terminal.cwd, terminal.job.id), /malformed JSON/);
});

test("audit CLI requires --audit and a job id", () => {
  assert.deepEqual(
    parseArguments(["jobs", "export", "--audit", "--job", "job-1", "--json"]).audit,
    true,
  );
  assert.throws(() => parseArguments(["jobs", "export", "--job", "job-1"]), /requires --audit/);
  assert.throws(() => parseArguments(["jobs", "export", "--audit"]), /requires --job/);
  assert.throws(() => parseArguments(["jobs", "list", "--audit"]), /only supported/);
});
