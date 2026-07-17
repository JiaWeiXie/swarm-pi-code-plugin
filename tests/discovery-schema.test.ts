import assert from "node:assert/strict";
import test from "node:test";

import { parseDiscoveryStageOutput } from "../src/discovery/schema.js";

test("Discovery schema rejects incomplete research, experiment, and convergence stages", () => {
  assert.throws(
    () =>
      parseDiscoveryStageOutput("research", JSON.stringify({ evidencePlan: {}, evidencePack: {} })),
    /unknowns|array/,
  );
  assert.throws(
    () =>
      parseDiscoveryStageOutput(
        "experiment",
        JSON.stringify({
          experimentSpec: { hypothesis: "x" },
          execution: { commandsRun: [], testsRun: [], evidence: [], cleanReplayPassed: false },
          conclusion: "supported",
        }),
      ),
    /baseline|cleanReplay/,
  );
  assert.throws(
    () =>
      parseDiscoveryStageOutput(
        "convergence",
        JSON.stringify({
          featureDefinition: { summary: "x", acceptanceCriteria: [], nonGoals: [] },
          decisionLedger: [],
        }),
      ),
    /acceptanceCriteria|decisionLedger/,
  );
});

test("Discovery experiment schema requires explicit clean replay evidence", () => {
  const complete = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "setup",
      runCommand: "run",
      testCommand: "test",
      verifyCommand: "verify",
      cleanupCommand: "cleanup",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "replay",
    },
    execution: {
      commandsRun: ["run"],
      testsRun: ["test"],
      evidence: ["metric=1"],
      cleanReplayPassed: true,
    },
    conclusion: "refuted",
  };
  const parsed = parseDiscoveryStageOutput("experiment", JSON.stringify(complete));
  assert.equal(parsed.artifact.stage, "experiment");
  assert.equal(parsed.verification.includes("clean-replay-passed"), true);
});

test("Discovery experiment schema accepts an unexecuted inconclusive result without claiming replay", () => {
  const unexecuted = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "setup",
      runCommand: "run",
      testCommand: "test",
      verifyCommand: "verify",
      cleanupCommand: "cleanup",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "replay",
    },
    execution: {
      commandsRun: [],
      testsRun: [],
      evidence: ["Execution was blocked before the first command by an expired approval."],
      cleanReplayPassed: false,
    },
    conclusion: "inconclusive",
  };
  const parsed = parseDiscoveryStageOutput("experiment", JSON.stringify(unexecuted));
  assert.equal(parsed.artifact.stage, "experiment");
  assert.equal(parsed.artifact.execution.cleanReplayPassed, false);
  assert.equal(parsed.verification.includes("clean-replay-passed"), false);
  assert.equal(parsed.verification.includes("unexecuted-inconclusive"), true);
});

test("Discovery experiment schema rejects a blocked setup attempt without parser preflight", () => {
  const blocked = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "mkdir /tmp/experiment",
      runCommand: "node /tmp/experiment/run.mjs",
      testCommand: "node /tmp/experiment/test.mjs",
      verifyCommand: "node /tmp/experiment/verify.mjs",
      cleanupCommand: "node /tmp/experiment/cleanup.mjs",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "node /tmp/experiment/replay.mjs",
    },
    execution: {
      commandsRun: ["mkdir /tmp/experiment"],
      testsRun: [],
      evidence: ["The setup command failed with Operation not permitted."],
      cleanReplayPassed: false,
    },
    conclusion: "inconclusive",
  };
  assert.throws(
    () => parseDiscoveryStageOutput("experiment", JSON.stringify(blocked)),
    /cleanReplayPassed/,
  );
});

test("Discovery experiment schema accepts a parser-blocked preflight as inconclusive", () => {
  const blocked = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "node setup-harness.mjs",
      runCommand: "node harness.js",
      testCommand: "node --check /tmp/experiment/harness.js",
      verifyCommand: "node verify.mjs",
      cleanupCommand: "node cleanup.mjs",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "node replay.mjs",
    },
    execution: {
      commandsRun: ["node setup-harness.mjs", "node --check /tmp/experiment/harness.js"],
      testsRun: ["node --check /tmp/experiment/harness.js"],
      evidence: [
        "The parser preflight failed with a JavaScript syntax error before the workload started.",
      ],
      cleanReplayPassed: false,
    },
    conclusion: "inconclusive",
  };
  const parsed = parseDiscoveryStageOutput("experiment", JSON.stringify(blocked));
  assert.equal(parsed.artifact.stage, "experiment");
  assert.equal(parsed.artifact.execution.cleanReplayPassed, false);
  assert.equal(parsed.verification.includes("preflight-blocked-inconclusive"), true);
});

test("Discovery experiment schema rejects duplicate lifecycle commands for parser preflight", () => {
  const blocked = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "node setup-harness.mjs",
      runCommand: "node --check harness.js",
      testCommand: "node --check harness.js",
      verifyCommand: "node verify.mjs",
      cleanupCommand: "node cleanup.mjs",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "node replay.mjs",
    },
    execution: {
      commandsRun: ["node setup-harness.mjs", "node --check harness.js"],
      testsRun: ["node --check harness.js"],
      evidence: ["The parser preflight failed with a syntax error."],
      cleanReplayPassed: false,
    },
    conclusion: "inconclusive",
  };
  assert.throws(
    () => parseDiscoveryStageOutput("experiment", JSON.stringify(blocked)),
    /cleanReplayPassed/,
  );
});

test("Discovery experiment schema rejects compound setup commands for parser preflight", () => {
  const setupCommand = "node setup-harness.mjs && node workload.mjs";
  const blocked = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand,
      runCommand: "node workload.mjs",
      testCommand: "node --check harness.js",
      verifyCommand: "node verify.mjs",
      cleanupCommand: "node cleanup.mjs",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "node replay.mjs",
    },
    execution: {
      commandsRun: [setupCommand, "node --check harness.js"],
      testsRun: ["node --check harness.js"],
      evidence: ["The parser preflight failed with a syntax error."],
      cleanReplayPassed: false,
    },
    conclusion: "inconclusive",
  };
  assert.throws(
    () => parseDiscoveryStageOutput("experiment", JSON.stringify(blocked)),
    /cleanReplayPassed/,
  );
});

test("Discovery experiment schema rejects a non-parser test for blocked preflight", () => {
  const blocked = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "node setup-harness.mjs",
      runCommand: "node workload.mjs",
      testCommand: "node test.mjs",
      verifyCommand: "node verify.mjs",
      cleanupCommand: "node cleanup.mjs",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "node replay.mjs",
    },
    execution: {
      commandsRun: ["node setup-harness.mjs", "node test.mjs"],
      testsRun: ["node test.mjs"],
      evidence: ["The test failed with an error."],
      cleanReplayPassed: false,
    },
    conclusion: "inconclusive",
  };
  assert.throws(
    () => parseDiscoveryStageOutput("experiment", JSON.stringify(blocked)),
    /cleanReplayPassed/,
  );
});

test("Discovery experiment schema rejects a setup-only result without blocking evidence", () => {
  assert.throws(
    () =>
      parseDiscoveryStageOutput(
        "experiment",
        JSON.stringify({
          experimentSpec: {
            hypothesis: "feature works",
            baseline: "control",
            dependencies: [],
            fixture: "fixture",
            seedOrDataHash: "sha256:data",
            setupCommand: "mkdir /tmp/experiment",
            runCommand: "node /tmp/experiment/run.mjs",
            testCommand: "node /tmp/experiment/test.mjs",
            verifyCommand: "node /tmp/experiment/verify.mjs",
            cleanupCommand: "node /tmp/experiment/cleanup.mjs",
            metrics: ["latency"],
            tolerance: "5%",
            cleanReplayCommand: "node /tmp/experiment/replay.mjs",
          },
          execution: {
            commandsRun: ["mkdir /tmp/experiment"],
            testsRun: [],
            evidence: ["The setup command was attempted."],
            cleanReplayPassed: false,
          },
          conclusion: "inconclusive",
        }),
      ),
    /setup-blocked|cleanReplayPassed/,
  );
});

test("Discovery experiment schema rejects false replay for executed or decisive results", () => {
  const base = {
    experimentSpec: {
      hypothesis: "feature works",
      baseline: "control",
      dependencies: [],
      fixture: "fixture",
      seedOrDataHash: "sha256:data",
      setupCommand: "setup",
      runCommand: "run",
      testCommand: "test",
      verifyCommand: "verify",
      cleanupCommand: "cleanup",
      metrics: ["latency"],
      tolerance: "5%",
      cleanReplayCommand: "replay",
    },
    execution: {
      commandsRun: ["run"],
      testsRun: ["test"],
      evidence: ["metric=1"],
      cleanReplayPassed: false,
    },
  };
  assert.throws(
    () =>
      parseDiscoveryStageOutput(
        "experiment",
        JSON.stringify({ ...base, conclusion: "inconclusive" }),
      ),
    /cleanReplayPassed/,
  );
  assert.throws(
    () =>
      parseDiscoveryStageOutput(
        "experiment",
        JSON.stringify({
          ...base,
          execution: {
            commandsRun: [],
            testsRun: [],
            evidence: ["blocked"],
            cleanReplayPassed: false,
          },
          conclusion: "supported",
        }),
      ),
    /cleanReplayPassed|supported/,
  );
});
