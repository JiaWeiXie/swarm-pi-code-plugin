import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { HostAssistancePolicy } from "../src/core/contracts.js";
import { createJobEventSnapshot } from "../src/state/job-events.js";
import {
  listJobHostRequests,
  requestJobHostAssistance,
  resolveJobHostRequest,
  startJob,
  waitForHostAssistanceResolution,
} from "../src/state/jobs.js";
import { loadState, resolveStateDir } from "../src/state/state.js";
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
    correlation: { jobId: job.id, generation: 1, sessionId: "session-a", attempt: 1, perspective: "correctness" },
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
    answer: "Use the official v1 API.",
    claims: [{ claim: "v1 is current", evidenceIds: ["docs-1"], confidence: "high" }],
    citations: [{ id: "docs-1", title: "Official docs", url: "https://example.test", retrievedAt: new Date().toISOString() }],
    provenance: ["official docs"],
  });
  await assert.rejects(
    resolveJobHostRequest(workspace, job.id, request.id, { answer: "duplicate" }),
    /already resolved/,
  );
  const response = await waitForHostAssistanceResolution(workspace, job.id, job.workerToken, request.id);
  assert.equal(response.kind, "context");
  if (response.kind === "context") assert.match(response.answer, /^\[UNTRUSTED_HOST_CONTEXT\]/);
  await assert.rejects(
    waitForHostAssistanceResolution(workspace, job.id, job.workerToken, request.id),
    /already consumed/,
  );
});

test("Host Assistance limits one active request per session and human decisions create no lease", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-decision-"));
  const job = await startJob(workspace, {
    host: "codex", kind: "plan", prompt: "plan", cwd: workspace, executionMode: "supervised", timeoutMs: 60_000,
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
  await assert.rejects(requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "session-decision", attempt: 1 },
    request: {
      kind: "context", contextClass: "workspace", question: "second", unknowns: [], acceptanceCriteria: [],
      dataClassification: "project-internal", egressAllowed: false, budget: 1,
    },
    policy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), /active Host Assistance request/);
  await resolveJobHostRequest(workspace, job.id, first.id, { decision: "minimal", rationale: "ship the smallest evidence-backed scope" });
  const result = await waitForHostAssistanceResolution(workspace, job.id, job.workerToken, first.id);
  assert.equal(result.kind, "decision");
  const state = await loadState(workspace);
  assert.equal(state.jobs[0]?.leases?.length ?? 0, 0);
});

test("Host Assistance enforces cross-session fan-out and rejected admission leaves no raw artifact", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-fanout-"));
  const job = await startJob(workspace, {
    host: "codex", kind: "ask", prompt: "inspect", cwd: workspace, executionMode: "supervised", timeoutMs: 60_000,
  });
  const bounded = { ...policy, maxFanOut: 1 };
  const first = await requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "session-a", attempt: 1 },
    request: {
      kind: "context", contextClass: "workspace", question: "first", unknowns: [], acceptanceCriteria: [],
      dataClassification: "project-internal", egressAllowed: false, budget: 1,
    },
    policy: bounded,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const assistanceDir = path.join(await resolveStateDir(workspace), "jobs", job.id, "host-assistance");
  fs.renameSync(path.join(assistanceDir, `${first.id}.json`), path.join(assistanceDir, `${first.id}.pending.json`));
  assert.equal((await listJobHostRequests(workspace, job.id))[0]?.id, first.id);
  assert.equal(fs.existsSync(path.join(assistanceDir, `${first.id}.json`)), true);
  await assert.rejects(requestJobHostAssistance(workspace, job.id, job.workerToken, {
    correlation: { jobId: job.id, generation: 1, sessionId: "session-b", attempt: 1 },
    request: {
      kind: "context", contextClass: "workspace", question: "raw rejected request", unknowns: [], acceptanceCriteria: [],
      dataClassification: "project-internal", egressAllowed: false, budget: 1,
    },
    policy: bounded,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), /fan-out/);
  assert.equal(fs.readdirSync(assistanceDir).filter((name) => name.endsWith(".json")).length, 1);

  const stale = await startJob(workspace, {
    host: "codex", kind: "ask", prompt: "stale", cwd: workspace, executionMode: "supervised", timeoutMs: 60_000,
  });
  await assert.rejects(requestJobHostAssistance(workspace, stale.id, stale.workerToken, {
    correlation: { jobId: stale.id, generation: 0, sessionId: "stale", attempt: 1 },
    request: {
      kind: "context", contextClass: "workspace", question: "must not persist", unknowns: [], acceptanceCriteria: [],
      dataClassification: "project-internal", egressAllowed: false, budget: 1,
    },
    policy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), /stale/);
  const staleDir = path.join(await resolveStateDir(workspace), "jobs", stale.id, "host-assistance");
  assert.equal(fs.existsSync(staleDir) ? fs.readdirSync(staleDir).length : 0, 0);
});

test("request_host_assistance validates request variants", () => {
  assert.equal(parseHostAssistanceRequest({
    kind: "context", contextClass: "web", question: "Find evidence", dataClassification: "public", budget: 2,
  }).kind, "context");
  assert.equal(parseHostAssistanceRequest({
    kind: "action-recommendation", actionClass: "draft", summary: "Create draft", rationale: "Needs review",
    dataClassification: "project-internal",
  }).kind, "action-recommendation");
  assert.throws(() => parseHostAssistanceRequest({ kind: "context", contextClass: "bad", question: "x" }), /contextClass/);
});

test("Host Assistance CLI actions require exact correlation arguments", () => {
  assert.deepEqual(parseArguments(["jobs", "host-respond", "--job", "job-1", "--request", "request-1", "--response-file", "response.json", "--json"]), {
    command: "jobs",
    jobsAction: "host-respond",
    jobId: "job-1",
    hostRequestId: "request-1",
    responseFile: "response.json",
    json: true,
    reconfigure: false,
    reset: false,
  });
  assert.throws(() => parseArguments(["jobs", "decide", "--job", "job-1", "--request", "request-1"]), /--response-file/);
});
