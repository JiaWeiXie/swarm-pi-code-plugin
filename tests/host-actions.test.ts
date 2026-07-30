import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../src/runner/run.js";
import { defaultHostActionPolicy, loadState, updateState } from "../src/state/state.js";

test("legacy Host Actions normalize to an inert migration tombstone", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-actions-removed-"));
  await updateState(workspace, (state) => {
    state.config.hostActions = {
      enabled: true,
      allowedActionClasses: ["local-mutation", "deploy"],
      remoteActionsEnabled: true,
      maxUses: 9,
      maxCost: 100,
      ttlMs: 60_000,
    };
  });
  const policy = (await loadState(workspace)).config.hostActions ?? defaultHostActionPolicy();
  assert.deepEqual(policy, defaultHostActionPolicy());
  assert.equal(policy.enabled, false);
});

test("legacy action-start commands fail with the stable removal code", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-host-actions-command-"));
  await assert.rejects(
    () =>
      runCommand(
        {
          command: "jobs",
          jobsAction: "action-start",
          jobId: "legacy-parent",
          hostRequestId: "legacy-record",
          reconfigure: false,
          reset: false,
          json: true,
        },
        workspace,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Host Actions 0.5 has been removed." &&
      (error as Error & { code?: string }).code === "host-actions-removed",
  );
});
