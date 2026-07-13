import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bindProjectPolicy, compileEffectiveProjectPolicy } from "../src/policy/project-policy.js";
import { createWorkerSession, workerToolAllowlist } from "../src/pi/runtime.js";
import { IMPLEMENT_TOOLS, READ_ONLY_TOOLS, toolsForMode } from "../src/pi/tool-profiles.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";

test("readonly workers cannot mutate files or run shell commands", () => {
  assert.deepEqual(READ_ONLY_TOOLS, ["read", "grep", "find", "ls"]);
  assert.equal(READ_ONLY_TOOLS.includes("write" as never), false);
  assert.equal(READ_ONLY_TOOLS.includes("edit" as never), false);
  assert.equal(READ_ONLY_TOOLS.includes("bash" as never), false);
});

test("implementation workers can edit but cannot run arbitrary shell commands", () => {
  assert.equal(IMPLEMENT_TOOLS.includes("write"), true);
  assert.equal(IMPLEMENT_TOOLS.includes("edit"), true);
  assert.equal(IMPLEMENT_TOOLS.includes("bash" as never), false);
  assert.deepEqual(toolsForMode("implement"), [...IMPLEMENT_TOOLS]);
});

test("worker tool allowlists retain policy-scoped and host custom tools", () => {
  assert.deepEqual(
    workerToolAllowlist("readonly", [
      { name: "read" },
      { name: "grep" },
      { name: "request_host_assistance" },
      { name: "bash" },
    ]),
    ["read", "grep", "find", "ls", "request_host_assistance", "bash"],
  );
});

test("policy-scoped worker sessions keep their custom filesystem tools active", async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-worker-tools-")));
  const policy = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd: workspace }), workspace);
  const { session } = await createWorkerSession({
    cwd: workspace,
    mode: "readonly",
    boundProjectPolicy: policy,
    modelConfiguration: defaultModelConfiguration(),
  });
  try {
    assert.deepEqual(session.getActiveToolNames().sort(), [...READ_ONLY_TOOLS].sort());
  } finally {
    session.dispose();
  }
});
