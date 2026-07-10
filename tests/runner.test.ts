import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeSession, type RunnableSession } from "../src/pi/execute.js";
import { describeModels, selectModel, type PiModel } from "../src/pi/models.js";
import { parseArguments } from "../src/runner/args.js";
import { runCommand, type RunnerDependencies } from "../src/runner/run.js";

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

test("argument parsing requires host and prompt file for ask", () => {
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

test("ask runs through injected model and session dependencies", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-ask-"));
  const session: RunnableSession = {
    subscribe(listener) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      });
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
      subscribe() {
        return () => {};
      },
      async prompt() {
        assert.equal(options.mode, "implement");
        fs.writeFileSync(path.join(workspace, "file.txt"), "after\n");
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
});

test("implement rejects a dirty worktree before creating Pi session", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-dirty-"));
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
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
  assert.equal("status" in result && result.status, "failed");
  assert.match("output" in result ? result.output : "", /clean worktree/i);
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
      subscribe() {
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
      subscribe() {
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

test("orchestrate runs exactly three readonly perspectives and records artifacts", async () => {
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

  assert.equal(sessions, 3);
  assert.equal("success" in result && result.success, true);
  assert.match("output" in result ? result.output : "", /Correctness and failure modes/);
  const state = JSON.parse(
    fs.readFileSync(path.join(workspace, ".swarm-pi-code-plugin", "state.json"), "utf8"),
  );
  assert.equal(state.jobs.length, 1);
  const jobDir = path.join(workspace, ".swarm-pi-code-plugin", "jobs", state.jobs[0].id);
  assert.equal(fs.existsSync(path.join(jobDir, "request.json")), true);
  assert.equal(fs.existsSync(path.join(jobDir, "prompt.md")), true);
  assert.equal(fs.existsSync(path.join(jobDir, "result.json")), true);
});
