import assert from "node:assert/strict";
import test from "node:test";

import type { ApprovalRequest } from "../src/core/contracts.js";
import {
  createJobEventSnapshot,
  dedupeJobEvents,
  projectJobEvents,
} from "../src/state/job-events.js";
import { defaultState, type JobRecord, type SwarmState } from "../src/state/state.js";

const first = "2026-07-12T01:00:00.000Z";
const second = "2026-07-12T01:00:01.000Z";

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    jobId: "job-1",
    generation: 1,
    actionFingerprint: "fingerprint-is-not-public",
    toolName: "bash",
    actionSummary: "run npm test",
    decision: {
      decision: "require-approval",
      risk: "high",
      capabilities: ["shell.execute"],
      reason: "The command can change the workspace.",
      constraints: ["constraint-is-not-public"],
      policyHash: "policy-is-not-public",
    },
    status: "pending",
    requestedAt: first,
    expiresAt: "2026-07-12T01:05:00.000Z",
    notificationId: "notification-1",
    notification: "pending",
    ...overrides,
  };
}

function stateWith(...jobs: JobRecord[]): SwarmState {
  const state = defaultState();
  state.jobs = jobs;
  return state;
}

test("projects only the public allowlist for approval and terminal notifications", () => {
  const pending = approval({
    actionSummary:
      "curl -H 'Authorization: Bearer sk-test-secret' https://user:password@example.test",
  });
  const job: JobRecord = {
    id: "job-1",
    status: "awaiting-approval",
    host: "codex",
    kind: "implement",
    executionMode: "supervised",
    workerToken: "worker-secret",
    approvals: [pending],
    notifications: [
      {
        id: pending.notificationId,
        kind: "approval",
        status: "pending",
        createdAt: first,
        approvalId: pending.id,
      },
    ],
    pendingApprovalId: pending.id,
    phase: "preflight",
    progressMessage: "not emitted for this allowlist assertion",
    updatedAt: first,
  };
  const terminal: JobRecord = {
    id: "job-2",
    status: "succeeded",
    workerToken: "terminal-worker-secret",
    finishedAt: second,
    notifications: [
      { id: "terminal-notification", kind: "terminal", status: "pending", createdAt: second },
    ],
  };

  const events = projectJobEvents(stateWith(job, terminal), {
    includeProgress: false,
    now: second,
  });
  assert.deepEqual(
    events.map((event) => event.event),
    ["approval-required", "job-terminal"],
  );
  assert.equal(events[0]?.eventId, "notification-1");
  assert.equal(events[1]?.eventId, "terminal-notification");
  assert.deepEqual(
    Object.keys(events[0]!).sort(),
    [
      "actionSummary",
      "approvalId",
      "capabilities",
      "emittedAt",
      "event",
      "eventId",
      "expiresAt",
      "generation",
      "jobId",
      "notificationId",
      "reason",
      "requestedAt",
      "risk",
      "schema",
      "toolName",
      "version",
    ].sort(),
  );
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("worker-secret"), false);
  assert.equal(serialized.includes("fingerprint-is-not-public"), false);
  assert.equal(serialized.includes("policy-is-not-public"), false);
  assert.equal(serialized.includes("constraint-is-not-public"), false);
  assert.equal(serialized.includes("sk-test-secret"), false);
  assert.equal(serialized.includes("user:password@"), false);
});

test("replays a resolved legacy pending notification and can stream acknowledged resolutions", () => {
  const resolved = approval({ status: "denied", resolvedAt: second });
  const job: JobRecord = {
    id: "job-1",
    status: "running",
    approvals: [resolved],
    notifications: [
      {
        id: resolved.notificationId,
        kind: "approval",
        status: "pending",
        createdAt: first,
        approvalId: resolved.id,
      },
    ],
    updatedAt: second,
  };
  const legacy = projectJobEvents(stateWith(job), { includeProgress: false, now: second });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]?.event, "approval-resolved");
  assert.equal((legacy[0] as { status: string }).status, "denied");

  const acknowledged = structuredClone(job);
  acknowledged.notifications![0]!.status = "acknowledged";
  acknowledged.approvals![0]!.notification = "acknowledged";
  const before = projectJobEvents(stateWith(acknowledged), {
    includeProgress: false,
    now: second,
  });
  assert.equal(before.length, 0);
  const after = projectJobEvents(stateWith(acknowledged), {
    includeProgress: false,
    includeResolved: true,
    since: first,
    now: second,
  });
  assert.equal(after.length, 1);
  assert.equal(after[0]?.event, "approval-resolved");
  assert.equal(
    createJobEventSnapshot(stateWith(acknowledged), {
      includeProgress: false,
      includeResolved: true,
      since: first,
      now: second,
    }).pendingCount,
    0,
  );
});

test("progress events have stable IDs and are deduplicated across polling passes", () => {
  const job: JobRecord = {
    id: "job-1",
    status: "running",
    phase: "delegating",
    progressMessage: "Delegating to the worker.",
    updatedAt: first,
    lastProgressAt: first,
  };
  const state = stateWith(job);
  const firstPoll = projectJobEvents(state, { now: second });
  const secondPoll = projectJobEvents(state, { now: "2026-07-12T01:00:02.000Z" });
  assert.equal(firstPoll.length, 1);
  assert.equal(secondPoll.length, 1);
  assert.equal(firstPoll[0]?.eventId, secondPoll[0]?.eventId);
  const seen = new Set<string>();
  assert.equal(dedupeJobEvents(firstPoll, seen).length, 1);
  assert.equal(dedupeJobEvents(secondPoll, seen).length, 0);

  job.updatedAt = second;
  const changed = projectJobEvents(state, { now: second });
  assert.notEqual(changed[0]?.eventId, firstPoll[0]?.eventId);
  assert.equal(dedupeJobEvents(changed, seen).length, 1);
});

test("snapshot filters by Job and reports only actionable notification count", () => {
  const pending = approval({ id: "approval-2", jobId: "job-2", notificationId: "notification-2" });
  const snapshot = createJobEventSnapshot(
    stateWith(
      { id: "job-1", status: "running", updatedAt: first },
      {
        id: "job-2",
        status: "awaiting-approval",
        approvals: [pending],
        pendingApprovalId: pending.id,
        notifications: [
          {
            id: pending.notificationId,
            kind: "approval",
            status: "pending",
            createdAt: first,
            approvalId: pending.id,
          },
        ],
      },
    ),
    { jobId: "job-2", includeProgress: false, now: second },
  );
  assert.equal(snapshot.snapshotAt, second);
  assert.equal(snapshot.pendingCount, 1);
  assert.deepEqual(
    snapshot.events.map((event) => event.event),
    ["approval-required"],
  );
  assert.equal((snapshot.events[0] as { jobId: string }).jobId, "job-2");
});
