import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportJobAudit } from "../src/audit/export.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { parseArguments } from "../src/runner/args.js";
import { finishJob, jobDirectory, startJob } from "../src/state/jobs.js";
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
  assert.equal(audit.integrity.policySnapshot?.verified, true);
  assert.equal(audit.integrity.providerSnapshot?.verified, true);
  assert.doesNotMatch(serialized, /sk-(?:prompt|output|verifier|patch)-secret/);
  assert.doesNotMatch(serialized, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(serialized, /user:password@example\.com/);
  assert.doesNotMatch(serialized, /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(serialized, /Do not export this prompt/);
  assert.equal(serialized.includes(cwd), false);
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
