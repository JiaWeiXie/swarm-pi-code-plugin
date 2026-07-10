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
      json: true,
    },
  );
  assert.throws(() => parseArguments(["ask", "--host", "codex"]), /--prompt-file/);
  assert.throws(() => parseArguments(["ask", "--prompt-file", "prompt.md"]), /--host/);
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
  const session: RunnableSession = {
    subscribe(listener) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      });
      return () => {};
    },
    async prompt(prompt) {
      assert.equal(prompt, "Question from file");
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
      json: true,
    },
    "/workspace",
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
    { command: "implement", host: "codex", promptFile: "prompt.md", json: true },
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
    { command: "implement", host: "codex", promptFile: "prompt.md", json: true },
    workspace,
    dependencies,
  );
  assert.equal("status" in result && result.status, "failed");
  assert.match("output" in result ? result.output : "", /clean worktree/i);
});
