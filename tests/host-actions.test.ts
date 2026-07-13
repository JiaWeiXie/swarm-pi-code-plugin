import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PiModel } from "../src/pi/models.js";
import {
  createPolicySnapshot,
  normalizeAdaptivePolicy,
  resolveRolePolicy,
} from "../src/orchestration/roles.js";
import { runCommand, type RunnerDependencies } from "../src/runner/run.js";
import {
  finishJob,
  getJob,
  requestJobHostAssistance,
  resolveJobHostRequest,
  startJob,
  waitForHostAssistanceResolution,
} from "../src/state/jobs.js";
import { defaultHostActionPolicy } from "../src/state/state.js";
import { assertHostActionAllowed, createActionFamilyLease } from "../src/host-actions/policy.js";

const fakeModel = { provider: "test-provider", id: "test-model", name: "Test Model" } as PiModel;

test("Host Action policy requires mutation intent and keeps remote actions disabled", () => {
  const recommendation = {
    kind: "action-recommendation" as const,
    actionClass: "deploy" as const,
    summary: "deploy",
    rationale: "requested",
    expectedEvidence: ["receipt"],
    dataClassification: "project-internal" as const,
  };
  assert.throws(
    () =>
      assertHostActionAllowed({
        recommendation,
        parentKind: "review",
        policy: defaultHostActionPolicy(),
      }),
    /mutation intent/,
  );
  assert.throws(
    () =>
      assertHostActionAllowed({
        recommendation,
        parentKind: "implement",
        policy: defaultHostActionPolicy(),
      }),
    /disabled/,
  );
});

test("recorded local recommendation runs once in an isolated host-broker child", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-action-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    ],
    { cwd: workspace },
  );
  const rolePolicy = resolveRolePolicy("executor", {}, ["test-provider/test-model"]);
  const snapshot = createPolicySnapshot({
    sandboxMode: "strict",
    approvalMode: "wait",
    rolePolicy,
    adaptivePolicy: normalizeAdaptivePolicy(undefined),
  });
  const parent = await startJob(workspace, {
    host: "codex",
    kind: "implement",
    prompt: "Implement the requested local change",
    cwd: workspace,
    executionMode: "supervised",
    sandboxMode: "strict",
    timeoutMs: 60_000,
    role: "executor",
    thinkingLevel: rolePolicy.thinkingLevel,
    approvalMode: "wait",
    policySnapshot: snapshot,
  });
  const recommendation = {
    kind: "action-recommendation" as const,
    actionClass: "local-mutation" as const,
    summary: "Create action.txt",
    rationale: "Prove isolated Host Action execution",
    expectedEvidence: ["action.txt exists in child artifact"],
    dataClassification: "project-internal" as const,
  };
  const request = await requestJobHostAssistance(workspace, parent.id, parent.workerToken, {
    correlation: { jobId: parent.id, generation: 1, sessionId: "parent", attempt: 1 },
    request: recommendation,
    policy: {
      enabled: true,
      mode: "on",
      contextClasses: ["workspace"],
      privateConnector: "deny",
      maxRequests: 2,
      maxFanOut: 1,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await resolveJobHostRequest(workspace, parent.id, request.id, {
    kind: "action-recommendation",
    requestId: request.id,
    status: "recorded",
    message: "Explicitly recorded by Host",
    recordedAt: new Date().toISOString(),
    hash: "host-input-is-rehashed",
  });
  await waitForHostAssistanceResolution(workspace, parent.id, parent.workerToken, request.id);
  await finishJob(workspace, parent.id, {
    kind: "implement",
    status: "succeeded",
    success: true,
    output: "checkpoint",
    model: "test-provider/test-model",
    changedFiles: [],
    diffStat: "",
    verification: { status: "passed", commands: [] },
  });

  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "",
    createSession: async ({ cwd, mode }) => ({
      subscribe(listener) {
        const output =
          mode === "implement"
            ? "implemented"
            : "VERIFIED isolated action matches the recommendation";
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: output },
        });
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (mode === "implement") fs.writeFileSync(path.join(cwd, "action.txt"), "isolated\n");
      },
      dispose() {},
    }),
  };
  const result = await runCommand(
    {
      command: "jobs",
      jobsAction: "action-start",
      jobId: parent.id,
      hostRequestId: request.id,
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );
  assert.equal("success" in result && result.success, true);
  assert.equal("artifact" in result && result.artifact?.kind, "host-action");
  assert.equal("hostAction" in result && result.hostAction?.principal, "host-broker");
  assert.equal(fs.existsSync(path.join(workspace, "action.txt")), false);
  const childId = "jobId" in result ? result.jobId : undefined;
  assert.ok(childId);
  const child = await getJob(workspace, childId);
  assert.equal(child.job.parentJobId, parent.id);
  assert.equal(child.job.recommendationId, request.id);
  assert.equal(child.job.leases?.[0]?.actionFamily?.used, 1);
  await assert.rejects(
    () =>
      runCommand(
        {
          command: "jobs",
          jobsAction: "action-start",
          jobId: parent.id,
          hostRequestId: request.id,
          reconfigure: false,
          reset: false,
          json: true,
        },
        workspace,
        dependencies,
      ),
    /already started/,
  );
});

test("action-family leases are bounded by policy, scope, cost, and expiry", () => {
  const rolePolicy = resolveRolePolicy("executor", {}, []);
  const snapshot = createPolicySnapshot({
    sandboxMode: "strict",
    approvalMode: "deny",
    rolePolicy,
    adaptivePolicy: normalizeAdaptivePolicy(undefined),
  });
  const policy = { ...defaultHostActionPolicy(), maxUses: 2, maxCost: 3 };
  const lease = createActionFamilyLease({
    jobId: "child",
    generation: 1,
    role: "executor",
    snapshot,
    recommendation: {
      kind: "action-recommendation",
      actionClass: "local-mutation",
      summary: "edit",
      target: "src",
      rationale: "needed",
      expectedEvidence: ["diff"],
      dataClassification: "project-internal",
    },
    policy,
    now: new Date("2026-07-12T00:00:00.000Z"),
  });
  assert.equal(lease.principal, "host-broker");
  assert.equal(lease.actionFamily?.maxUses, 2);
  assert.equal(lease.actionFamily?.maxCost, 3);
  assert.equal(lease.actionFamily?.target, "src");
  assert.equal(lease.expiresAt, "2026-07-12T00:30:00.000Z");
});
