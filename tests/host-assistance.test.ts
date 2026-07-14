import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  HostAdjudicationReceipt,
  HostAssistancePolicy,
  WorkerAssessment,
} from "../src/core/contracts.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { compileEffectiveProjectPolicy } from "../src/policy/project-policy.js";
import { createJobEventSnapshot } from "../src/state/job-events.js";
import {
  listJobHostRequests,
  requestJobHostAssistance,
  resolveJobHostRequest,
  startJob,
  waitForHostAssistanceResolution,
} from "../src/state/jobs.js";
import { loadState, resolveStateDir } from "../src/state/state.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";
import { parseHostAssistanceRequest } from "../src/pi/host-assistance-tool.js";
import { parseArguments } from "../src/runner/args.js";

const policy: HostAssistancePolicy = {
  enabled: true,
  mode: "on",
  contextClasses: ["workspace", "web", "docs", "paper", "connector", "skill"],
  privateConnector: "ask",
  maxRequests: 4,
  maxFanOut: 2,
};

const workerAssessment: WorkerAssessment = {
  purpose: "Obtain bounded public documentation needed to continue the current task.",
  blockedBy: "The worker does not have authoritative version evidence.",
  minimumAccess: ["read public documentation"],
  targets: ["official public documentation"],
  sideEffects: ["one read-only Host lookup"],
  dataExposure: ["public question only"],
  failureModes: ["stale or unrelated documentation"],
  mitigations: ["require an official citation and version match"],
  reversibility: "read-only",
  rollback: "No state changes are made.",
  verification: ["Verify the citation and version against the acceptance criteria."],
  proposedRisk: "low",
  fallback: "Report the version as unresolved and stop the dependent step.",
};

test("Host Assistance persists safe events, correlates responses, and consumes once", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-assistance-"));
  const job = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "inspect",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 60_000,
  });
  const request = await requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: {
      jobId: job.id,
      generation: 1,
      sessionId: "session-a",
      attempt: 1,
      perspective: "correctness",
    },
    request: {
      kind: "context",
      contextClass: "docs",
      question: "PRIVATE RAW QUERY MUST NOT APPEAR IN EVENTS",
      unknowns: ["SDK version"],
      acceptanceCriteria: ["official citation"],
      versionConstraint: "v1",
      dataClassification: "public",
      egressAllowed: true,
      budget: 1,
    },
    policy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const state = await loadState(workspace);
  const eventSnapshot = createJobEventSnapshot(state, { includeProgress: false });
  const required = eventSnapshot.events.find((event) => event.event === "host-assistance-required");
  assert.ok(required);
  assert.equal(JSON.stringify(required).includes("PRIVATE RAW QUERY"), false);
  assert.equal(state.jobs[0]?.status, "awaiting-host");
  assert.equal((await listJobHostRequests(workspace, job.id))[0]?.request.kind, "context");

  await assert.rejects(
    resolveJobHostRequest(workspace, job.id, request.id, { requestId: "wrong", answer: "no" }),
    /correlation mismatch/,
  );
  await resolveJobHostRequest(workspace, job.id, request.id, {
    requestId: request.id,
    answer: "x".repeat(10_000),
    claims: [{ claim: "v1 is current", evidenceIds: ["docs-1"], confidence: "high" }],
    citations: [
      {
        id: "docs-1",
        title: "Official docs",
        url: "https://example.test",
        retrievedAt: new Date().toISOString(),
      },
    ],
    provenance: ["official docs"],
  });
  await assert.rejects(
    resolveJobHostRequest(workspace, job.id, request.id, { answer: "duplicate" }),
    /already resolved/,
  );
  const response = await waitForHostAssistanceResolution(
    workspace,
    job.id,
    job.workerToken,
    request.id,
  );
  assert.equal(response.kind, "context");
  if (response.kind === "context") {
    assert.equal(response.answer, `[UNTRUSTED_HOST_CONTEXT]\n${"x".repeat(8_192)}`);
  }
  await assert.rejects(
    waitForHostAssistanceResolution(workspace, job.id, job.workerToken, request.id),
    /already consumed/,
  );
});

test("Host Assistance limits one active request per session and human decisions create no lease", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-decision-"));
  const job = await startJob(workspace, {
    host: "codex",
    kind: "plan",
    prompt: "plan",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 60_000,
  });
  const first = await requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "session-decision", attempt: 1 },
    request: {
      kind: "decision",
      question: "Choose scope",
      options: ["minimal", "complete"],
      context: "The choice changes delivery time.",
      dataClassification: "project-internal",
    },
    policy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(
    requestJobHostAssistance(workspace, job.id, job.workerToken, {
      correlation: { jobId: job.id, generation: 1, sessionId: "session-decision", attempt: 1 },
      request: {
        kind: "context",
        contextClass: "workspace",
        question: "second",
        unknowns: [],
        acceptanceCriteria: [],
        dataClassification: "project-internal",
        egressAllowed: false,
        budget: 1,
      },
      policy,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    /active Host Assistance request/,
  );
  await resolveJobHostRequest(workspace, job.id, first.id, {
    decision: "minimal",
    rationale: "ship the smallest evidence-backed scope",
  });
  const result = await waitForHostAssistanceResolution(
    workspace,
    job.id,
    job.workerToken,
    first.id,
  );
  assert.equal(result.kind, "decision");
  const state = await loadState(workspace);
  assert.equal(state.jobs[0]?.leases?.length ?? 0, 0);
});

test("Host Assistance enforces cross-session fan-out and rejected admission leaves no raw artifact", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-fanout-"));
  const job = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "inspect",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 60_000,
  });
  const bounded = { ...policy, maxFanOut: 1 };
  const first = await requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "session-a", attempt: 1 },
    request: {
      kind: "context",
      contextClass: "workspace",
      question: "first",
      unknowns: [],
      acceptanceCriteria: [],
      dataClassification: "project-internal",
      egressAllowed: false,
      budget: 1,
    },
    policy: bounded,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const assistanceDir = path.join(
    await resolveStateDir(workspace),
    "jobs",
    job.id,
    "host-assistance",
  );
  fs.renameSync(
    path.join(assistanceDir, `${first.id}.json`),
    path.join(assistanceDir, `${first.id}.pending.json`),
  );
  assert.equal((await listJobHostRequests(workspace, job.id))[0]?.id, first.id);
  assert.equal(fs.existsSync(path.join(assistanceDir, `${first.id}.json`)), true);
  await assert.rejects(
    requestJobHostAssistance(workspace, job.id, job.workerToken, {
      correlation: { jobId: job.id, generation: 1, sessionId: "session-b", attempt: 1 },
      request: {
        kind: "context",
        contextClass: "workspace",
        question: "raw rejected request",
        unknowns: [],
        acceptanceCriteria: [],
        dataClassification: "project-internal",
        egressAllowed: false,
        budget: 1,
      },
      policy: bounded,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    /fan-out/,
  );
  assert.equal(fs.readdirSync(assistanceDir).filter((name) => name.endsWith(".json")).length, 1);

  const stale = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "stale",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 60_000,
  });
  await assert.rejects(
    requestJobHostAssistance(workspace, stale.id, stale.workerToken, {
      correlation: { jobId: stale.id, generation: 0, sessionId: "stale", attempt: 1 },
      request: {
        kind: "context",
        contextClass: "workspace",
        question: "must not persist",
        unknowns: [],
        acceptanceCriteria: [],
        dataClassification: "project-internal",
        egressAllowed: false,
        budget: 1,
      },
      policy,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    /stale/,
  );
  const staleDir = path.join(await resolveStateDir(workspace), "jobs", stale.id, "host-assistance");
  assert.equal(fs.existsSync(staleDir) ? fs.readdirSync(staleDir).length : 0, 0);
});

test("request_host_assistance validates request variants", () => {
  assert.equal(
    parseHostAssistanceRequest({
      kind: "context",
      contextClass: "web",
      question: "Find evidence",
      dataClassification: "public",
      budget: 2,
      workerAssessment,
    }).kind,
    "context",
  );
  assert.equal(
    parseHostAssistanceRequest({
      kind: "action-recommendation",
      actionClass: "draft",
      summary: "Create draft",
      rationale: "Needs review",
      dataClassification: "project-internal",
      workerAssessment: { ...workerAssessment, reversibility: "reversible" },
    }).kind,
    "action-recommendation",
  );
  assert.throws(
    () => parseHostAssistanceRequest({ kind: "context", contextClass: "bad", question: "x" }),
    /contextClass/,
  );
});

test("an active Host model can auto-resolve bounded public context with an exact receipt", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-first-context-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd: workspace,
    profile: { dirs: ["."], tasks: ["analysis"] },
  });
  const hostFirstPolicy: HostAssistancePolicy = {
    ...policy,
    reviewMode: "host-first",
    autoApprovalScope: "reversible",
    autoApproveDiscoveryGates: true,
  };
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance: hostFirstPolicy,
  });
  const job = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "inspect authoritative docs",
    cwd: workspace,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    policySnapshot: snapshot,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const request = await requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "host-first", attempt: 1 },
    request: {
      kind: "context",
      contextClass: "docs",
      question: "What is the supported public API?",
      unknowns: ["current API"],
      acceptanceCriteria: ["official citation"],
      dataClassification: "public",
      egressAllowed: true,
      budget: 1,
      workerAssessment,
    },
    policy: hostFirstPolicy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const receipt: HostAdjudicationReceipt = {
    principal: "host-model",
    host: "codex",
    model: "host/test-model",
    decision: "allow",
    assessedRisk: "low",
    rationale: "The request is read-only, public, bounded, and matches the original intent.",
    constraints: ["Use only public official documentation."],
    intentMatch: true,
    actionFingerprint: request.actionFingerprint!,
    policyHash: snapshot.hash,
    autoResolved: true,
    decidedAt: new Date().toISOString(),
  };
  const resolved = await resolveJobHostRequest(
    workspace,
    job.id,
    request.id,
    {
      requestId: request.id,
      answer: "Use the cited API.",
      claims: [{ claim: "The API is supported.", evidenceIds: ["official"], confidence: "high" }],
      citations: [
        {
          id: "official",
          title: "Official documentation",
          url: "https://example.test/docs",
          retrievedAt: new Date().toISOString(),
        },
      ],
      provenance: ["official documentation"],
    },
    receipt,
  );
  assert.equal(resolved.adjudication?.principal, "host-model");
  const state = await loadState(workspace);
  const events = createJobEventSnapshot(state, {
    includeProgress: false,
    includeResolved: true,
  }).events;
  const event = events.find(
    (candidate) =>
      candidate.event === "host-assistance-resolved" && candidate.requestId === request.id,
  );
  assert.ok(event && "principal" in event);
  assert.equal(event.principal, "host-model");
  assert.equal(event.autoResolved, true);
  assert.equal(event.assessedRisk, "low");
  assert.equal(
    createJobEventSnapshot(state, { includeProgress: false, includeResolved: true }).events.filter(
      (candidate) => candidate.eventId === event?.eventId,
    ).length,
    1,
  );
});

test("Host-first resolution rejects stale fingerprints and private connector context", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-first-deny-"));
  const effectiveProjectPolicy = await compileEffectiveProjectPolicy({
    cwd: workspace,
    profile: { dirs: ["."], tasks: ["analysis"] },
  });
  const hostFirstPolicy: HostAssistancePolicy = {
    ...policy,
    reviewMode: "host-first",
    autoApprovalScope: "reversible",
    autoApproveDiscoveryGates: true,
  };
  const snapshot = createPolicySnapshot({
    sandboxMode: "adaptive",
    approvalMode: "wait",
    rolePolicy: resolveRolePolicy("scout"),
    effectiveProjectPolicy,
    decisionMode: "balance",
    hostAssistance: hostFirstPolicy,
  });
  const job = await startJob(workspace, {
    host: "claude",
    kind: "ask",
    prompt: "inspect private connector",
    cwd: workspace,
    executionMode: "supervised",
    sandboxMode: "adaptive",
    timeoutMs: 60_000,
    role: "scout",
    policySnapshot: snapshot,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const request = await requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "private", attempt: 1 },
    request: {
      kind: "context",
      contextClass: "connector",
      question: "Read private records",
      unknowns: ["record"],
      acceptanceCriteria: ["exact record"],
      dataClassification: "private",
      egressAllowed: false,
      budget: 1,
      workerAssessment: { ...workerAssessment, dataExposure: ["private connector records"] },
    },
    policy: hostFirstPolicy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const receipt: HostAdjudicationReceipt = {
    principal: "host-model",
    host: "claude",
    decision: "allow",
    assessedRisk: "low",
    rationale: "fixture",
    constraints: [],
    intentMatch: true,
    actionFingerprint: "0".repeat(64),
    policyHash: snapshot.hash,
    autoResolved: true,
    decidedAt: new Date().toISOString(),
  };
  await assert.rejects(
    resolveJobHostRequest(workspace, job.id, request.id, { answer: "no" }, receipt),
    /fingerprint/,
  );
  receipt.actionFingerprint = request.actionFingerprint!;
  await assert.rejects(
    resolveJobHostRequest(workspace, job.id, request.id, { answer: "no" }, receipt),
    /Private or connector context/,
  );
  receipt.decision = "ask-user";
  receipt.assessedRisk = "high";
  receipt.intentMatch = false;
  receipt.autoResolved = false;
  const fallback = await resolveJobHostRequest(workspace, job.id, request.id, {}, receipt);
  assert.equal(fallback.status, "pending");
  assert.equal(fallback.adjudication?.decision, "ask-user");
  const denied = await resolveJobHostRequest(
    workspace,
    job.id,
    request.id,
    {},
    {
      ...receipt,
      decision: "hard-deny",
      autoResolved: true,
      rationale: "Private connector context is outside the automatic ceiling.",
    },
  );
  assert.equal(denied.status, "declined");
  assert.equal(denied.response?.kind, "unavailable");
  assert.equal((await listJobHostRequests(workspace, job.id))[0]?.status, "declined");
});

test("Host Assistance CLI actions require exact correlation arguments", () => {
  assert.deepEqual(
    parseArguments([
      "jobs",
      "host-respond",
      "--job",
      "job-1",
      "--request",
      "request-1",
      "--response-file",
      "response.json",
      "--json",
    ]),
    {
      command: "jobs",
      jobsAction: "host-respond",
      jobId: "job-1",
      hostRequestId: "request-1",
      responseFile: "response.json",
      json: true,
      reconfigure: false,
      reset: false,
    },
  );
  assert.throws(
    () => parseArguments(["jobs", "decide", "--job", "job-1", "--request", "request-1"]),
    /--response-file/,
  );
  assert.equal(
    parseArguments([
      "jobs",
      "host-respond",
      "--job",
      "job-1",
      "--request",
      "request-1",
      "--response-file",
      "response.json",
      "--adjudication-file",
      "receipt.json",
    ]).adjudicationFile,
    "receipt.json",
  );
  assert.throws(
    () =>
      parseArguments([
        "jobs",
        "deny",
        "--job",
        "job-1",
        "--approval",
        "approval-1",
        "--adjudication-file",
        "receipt.json",
      ]),
    /only supported/,
  );
});
