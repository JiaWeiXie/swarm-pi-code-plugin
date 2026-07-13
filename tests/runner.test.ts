import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeSession, type RunnableSession } from "../src/pi/execute.js";
import { isDelegatedCommand } from "../src/cli.js";
import { createPolicySnapshot, resolveRolePolicy } from "../src/orchestration/roles.js";
import { compileEffectiveProjectPolicy, ProjectPolicyError } from "../src/policy/project-policy.js";
import { describeModels, describeProviders, modelId, selectModel, type PiModel } from "../src/pi/models.js";
import { parseArguments } from "../src/runner/args.js";
import { runCommand, type RunnerDependencies } from "../src/runner/run.js";
import { approveJob, cancelJob, finishJob, getJob, readJobRequest, requestJobApproval, startJob } from "../src/state/jobs.js";
import { defaultModelConfiguration } from "../src/state/model-config.js";
import { detectSandboxAvailability } from "../src/sandbox/availability.js";
import { resolveStateDir, setSandboxMode, updateState } from "../src/state/state.js";

const fakeModel = {
  provider: "test-provider",
  id: "test-model",
  name: "Test Model",
} as PiModel;
const fallbackModel = {
  provider: "test-provider",
  id: "fallback-model",
  name: "Fallback Model",
} as PiModel;

test("CLI forwards termination signals to discover delegations", () => {
  assert.equal(isDelegatedCommand("discover"), true);
  assert.equal(isDelegatedCommand("status"), false);
});

test("argument parsing requires host and prompt file for ask", () => {
  assert.equal(parseArguments(["roles", "list", "--json"]).rolesAction, "list");
  assert.equal(
    parseArguments(["jobs", "approve", "--job", "job-1", "--approval", "approval-1", "--approval-scope", "job", "--json"]).approvalScope,
    "job",
  );
  assert.deepEqual(
    parseArguments([
      "ask",
      "--host",
      "codex",
      "--prompt-file",
      "/tmp/prompt.md",
      "--model",
      "test-provider/test-model",
      "--json",
    ]),
    {
      command: "ask",
      host: "codex",
      promptFile: "/tmp/prompt.md",
      model: "test-provider/test-model",
      reconfigure: false,
      reset: false,
      json: true,
    },
  );
  assert.throws(() => parseArguments(["ask", "--host", "codex"]), /--prompt-file/);
  assert.throws(() => parseArguments(["ask", "--prompt-file", "prompt.md"]), /--host/);
  assert.deepEqual(
    parseArguments([
      "init",
      "--reconfigure",
      "--set-model-priority",
      '["test-provider/test-model"]',
      "--save-profile",
      '{"goal":"ship"}',
      "--json",
    ]),
    {
      command: "init",
      reconfigure: true,
      reset: false,
      modelPriority: ["test-provider/test-model"],
      profile: { goal: "ship" },
      json: true,
    },
  );
  assert.throws(() => parseArguments(["review", "--host", "codex", "--scope", "bad"]), /scope/);
  assert.deepEqual(
    parseArguments(["configure", "--host", "codex", "--section", "project"]),
    {
      command: "configure",
      host: "codex",
      configurationSection: "project",
      reconfigure: false,
      reset: false,
      json: false,
    },
  );
  assert.throws(() => parseArguments(["configure", "--section", "models"]), /configuration section/);
  assert.equal(parseArguments(["plan", "--host", "codex", "--prompt-file", "plan.md", "--discovery-from", "discover-1"]).discoveryFrom, "discover-1");
  assert.throws(() => parseArguments(["ask", "--host", "codex", "--prompt-file", "ask.md", "--discovery-from", "discover-1"]), /only supported by plan/);
  assert.throws(() => parseArguments(["init", "--section", "project"]), /only supported by configure/);
  assert.equal(parseArguments(["status", "--json"]).command, "status");
  assert.equal(parseArguments(["doctor", "--smoke-test", "--json"]).smokeTest, true);
  assert.equal(parseArguments(["resume", "--continuation", "00000000-0000-0000-0000-000000000000"]).continuationId,
    "00000000-0000-0000-0000-000000000000");
  assert.equal(parseArguments(["scaffold", "--host", "codex", "--spec-file", "/tmp/spec.json", "--target", "/tmp/app"]).command, "scaffold");
  assert.equal(parseArguments(["setup", "--host", "codex", "--prompt-file", "/tmp/setup.md", "--workspace-strategy", "isolated-snapshot"]).workspaceStrategy, "isolated-snapshot");

  assert.deepEqual(
    parseArguments([
      "plan",
      "--host",
      "codex",
      "--prompt-file",
      "/tmp/plan.md",
      "--execution-mode",
      "background",
      "--timeout-ms",
      "45000",
      "--json",
    ]),
    {
      command: "plan",
      host: "codex",
      promptFile: "/tmp/plan.md",
      executionMode: "background",
      timeoutMs: 45_000,
      reconfigure: false,
      reset: false,
      json: true,
    },
  );
  assert.equal(
    parseArguments([
      "implement",
      "--host",
      "codex",
      "--prompt-file",
      "/tmp/task.md",
      "--execution-mode",
      "background",
      "--role",
      "mechanical-executor",
    ]).role,
    "mechanical-executor",
  );
  assert.throws(
    () => parseArguments([
      "ask",
      "--host",
      "codex",
      "--prompt-file",
      "/tmp/task.md",
      "--timeout-ms",
      "999",
    ]),
    /timeout/i,
  );
  assert.deepEqual(parseArguments(["jobs", "status", "--job", "job-1", "--json"]), {
    command: "jobs",
    jobsAction: "status",
    jobId: "job-1",
    reconfigure: false,
    reset: false,
    json: true,
  });
  assert.equal(parseArguments(["jobs", "watch", "--emit", "ndjson", "--once"]).once, true);
  assert.throws(() => parseArguments(["jobs", "watch"]), /--emit ndjson/);
});

test("model helpers expose stable provider/model identifiers", () => {
  assert.deepEqual(describeModels([fakeModel]), [
    {
      id: "test-provider/test-model",
      provider: "test-provider",
      model: "test-model",
      name: "Test Model",
    },
  ]);
  assert.equal(selectModel([fakeModel], "test-provider/test-model"), fakeModel);
  assert.equal(selectModel([fakeModel], "missing/model"), undefined);
});

test("provider summaries hide catalog entries that are not connected or selected", () => {
  const catalog = {
    all: () => [fakeModel],
    available: () => [],
    displayName: () => "Test Provider",
  };
  assert.deepEqual(describeProviders(catalog, defaultModelConfiguration()), []);

  const selected = defaultModelConfiguration(["test-provider/test-model"]);
  assert.deepEqual(describeProviders(catalog, selected), [{
    id: "test-provider",
    name: "Test Provider",
    ready: false,
    modelCount: 1,
    availableModelCount: 0,
    auth: { source: null, label: null },
    selection: "primary",
    custom: false,
  }]);
});

test("session execution collects streamed output and always disposes", async () => {
  let disposed = false;
  const listeners = new Set<(event: any) => void>();
  const session: RunnableSession = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(prompt) {
      assert.equal(prompt, "Inspect this repository.");
      for (const delta of ["Inspection ", "complete."]) {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      }
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop" },
        });
      }
    },
    dispose() {
      disposed = true;
    },
  };

  const result = await executeSession({
    kind: "ask",
    model: "test-provider/test-model",
    prompt: "Inspect this repository.",
    session,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Inspection complete.");
  assert.equal(disposed, true);
});

test("session execution treats resolved provider errors as failures", async () => {
  let disposed = false;
  const listeners = new Set<(event: any) => void>();
  const session: RunnableSession = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider unavailable",
          },
        });
      }
    },
    dispose() {
      disposed = true;
    },
  };

  const result = await executeSession({
    kind: "ask",
    model: "test-provider/test-model",
    prompt: "Inspect this repository.",
    session,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.success, false);
  assert.match(result.output, /provider unavailable/);
  assert.equal(disposed, true);
});

test("session execution classifies incomplete and aborted terminal messages", async () => {
  for (const [stopReason, expected] of [
    ["length", /before completion/i],
    ["aborted", /aborted/i],
  ] as const) {
    const listeners = new Set<(event: any) => void>();
    const result = await executeSession({
      kind: "plan",
      model: "test-provider/test-model",
      prompt: "Plan",
      session: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt() {
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: { role: "assistant", stopReason },
            });
          }
        },
        dispose() {},
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.output, expected);
  }
});

test("session execution aborts and reports timeout", async () => {
  let aborted = false;
  let disposed = false;
  const result = await executeSession({
    kind: "ask",
    model: "test-provider/test-model",
    prompt: "Wait forever",
    timeoutMs: 5,
    session: {
      subscribe() {
        return () => {};
      },
      async prompt() {
        await new Promise(() => {});
      },
      async abort() {
        aborted = true;
      },
      async waitForIdle() {},
      dispose() {
        disposed = true;
      },
    },
  });

  assert.equal(result.status, "timed-out");
  assert.equal(aborted, true);
  assert.equal(disposed, true);
});

test("session execution aborts and reports external cancellation", async () => {
  const controller = new AbortController();
  let aborted = false;
  const resultPromise = executeSession({
    kind: "ask",
    model: "test-provider/test-model",
    prompt: "Wait forever",
    signal: controller.signal,
    session: {
      subscribe() {
        return () => {};
      },
      async prompt() {
        await new Promise(() => {});
      },
      async abort() {
        aborted = true;
      },
      async waitForIdle() {},
      dispose() {},
    },
  });
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.status, "cancelled");
  assert.equal(aborted, true);
});

test("ask runs through injected model and session dependencies", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-ask-"));
  const session: RunnableSession = {
    subscribe(listener) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      });
      listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      return () => {};
    },
    async prompt(prompt) {
      assert.match(prompt, /Claude Code/);
      assert.match(prompt, /Question from file/);
    },
    dispose() {},
  };
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Question from file",
    createSession: async () => session,
  };

  const result = await runCommand(
    {
      command: "ask",
      host: "claude",
      promptFile: "prompt.md",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.equal("success" in result && result.success, true);
  assert.equal("model" in result && result.model, "test-provider/test-model");
});

test("implement requires a clean worktree and captures Pi changes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-implement-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(workspace, "file.txt"), "before\n");
  fs.writeFileSync(path.join(workspace, ".gitignore"), "cache/\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "fixture"],
    { stdio: "ignore" },
  );
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Change file.txt",
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: changes match the task" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") {
          fs.writeFileSync(path.join(workspace, "file.txt"), "after\n");
          fs.mkdirSync(path.join(workspace, "cache"));
          fs.writeFileSync(path.join(workspace, "cache", "artifact.bin"), "generated\n");
        }
      },
      dispose() {},
    }),
  };
  const result = await runCommand(
    {
      command: "implement",
      host: "codex",
      promptFile: "prompt.md",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.equal("status" in result && result.status, "succeeded");
  assert.deepEqual("changedFiles" in result && result.changedFiles, ["file.txt"]);
  assert.match("diffStat" in result ? result.diffStat : "", /file\.txt/);
  assert.deepEqual("runtimeSideEffects" in result && result.runtimeSideEffects, ["cache/"]);
  assert.equal("agentVerification" in result && result.agentVerification?.status, "passed");
});

test("independent verification reuses the ordered Job candidates and contributes fallback attempts", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-verifier-candidates-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(workspace, "file.txt"), "before\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "fixture"], { stdio: "ignore" });
  await updateState(workspace, (state) => {
    state.config.rolePolicies = {
      ...state.config.rolePolicies,
      executor: {
        models: ["test-provider/fallback-model", "test-provider/test-model"],
        maxAttempts: 2,
      },
    };
  });
  const sessions: Array<{ mode: "readonly" | "implement"; model: string }> = [];
  const dependencies: RunnerDependencies = {
    // Catalog order deliberately disagrees with the configured Job order.
    catalog: { available: () => [fakeModel, fallbackModel] },
    readFile: async () => "Change file.txt",
    createSession: async ({ mode, model }) => {
      sessions.push({ mode, model: modelId(model) });
      return {
        subscribe(listener) {
          if (mode === "readonly" && model.id === fallbackModel.id) {
            listener({
              type: "message_end",
              message: { role: "assistant", stopReason: "error", errorMessage: "verifier candidate unavailable" },
            });
          } else {
            if (mode === "readonly") {
              listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: ordered fallback passed" } });
            }
            listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          }
          return () => {};
        },
        async prompt() {
          if (mode === "implement") fs.writeFileSync(path.join(workspace, "file.txt"), "after\n");
        },
        dispose() {},
      };
    },
  };

  const result = await runCommand({
    command: "implement", host: "codex", promptFile: "prompt.md",
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);

  assert.deepEqual(sessions, [
    { mode: "implement", model: "test-provider/fallback-model" },
    { mode: "readonly", model: "test-provider/fallback-model" },
    { mode: "readonly", model: "test-provider/test-model" },
  ]);
  assert.equal("agentVerification" in result && result.agentVerification?.model, "test-provider/test-model");
  assert.equal("attempts" in result && result.attempts, 3);
  assert.equal("fallbackUsed" in result && result.fallbackUsed, true);
  const persisted = await getJob(workspace, "jobId" in result ? result.jobId! : "");
  assert.equal(persisted.result?.attempts, 3);
  assert.equal(persisted.result?.fallbackUsed, true);
});

test("implement returns actionable isolation strategies for a dirty worktree", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-dirty-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "base"], { stdio: "ignore" });
  fs.writeFileSync(path.join(workspace, "dirty.txt"), "user change\n");
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "unused",
    createSession: async () => {
      throw new Error("must not create a session");
    },
  };

  const result = await runCommand(
    {
      command: "implement",
      host: "codex",
      promptFile: "prompt.md",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );
  assert.equal("event" in result && result.event, "workspace-action-required");
  assert.deepEqual("strategies" in result ? result.strategies : [], ["isolated-head", "isolated-snapshot"]);
});

test("unborn implementation fails before model use and resumes after workspace repair", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-unborn-implement-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(workspace, ".DS_Store"), "preserved");
  let sessions = 0;
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Create src/example.ts",
    createSession: async (options) => {
      sessions += 1;
      return {
        subscribe(listener) {
          if (options.mode === "readonly") {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED" } });
          }
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          return () => {};
        },
        async prompt() {
          if (options.mode === "implement") {
            fs.mkdirSync(path.join(options.cwd, "src"), { recursive: true });
            fs.writeFileSync(path.join(options.cwd, "src", "example.ts"), "export const value = 1;\n");
          }
        },
        dispose() {},
      };
    },
  };
  const blocked = await runCommand({
    command: "implement", host: "codex", promptFile: "prompt.md",
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("event" in blocked && blocked.event, "workspace-action-required");
  assert.equal("errorCode" in blocked && blocked.errorCode, "workspace-unborn-head");
  assert.equal(sessions, 0);
  const continuationId = "continuationId" in blocked ? blocked.continuationId : "";

  fs.writeFileSync(path.join(workspace, "README.md"), "# Fixture\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "initial"], { stdio: "ignore" });
  const resumed = await runCommand({
    command: "resume", continuationId, reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("success" in resumed && resumed.success, true);
  assert.equal("artifact" in resumed && resumed.artifact?.deliverable, true);
  assert.equal(fs.readFileSync(path.join(workspace, ".DS_Store"), "utf8"), "preserved");
  assert.equal(fs.existsSync(path.join(workspace, "src", "example.ts")), false);
});

test("safe-dirty implementation is isolated and materializes without changing preserved files", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-safe-dirty-materialize-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "before\n");
  execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "base"], { stdio: "ignore" });
  fs.mkdirSync(path.join(workspace, "__pycache__"));
  const cache = path.join(workspace, "__pycache__", "app.pyc");
  fs.writeFileSync(cache, "preserved");
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Update tracked.txt",
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") fs.writeFileSync(path.join(options.cwd, "tracked.txt"), "after\n");
      },
      dispose() {},
    }),
  };
  const result = await runCommand({
    command: "implement", host: "codex", promptFile: "prompt.md",
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("success" in result && result.success, true);
  assert.equal("artifact" in result && result.artifact?.deliverable, true);
  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "before\n");
  assert.equal(fs.readFileSync(cache, "utf8"), "preserved");

  const jobId = "jobId" in result ? result.jobId! : "";
  const materialized = await runCommand({
    command: "jobs", jobsAction: "materialize", jobId,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("materialized" in materialized && materialized.materialized, true);
  assert.deepEqual("changedFiles" in materialized && materialized.changedFiles, ["tracked.txt"]);
  assert.equal(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8"), "after\n");
  assert.equal(fs.readFileSync(cache, "utf8"), "preserved");

  const cleaned = await runCommand({
    command: "jobs", jobsAction: "cleanup", jobId,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("cleaned" in cleaned && cleaned.cleaned, true);
  assert.equal("artifact" in result && result.artifact?.worktree ? fs.existsSync(result.artifact.worktree) : true, false);
});

test("mechanical executor escalates only after a side-effect-free failure", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-mechanical-escalation-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  fs.writeFileSync(path.join(workspace, "file.txt"), "before\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "base"], { stdio: "ignore" });
  await updateState(workspace, (state) => {
    state.config.rolePolicies = {
      "mechanical-executor": { models: ["test-provider/test-model"], maxAttempts: 1 },
      executor: { models: ["test-provider/fallback-model"], thinkingLevel: "high", maxAttempts: 1 },
    };
  });
  const sessions: Array<{ mode: "readonly" | "implement"; model: string }> = [];
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel, fallbackModel] },
    readFile: async () => "Change file.txt",
    createSession: async ({ model, mode }) => {
      sessions.push({ mode, model: modelId(model) });
      return {
        subscribe(listener) {
          if (mode === "readonly") {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED" } });
            listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          } else if (model.id === fakeModel.id) {
            listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "mechanical failed" } });
          } else {
            listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          }
          return () => {};
        },
        async prompt() {
          if (mode === "implement" && model.id === fallbackModel.id) fs.writeFileSync(path.join(workspace, "file.txt"), "after\n");
        },
        dispose() {},
      };
    },
  };
  const result = await runCommand({
    command: "implement", host: "codex", role: "mechanical-executor", promptFile: "prompt.md",
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("status" in result && result.status, "succeeded");
  assert.equal("role" in result && result.role, "executor");
  assert.deepEqual("orchestrationTrace" in result && result.orchestrationTrace?.map((item) => item.role), ["mechanical-executor", "executor"]);
  assert.deepEqual(sessions, [
    { mode: "implement", model: "test-provider/test-model" },
    { mode: "implement", model: "test-provider/fallback-model" },
    { mode: "readonly", model: "test-provider/fallback-model" },
  ]);
});

test("init replaces validated model priority and preserves it in status", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-init-"));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel, fallbackModel] },
    readFile: async () => "unused",
    createSession: async () => {
      throw new Error("unused");
    },
  };
  const result = await runCommand(
    {
      command: "init",
      reconfigure: true,
      reset: false,
      modelPriority: ["test-provider/fallback-model", "test-provider/test-model"],
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.deepEqual("modelPriority" in result && result.modelPriority, [
    "test-provider/fallback-model",
    "test-provider/test-model",
  ]);
  await assert.rejects(
    () =>
      runCommand(
        {
          command: "init",
          reconfigure: true,
          reset: false,
          modelPriority: ["missing/model"],
          json: true,
        },
        workspace,
        dependencies,
      ),
    /not available/i,
  );
});

test("init reads model priority and profile from host-created JSON files", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-init-files-"));
  const priorityFile = path.join(workspace, "priority.json");
  const profileFile = path.join(workspace, "profile.json");
  fs.writeFileSync(priorityFile, '["test-provider/test-model"]');
  fs.writeFileSync(profileFile, '{"goal":"quoted user input: it\'s safe","dirs":["src"]}');
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: (file) => fs.promises.readFile(file, "utf8"),
    createSession: async () => {
      throw new Error("unused");
    },
  };
  const result = await runCommand(
    {
      command: "init",
      reconfigure: true,
      reset: false,
      modelPriorityFile: priorityFile,
      profileFile,
      json: true,
    },
    workspace,
    dependencies,
  );
  assert.deepEqual("modelPriority" in result && result.modelPriority, ["test-provider/test-model"]);
  assert.equal("profile" in result && result.profile?.goal, "quoted user input: it's safe");
});

test("readonly jobs fall back through configured model priority", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-fallback-"));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel, fallbackModel] },
    readFile: async () => "Inspect",
    createSession: async ({ model }) => ({
      subscribe(listener) {
        if (model === fallbackModel) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "fallback done" },
          });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        }
        return () => {};
      },
      async prompt() {
        if (model === fakeModel) throw new Error("primary unavailable");
      },
      dispose() {},
    }),
  };
  await runCommand(
    {
      command: "init",
      reconfigure: false,
      reset: false,
      modelPriority: ["test-provider/test-model", "test-provider/fallback-model"],
      json: true,
    },
    workspace,
    dependencies,
  );
  const result = await runCommand(
    {
      command: "ask",
      host: "codex",
      promptFile: "prompt.md",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.equal("success" in result && result.success, true);
  assert.equal("model" in result && result.model, "test-provider/fallback-model");
  assert.equal("attempts" in result && result.attempts, 2);
  assert.equal("fallbackUsed" in result && result.fallbackUsed, true);
});

test("readonly jobs fall back when Pi resolves with a terminal provider error", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-terminal-fallback-"));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel, fallbackModel] },
    readFile: async () => "Inspect",
    createSession: async ({ model }) => ({
      subscribe(listener) {
        if (model === fakeModel) {
          listener({
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "primary failed" },
          });
        } else {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "fallback recovered" },
          });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        }
        return () => {};
      },
      async prompt() {},
      dispose() {},
    }),
  };
  await runCommand({
    command: "init",
    reconfigure: false,
    reset: false,
    modelPriority: ["test-provider/test-model", "test-provider/fallback-model"],
    json: true,
  }, workspace, dependencies);
  const result = await runCommand({
    command: "ask",
    host: "codex",
    promptFile: "prompt.md",
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace, dependencies);

  assert.equal("status" in result && result.status, "succeeded");
  assert.equal("attempts" in result && result.attempts, 2);
  assert.equal("output" in result && result.output, "fallback recovered");
});

test("review builds a working-tree prompt and runs readonly", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-review-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(workspace, "review.txt"), "before\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "fixture"], {
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(workspace, "review.txt"), "after\n");
  let receivedPrompt = "";
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "unused",
    createSession: async ({ mode }) => ({
      subscribe(listener) {
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt(prompt) {
        assert.equal(mode, "readonly");
        receivedPrompt = prompt;
      },
      dispose() {},
    }),
  };
  await runCommand(
    {
      command: "review",
      host: "claude",
      scope: "working-tree",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );
  assert.match(receivedPrompt, /review\.txt/);
  assert.match(receivedPrompt, /-before/);
  assert.match(receivedPrompt, /\+after/);
});

test("branch review handles a repository with only a root commit", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-root-review-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(workspace, "root.txt"), "root commit\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "root"], {
    stdio: "ignore",
  });
  let receivedPrompt = "";
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "unused",
    createSession: async () => ({
      subscribe(listener) {
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt(prompt) {
        receivedPrompt = prompt;
      },
      dispose() {},
    }),
  };
  const result = await runCommand(
    {
      command: "review",
      host: "codex",
      scope: "branch",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );
  assert.equal("success" in result && result.success, true);
  assert.match(receivedPrompt, /root\.txt/);
});

test("orchestrate runs Balance-mode readonly perspectives and records artifacts", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-orchestrate-"));
  let sessions = 0;
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Evaluate this design",
    createSession: async ({ mode }) => {
      sessions += 1;
      return {
      subscribe(listener) {
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `result ${sessions}` },
        });
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
        },
        async prompt(prompt) {
          assert.equal(mode, "readonly");
          assert.match(prompt, /PERSPECTIVE/);
        },
        dispose() {},
      };
    },
  };
  const result = await runCommand(
    {
      command: "orchestrate",
      host: "codex",
      promptFile: "prompt.md",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.equal(sessions, 2);
  assert.equal("success" in result && result.success, true);
  assert.match("output" in result ? result.output : "", /Correctness and failure modes/);
  const stateDir = await resolveStateDir(workspace);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.length, 1);
  const jobDir = path.join(stateDir, "jobs", state.jobs[0].id);
  assert.equal(fs.existsSync(path.join(jobDir, "request.json")), true);
  assert.equal(fs.existsSync(path.join(jobDir, "prompt.md")), true);
  assert.equal(fs.existsSync(path.join(jobDir, "result.json")), true);
});

test("discover runs fixed stages, propagates prior evidence, and parses experiment conclusion", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-discover-"));
  let sessions = 0;
  const prompts: string[] = [];
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Investigate the unknown",
    createSession: async () => {
      const stage = sessions;
      sessions += 1;
      return {
        subscribe(listener) {
          const output = stage === 0
            ? JSON.stringify({
                evidencePlan: { unknowns: ["unknown behavior"], sources: ["workspace"], acceptanceCriteria: ["evidence found"], budget: 1 },
                evidencePack: {
                  claims: [{ claim: "repository evidence exists", evidenceIds: ["repo-1"], confidence: "high" }],
                  citations: [{ id: "repo-1", title: "Repository fixture", retrievedAt: "2026-07-12T00:00:00.000Z" }],
                  conflicts: [], unknowns: [],
                },
              })
            : stage === 1
              ? JSON.stringify({
                  experimentSpec: {
                    hypothesis: "works", baseline: "control", dependencies: [], fixture: "fixture-a", seedOrDataHash: "sha256:test",
                    setupCommand: "true", runCommand: "true", testCommand: "true", verifyCommand: "true", cleanupCommand: "true",
                    metrics: ["success"], tolerance: "exact", cleanReplayCommand: "true",
                  },
                  execution: { commandsRun: ["true"], testsRun: ["true"], evidence: ["exit=0"], cleanReplayPassed: true },
                  conclusion: "supported",
                })
              : JSON.stringify({
                  featureDefinition: { summary: "minimal feature", acceptanceCriteria: ["works"], nonGoals: ["automatic productization"] },
                  decisionLedger: [{ decision: "ship minimal", rationale: "evidence supports it", evidenceIds: ["repo-1"] }],
                });
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: output } });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          return () => {};
        },
        async prompt(prompt) { prompts.push(prompt); },
        dispose() {},
      };
    },
  };
  const result = await runCommand(
    {
      command: "discover",
      host: "codex",
      promptFile: "prompt.md",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.equal(sessions, 3);
  assert.equal("success" in result && result.success, true);
  assert.deepEqual("discovery" in result ? result.discovery?.stages.map((stage) => stage.stage) : [], [
    "research",
    "experiment",
    "convergence",
  ]);
  assert.equal("discovery" in result && result.discovery?.experimentConclusion, "supported");
  assert.match(prompts[1] ?? "", /repository evidence exists/);
  assert.match(prompts[2] ?? "", /supported/);
  assert.equal("discovery" in result && result.discovery?.stages[1]?.verification.includes("clean-replay-passed"), true);
  assert.equal("discovery" in result && Boolean(result.discovery?.stages[1]?.childJobId), true);
  const childJobId = "discovery" in result ? result.discovery?.stages[1]?.childJobId : undefined;
  assert.ok(childJobId);
  const child = await getJob(workspace, childJobId);
  assert.equal(child.job.parentJobId, "jobId" in result ? result.jobId : undefined);
  assert.equal(child.job.internalStage, "experiment");
  assert.equal(child.job.role, "experimenter");
  assert.equal(child.result?.artifact?.kind, "experiment");
  assert.equal(child.result?.artifact?.deliverable, false);
});

test("plan accepts only a verified and final-gated DiscoveryResult handoff", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-discovery-handoff-"));
  const discovery = await startJob(workspace, {
    host: "codex", kind: "discover", prompt: "discover", cwd: workspace, executionMode: "supervised", timeoutMs: 60_000,
  });
  await finishJob(workspace, discovery.id, {
    kind: "discover", status: "succeeded", success: true, output: "approved discovery", model: "test-provider/test-model",
    changedFiles: [], diffStat: "", verification: { status: "passed", commands: ["all-stages"] },
    discovery: {
      stages: [
        { stage: "research", status: "passed", output: "evidence", evidence: [], verification: ["schema"] },
        { stage: "experiment", status: "passed", output: "experiment", evidence: [], verification: ["clean-replay-passed"] },
        { stage: "convergence", status: "passed", output: "definition", evidence: [], verification: ["schema", "user-gate:approved"] },
      ],
      experimentConclusion: "supported",
    },
  });
  let delegatedPrompt = "";
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Create the implementation plan",
    createSession: async () => ({
      subscribe(listener) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "plan" } });
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt(prompt) { delegatedPrompt = prompt; },
      dispose() {},
    }),
  };
  const result = await runCommand({
    command: "plan", host: "codex", promptFile: "plan.md", discoveryFrom: discovery.id,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("success" in result && result.success, true);
  assert.match(delegatedPrompt, new RegExp(`VERIFIED_DISCOVERY_HANDOFF id=${discovery.id}`));
  assert.match(delegatedPrompt, /user-gate:approved/);
});

test("background submission returns an accepted job without creating a Pi session", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-background-submit-"));
  await setSandboxMode(workspace, "lenient");
  let sessions = 0;
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Inspect in background",
    createSession: async () => {
      sessions += 1;
      throw new Error("background submit must not create a session");
    },
  };

  const result = await runCommand(
    {
      command: "ask",
      host: "codex",
      promptFile: "prompt.md",
      executionMode: "background",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
    { spawnWorker: async () => 424_242 },
  );

  assert.deepEqual(result, {
    event: "accepted",
    jobId: "jobId" in result ? result.jobId : "",
    status: "queued",
    executionMode: "background",
  });
  assert.equal(sessions, 0);
  const snapshot = await getJob(workspace, "jobId" in result ? result.jobId : "");
  assert.equal(snapshot.job.status, "queued");
  assert.equal(snapshot.job.pid, 424_242);
  assert.equal(snapshot.job.timeoutMs, 30 * 60_000);
  assert.equal(snapshot.job.sandboxMode, "lenient");
  const request = await readJobRequest(workspace, "jobId" in result ? result.jobId : "");
  assert.equal(request.requestVersion, 5);
  assert.equal(request.modelConfiguration?.version, 1);
  assert.match(request.providerSnapshotHash ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(request.modelConfiguration), /apiKey|access-token|refresh-token/);
});

test("background mechanical implementation uses an isolated job worktree", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-background-mechanical-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  fs.writeFileSync(path.join(workspace, "file.txt"), "base\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "base"], { stdio: "ignore" });
  await updateState(workspace, (state) => { state.config.backgroundRolePolicy = { mechanicalExecutor: true }; });
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Mechanical change",
    createSession: async () => { throw new Error("background must not create a foreground session"); },
  };
  const result = await runCommand({
    command: "implement", host: "codex", role: "mechanical-executor", promptFile: "prompt.md",
    executionMode: "background", reconfigure: false, reset: false, json: true,
  }, workspace, dependencies, { spawnWorker: async () => 424_242 });
  assert.equal("event" in result && result.event, "accepted");
  const jobId = "jobId" in result ? result.jobId : "";
  const request = await readJobRequest(workspace, jobId);
  assert.notEqual(request.cwd, workspace);
  assert.equal(fs.existsSync(request.cwd), true);
  assert.equal((await getJob(workspace, jobId)).job.executionWorkspace !== undefined, true);
  await runCommand({ command: "jobs", jobsAction: "cancel", jobId, reconfigure: false, reset: false, json: true }, workspace, dependencies);
  await runCommand({ command: "jobs", jobsAction: "cleanup", jobId, discard: true, reconfigure: false, reset: false, json: true }, workspace, dependencies);
  assert.equal(fs.existsSync(request.cwd), false);
});

test("supervised lenient jobs inject one shared sandbox runner", {
  skip: !detectSandboxAvailability().available,
}, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-lenient-job-"));
  await setSandboxMode(workspace, "lenient");
  let receivedSandbox = false;
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Inspect with shell access",
    createSession: async (options) => {
      receivedSandbox = options.sandboxRunner !== undefined;
      return {
        subscribe(listener) {
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
          return () => {};
        },
        async prompt() {},
        dispose() {},
      };
    },
  };

  const result = await runCommand({
    command: "ask",
    host: "codex",
    promptFile: "prompt.md",
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace, dependencies);

  assert.equal(receivedSandbox, true);
  assert.equal("status" in result && result.status, "succeeded");
});

test("background spawn failures become durable failed jobs", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-background-spawn-"));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Inspect in background",
    createSession: async () => {
      throw new Error("unused");
    },
  };
  const result = await runCommand(
    {
      command: "plan",
      host: "claude",
      promptFile: "prompt.md",
      executionMode: "background",
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
    { spawnWorker: async () => { throw new Error("spawn unavailable"); } },
  );

  assert.equal("status" in result && result.status, "failed");
  assert.match("output" in result ? result.output : "", /spawn unavailable/);
  const snapshot = await getJob(workspace, "jobId" in result ? result.jobId ?? "" : "");
  assert.equal(snapshot.job.status, "failed");
  assert.equal(snapshot.job.notification, "pending");
});

test("private background worker reconstructs and completes a durable job", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-background-worker-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "Durable prompt",
    cwd: workspace,
    executionMode: "background",
    timeoutMs: 30_000,
  });
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "unused",
    createSession: async () => ({
      subscribe(listener) {
        listener({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "background done" },
        });
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt(prompt) {
        assert.match(prompt, /Durable prompt/);
      },
      dispose() {},
    }),
  };

  const result = await runCommand(
    {
      command: "__worker",
      jobId: handle.id,
      workerToken: handle.workerToken,
      reconfigure: false,
      reset: false,
      json: true,
    },
    workspace,
    dependencies,
  );

  assert.equal("status" in result && result.status, "succeeded");
  assert.equal("output" in result && result.output, "background done");
  assert.equal((await getJob(workspace, handle.id)).job.notification, "pending");
});

test("background worker rejects a tampered provider configuration snapshot", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-background-snapshot-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "Snapshot integrity",
    cwd: workspace,
    executionMode: "background",
    timeoutMs: 30_000,
    modelConfiguration: defaultModelConfiguration(["test-provider/test-model"]),
  });
  const stateDir = await resolveStateDir(workspace);
  const requestFile = path.join(stateDir, "jobs", handle.id, "request.json");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  request.providerSnapshotHash = "0".repeat(64);
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "unused",
    createSession: async () => { throw new Error("tampered snapshot must not start a session"); },
  };

  const result = await runCommand({
    command: "__worker",
    jobId: handle.id,
    workerToken: handle.workerToken,
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace, dependencies);

  assert.equal("status" in result && result.status, "failed");
  assert.match("output" in result ? result.output : "", /integrity validation/);
});

test("jobs commands expose list, status, wait timeout, and acknowledge", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-jobs-cli-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "review",
    prompt: "Review",
    cwd: workspace,
    executionMode: "background",
    timeoutMs: 30_000,
  });

  const listed = await runCommand({
    command: "jobs",
    jobsAction: "list",
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace);
  assert.equal("jobs" in listed && Array.isArray(listed.jobs) && listed.jobs.length, 1);
  assert.equal("jobs" in listed && Array.isArray(listed.jobs) && "workerToken" in listed.jobs[0]!, false);

  const status = await runCommand({
    command: "jobs",
    jobsAction: "status",
    jobId: handle.id,
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace);
  assert.equal("job" in status && status.job.status, "queued");
  assert.equal("job" in status && "workerToken" in status.job, false);

  const waited = await runCommand({
    command: "jobs",
    jobsAction: "wait",
    jobId: handle.id,
    waitTimeoutMs: 5,
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace);
  assert.equal("event" in waited && waited.event, "wait-timed-out");
});

function throwingDeps(marker: { sessions: number; reads: number }): RunnerDependencies {
  return {
    catalog: { available: () => [fakeModel] },
    readFile: async () => { marker.reads += 1; throw new Error("input must not be read before admission"); },
    createSession: async () => { marker.sessions += 1; throw new Error("session must not start for a rejected task"); },
  };
}

async function jobCount(workspace: string): Promise<number> {
  const stateDir = await resolveStateDir(workspace);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    return Array.isArray(state.jobs) ? state.jobs.length : 0;
  } catch { return 0; }
}

test("admission rejects every task kind that the project policy disallows", async () => {
  for (const command of ["ask", "plan", "review", "orchestrate", "implement", "scaffold", "setup"] as const) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `swarm-pi-admit-${command}-`));
    await updateState(workspace, (state) => { state.config.profile = { tasks: [] }; });
    const marker = { sessions: 0, reads: 0 };
    const result = await runCommand(
      { command, host: "claude", promptFile: "p.md", specFile: "s.json", target: "app", reconfigure: false, reset: false, json: true },
      workspace,
      throwingDeps(marker),
      { spawnWorker: async () => { throw new Error("must not spawn a worker for a rejected task"); } },
    );
    assert.equal("event" in result && result.event, "policy-rejected", command);
    assert.equal("errorCode" in result && result.errorCode, "task-kind-not-allowed", command);
    assert.equal("stage" in result && result.stage, "admission", command);
    assert.equal("recoverable" in result && result.recoverable, false, command);
    assert.ok("policyHash" in result && typeof result.policyHash === "string", command);
    assert.ok("scopeHash" in result && typeof result.scopeHash === "string", command);
    assert.equal(marker.sessions, 0, command);
    assert.equal(marker.reads, 0, command);
    assert.equal(await jobCount(workspace), 0, command);
  }
});

test("admission maps profile task categories to the allowed task kinds", async () => {
  // analysis -> ask + orchestrate
  const analysis = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-admit-analysis-"));
  await updateState(analysis, (state) => { state.config.profile = { tasks: ["analysis"] }; });
  const askMarker = { sessions: 0, reads: 0 };
  const askAllowed = await runCommand(
    { command: "ask", host: "codex", promptFile: "p.md", executionMode: "background", reconfigure: false, reset: false, json: true },
    analysis, { catalog: { available: () => [fakeModel] }, readFile: async () => "q", createSession: async () => { askMarker.sessions += 1; throw new Error("no session on submit"); } },
    { spawnWorker: async () => 1 },
  );
  assert.equal("event" in askAllowed && askAllowed.event, "accepted");
  const planMarker = { sessions: 0, reads: 0 };
  const planRejected = await runCommand(
    { command: "plan", host: "codex", promptFile: "p.md", reconfigure: false, reset: false, json: true },
    analysis, throwingDeps(planMarker),
  );
  assert.equal("errorCode" in planRejected && planRejected.errorCode, "task-kind-not-allowed");

  // implementation -> implement only
  const impl = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-admit-impl-"));
  await updateState(impl, (state) => { state.config.profile = { tasks: ["implementation"] }; });
  const askRej = await runCommand(
    { command: "ask", host: "codex", promptFile: "p.md", reconfigure: false, reset: false, json: true },
    impl, throwingDeps({ sessions: 0, reads: 0 }),
  );
  assert.equal("errorCode" in askRej && askRej.errorCode, "task-kind-not-allowed");
});

test("admission never blocks non-task commands even when tasks is empty", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-admit-nontask-"));
  await updateState(workspace, (state) => { state.config.profile = { tasks: [] }; });
  const deps: RunnerDependencies = { catalog: { available: () => [fakeModel] }, readFile: async () => "unused", createSession: async () => { throw new Error("no session"); } };
  for (const command of ["roles", "models", "providers", "status"] as const) {
    const result = await runCommand({ command, host: "claude", reconfigure: false, reset: false, json: true }, workspace, deps);
    assert.equal("event" in result && result.event === "policy-rejected", false, command);
  }
});

test("background durable replay ignores a later profile change", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-replay-"));
  await updateState(workspace, (state) => { state.config.profile = { tasks: ["analysis"] }; });
  const submit = await runCommand(
    { command: "ask", host: "codex", promptFile: "p.md", executionMode: "background", reconfigure: false, reset: false, json: true },
    workspace, { catalog: { available: () => [fakeModel] }, readFile: async () => "Durable question", createSession: async () => { throw new Error("no session on submit"); } },
    { spawnWorker: async () => 555 },
  );
  const jobId = "jobId" in submit ? submit.jobId : "";
  assert.equal((await readJobRequest(workspace, jobId)).requestVersion, 5);
  // Tighten the live profile so the original task kind would now be rejected.
  await updateState(workspace, (state) => { state.config.profile = { tasks: [] }; });
  const worker = await runCommand(
    { command: "__worker", jobId, workerToken: (await getJob(workspace, jobId)).job.workerToken!, reconfigure: false, reset: false, json: true },
    workspace,
    { catalog: { available: () => [fakeModel] }, readFile: async () => "unused", createSession: async () => ({
      subscribe(listener) { listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "replayed" } }); listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }); return () => {}; },
      async prompt() {}, dispose() {},
    }) },
  );
  assert.equal("status" in worker && worker.status, "succeeded");
});

test("background worker rejects a tampered policy snapshot before any session", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-policy-tamper-"));
  const submit = await runCommand(
    { command: "ask", host: "codex", promptFile: "p.md", executionMode: "background", reconfigure: false, reset: false, json: true },
    workspace, { catalog: { available: () => [fakeModel] }, readFile: async () => "q", createSession: async () => { throw new Error("no session on submit"); } },
    { spawnWorker: async () => 556 },
  );
  const jobId = "jobId" in submit ? submit.jobId : "";
  const requestFile = path.join(await resolveStateDir(workspace), "jobs", jobId, "request.json");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  request.policySnapshot.effectiveProjectPolicy.allowedTaskKinds = ["implement"];
  fs.writeFileSync(requestFile, JSON.stringify(request));
  let sessions = 0;
  const worker = await runCommand(
    { command: "__worker", jobId, workerToken: request.workerToken, reconfigure: false, reset: false, json: true },
    workspace,
    { catalog: { available: () => [fakeModel] }, readFile: async () => "unused", createSession: async () => { sessions += 1; throw new Error("tampered snapshot must not start a session"); } },
  );
  assert.equal("status" in worker && worker.status, "failed");
  assert.equal("errorCode" in worker && worker.errorCode, "policy-snapshot-invalid");
  assert.equal(sessions, 0);
});

async function scopedImplementFixture(mutate: (workspace: string) => void) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-postflight-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "fixture"], { stdio: "ignore" });
  await updateState(workspace, (state) => { state.config.profile = { dirs: ["src"], tasks: ["implementation"] }; });
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Make the change",
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: changes match the task" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") mutate(workspace);
      },
      dispose() {},
    }),
  };
  return runCommand(
    { command: "implement", host: "codex", promptFile: "prompt.md", reconfigure: false, reset: false, json: true },
    workspace,
    dependencies,
  );
}

test("postflight rejects a changed path outside the project write roots", async () => {
  const result = await scopedImplementFixture((workspace) => {
    fs.writeFileSync(path.join(workspace, "package.json"), "changed\n");
  });

  assert.equal("status" in result && result.status, "failed");
  assert.equal("errorCode" in result && result.errorCode, "project-scope-violation");
  // The verifier and artifact steps run only on success, so neither should have executed.
  assert.equal("agentVerification" in result && result.agentVerification, false);
  assert.equal("artifact" in result && result.artifact, false);
});

test("postflight accepts a changed path inside the project write roots", async () => {
  const result = await scopedImplementFixture((workspace) => {
    fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 2;\n");
  });

  assert.equal("status" in result && result.status, "succeeded");
  assert.deepEqual("changedFiles" in result && result.changedFiles, ["src/a.ts"]);
});

test("scoped-tool policy violations are recorded in the job denial metrics and audit trail", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-violation-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", workspace, "add", "."]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "fixture"], { stdio: "ignore" });
  await updateState(workspace, (state) => { state.config.profile = { dirs: ["src"], tasks: ["implementation"] }; });

  const violation = new ProjectPolicyError({
    event: "policy-rejected",
    errorCode: "project-scope-violation",
    stage: "preflight",
    recoverable: false,
    message: "Path escapes an allowed read root: package.json",
    preserved: [],
    violatingPaths: ["package.json"],
    nextActions: [],
  });
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Make the change",
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: ok" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") {
          // Simulate a scoped filesystem tool rejecting an out-of-scope read.
          options.onPolicyViolation?.(violation);
          // Recover with an in-scope change so the job itself still succeeds.
          fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 2;\n");
        }
      },
      dispose() {},
    }),
  };
  const result = await runCommand(
    { command: "implement", host: "codex", promptFile: "prompt.md", reconfigure: false, reset: false, json: true },
    workspace,
    dependencies,
  );

  assert.equal("status" in result && result.status, "succeeded");
  assert.ok("policySummary" in result && result.policySummary && result.policySummary.denied >= 1);
  const jobId = "jobId" in result && typeof result.jobId === "string" ? result.jobId : "";
  const events = await fs.promises.readFile(
    path.join(await resolveStateDir(workspace), "jobs", jobId, "policy-events.jsonl"),
    "utf8",
  );
  assert.match(events, /project-scope-violation/);
  // The audit event must record the actual violating path in its `paths` field, not just in the
  // human-readable reason. This fails if the recorder reads the always-empty `preserved` array.
  assert.match(events, /"paths":\["package\.json"\]/);
});

test("the durable background path re-checks task-kind admission on a valid snapshot", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-bg-admission-"));
  const submit = await runCommand(
    { command: "ask", host: "codex", promptFile: "p.md", executionMode: "background", reconfigure: false, reset: false, json: true },
    workspace, { catalog: { available: () => [fakeModel] }, readFile: async () => "q", createSession: async () => { throw new Error("no session on submit"); } },
    { spawnWorker: async () => 777 },
  );
  const jobId = "jobId" in submit ? submit.jobId : "";
  // Replace the snapshot with a VALID (self-consistent) v3 snapshot whose allowed kinds exclude the request kind.
  const planOnly = await compileEffectiveProjectPolicy({ cwd: workspace, profile: { tasks: ["planning"] } });
  const mismatched = createPolicySnapshot({
    sandboxMode: "adaptive", approvalMode: "wait", rolePolicy: resolveRolePolicy("scout"), effectiveProjectPolicy: planOnly,
    decisionMode: "balance",
  });
  const requestFile = path.join(await resolveStateDir(workspace), "jobs", jobId, "request.json");
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  request.policySnapshot = mismatched;
  fs.writeFileSync(requestFile, JSON.stringify(request));

  let sessions = 0;
  const worker = await runCommand(
    { command: "__worker", jobId, workerToken: request.workerToken, reconfigure: false, reset: false, json: true },
    workspace,
    { catalog: { available: () => [fakeModel] }, readFile: async () => "unused", createSession: async () => { sessions += 1; throw new Error("admission must reject before a session"); } },
  );
  assert.equal("status" in worker && worker.status, "failed");
  assert.equal("errorCode" in worker && worker.errorCode, "task-kind-not-allowed");
  assert.equal(sessions, 0);
});

test("a resumed job keeps its absent project goal despite a later profile edit", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-resume-goal-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.com"]);
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Make the change",
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: ok" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") fs.writeFileSync(path.join(workspace, "note.txt"), "done\n");
      },
      dispose() {},
    }),
  };
  // An unborn workspace blocks implementation and returns a continuation whose request carries no project goal.
  const blocked = await runCommand(
    { command: "implement", host: "codex", promptFile: "prompt.md", reconfigure: false, reset: false, json: true },
    workspace, dependencies,
  );
  const continuationId = "continuationId" in blocked ? blocked.continuationId : "";
  assert.ok(continuationId);

  // Repair the workspace and add a project goal to the live profile AFTER the continuation was captured.
  fs.writeFileSync(path.join(workspace, "note.txt"), "base\n");
  execFileSync("git", ["-C", workspace, "add", "note.txt"]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", workspace, "commit", "-m", "initial"], { stdio: "ignore" });
  await updateState(workspace, (state) => { state.config.profile = { goal: "added after submission" }; });

  const resumed = await runCommand(
    { command: "resume", continuationId, reconfigure: false, reset: false, json: true },
    workspace, dependencies,
  );
  const resumedId = "jobId" in resumed && typeof resumed.jobId === "string" ? resumed.jobId : "";
  assert.ok(resumedId);
  // The resumed job must not adopt the newly added profile goal.
  assert.equal("projectGoal" in (await readJobRequest(workspace, resumedId)), false);
});

test("supervised wait uses a managed relay and returns approval without blocking the Host", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-managed-relay-"));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Inspect this workspace",
    createSession: async () => { throw new Error("managed relay must not run the worker in the Host process"); },
  };
  const result = await runCommand({
    command: "ask",
    host: "codex",
    promptFile: "prompt.md",
    approvalMode: "wait",
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace, dependencies, {
    relayWaitTimeoutMs: 2_000,
    spawnWorker: async ({ cwd, jobId, workerToken }) => {
      setTimeout(() => {
        void requestJobApproval(cwd, jobId, workerToken, {
          actionFingerprint: "managed-relay-fingerprint",
          toolName: "shell",
          actionSummary: "run a supervised command",
          decision: {
            decision: "require-approval",
            risk: "high",
            capabilities: ["shell.execute"],
            reason: "The worker requested a supervised shell action.",
            constraints: [],
            policyHash: "relay-policy",
          },
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
      }, 20);
      return 999_999;
    },
  });

  assert.equal("event" in result && result.event, "approval-required");
  assert.equal("status" in result && result.status, "awaiting-approval");
  const jobId = "jobId" in result ? result.jobId : "";
  const snapshot = await getJob(workspace, jobId);
  assert.equal(snapshot.job.executionMode, "supervised");
  assert.equal(snapshot.job.status, "awaiting-approval");
  await cancelJob(workspace, jobId);
});

test("managed relay timeout returns progress context and leaves the Job durable", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-managed-timeout-"));
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Wait for the worker",
    createSession: async () => { throw new Error("worker should be detached"); },
  };
  const result = await runCommand({
    command: "ask",
    host: "codex",
    promptFile: "prompt.md",
    approvalMode: "wait",
    reconfigure: false,
    reset: false,
    json: true,
  }, workspace, dependencies, {
    relayWaitTimeoutMs: 1_000,
    spawnWorker: async () => 999_998,
  });

  assert.equal("event" in result && result.event, "wait-timed-out");
  assert.equal("phase" in result && result.phase, "queued");
  assert.equal("progressMessage" in result && typeof result.progressMessage, "string");
  const jobId = "jobId" in result ? result.jobId : "";
  assert.equal((await getJob(workspace, jobId)).job.status, "queued");
  await cancelJob(workspace, jobId);
});
