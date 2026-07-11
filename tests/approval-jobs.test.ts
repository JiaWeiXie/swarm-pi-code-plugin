import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import {
  acknowledgeJob,
  approveJob,
  createJobLeaseProvider,
  denyJobApproval,
  getJob,
  listJobs,
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
    host: "codex", kind: "ask", prompt: "inspect", cwd,
    executionMode: "supervised", sandboxMode: "adaptive", timeoutMs: 60_000,
    role: "scout", approvalMode: "wait", policySnapshot: snapshot,
  });
  return { cwd, snapshot, job };
}

test("approval transitions remain non-terminal and create a single-use lease", async () => {
  const { cwd, snapshot, job } = await fixture();
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: "fingerprint", toolName: "bash", actionSummary: "bash npm test",
    decision: { decision: "require-approval", risk: "high", capabilities: ["shell.execute"], reason: "review", constraints: [], policyHash: snapshot.hash },
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
  await acknowledgeJob(cwd, job.id, approvalNotification.id);
});

test("denied approvals resume the worker without issuing a lease", async () => {
  const { cwd, snapshot, job } = await fixture();
  const approval = await requestJobApproval(cwd, job.id, job.workerToken, {
    actionFingerprint: "deny-me", toolName: "network", actionSummary: "network example.com:443",
    decision: { decision: "require-approval", risk: "high", capabilities: ["network.connect"], reason: "review", constraints: [], policyHash: snapshot.hash },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const denied = await denyJobApproval(cwd, job.id, approval.id);
  assert.equal(denied.approval.status, "denied");
  assert.equal(denied.job.status, "running");
  assert.equal(await createJobLeaseProvider(cwd, job.id).find("deny-me", snapshot), null);
  assert.equal((await listJobs(cwd, true)).length, 1);
});
