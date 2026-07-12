import assert from "node:assert/strict";
import test from "node:test";

import { parseDiscoveryStageOutput } from "../src/discovery/schema.js";

test("Discovery schema rejects incomplete research, experiment, and convergence stages", () => {
  assert.throws(() => parseDiscoveryStageOutput("research", JSON.stringify({ evidencePlan: {}, evidencePack: {} })), /unknowns|array/);
  assert.throws(() => parseDiscoveryStageOutput("experiment", JSON.stringify({
    experimentSpec: { hypothesis: "x" },
    execution: { commandsRun: [], testsRun: [], evidence: [], cleanReplayPassed: false },
    conclusion: "supported",
  })), /baseline|cleanReplay/);
  assert.throws(() => parseDiscoveryStageOutput("convergence", JSON.stringify({
    featureDefinition: { summary: "x", acceptanceCriteria: [], nonGoals: [] },
    decisionLedger: [],
  })), /acceptanceCriteria|decisionLedger/);
});

test("Discovery experiment schema requires explicit clean replay evidence", () => {
  const complete = {
    experimentSpec: {
      hypothesis: "feature works", baseline: "control", dependencies: [], fixture: "fixture", seedOrDataHash: "sha256:data",
      setupCommand: "setup", runCommand: "run", testCommand: "test", verifyCommand: "verify", cleanupCommand: "cleanup",
      metrics: ["latency"], tolerance: "5%", cleanReplayCommand: "replay",
    },
    execution: { commandsRun: ["run"], testsRun: ["test"], evidence: ["metric=1"], cleanReplayPassed: true },
    conclusion: "refuted",
  };
  const parsed = parseDiscoveryStageOutput("experiment", JSON.stringify(complete));
  assert.equal(parsed.artifact.stage, "experiment");
  assert.equal(parsed.verification.includes("clean-replay-passed"), true);
});
