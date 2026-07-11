import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkerRequest } from "../src/core/contracts.js";
import { prepareJobWorktree } from "../src/git/job-worktree.js";
import { checkpointScaffold, materializeScaffold, prepareScaffoldWorkspace } from "../src/git/scaffold.js";
import { assessWorkspace, inspectWorktree } from "../src/git/worktree.js";
import { consumeContinuation, createContinuation, readContinuation } from "../src/onboarding/continuations.js";
import type { PiModel } from "../src/pi/models.js";
import { runCommand, type RunnerDependencies } from "../src/runner/run.js";
import { loadState, resolveStateDir, StateMigrationConflictError, updateState } from "../src/state/state.js";

const fakeModel = { provider: "test", id: "model", name: "Test" } as PiModel;

function repositoryFixture(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-hygiene-"));
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", repository, "commit", "-m", "fixture"], { stdio: "ignore" });
  return repository;
}

test("workspace assessment permits only untracked generated artifacts", async () => {
  const repository = repositoryFixture();
  fs.writeFileSync(path.join(repository, ".DS_Store"), "metadata");
  fs.mkdirSync(path.join(repository, "src", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src", "__pycache__", "app.pyc"), "cache");
  assert.equal((await assessWorkspace(repository)).disposition, "safe-dirty");
  assert.equal((await inspectWorktree(repository)).clean, true);

  execFileSync("git", ["-C", repository, "add", ".DS_Store"]);
  assert.equal((await assessWorkspace(repository)).disposition, "user-dirty");
});

test("continuations are workspace-bound and single use", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-continuation-"));
  const request: WorkerRequest = {
    host: "codex", kind: "ask", cwd: workspace, prompt: "Inspect", mode: "readonly",
    executionMode: "supervised", sandboxMode: "strict", timeoutMs: 30_000,
  };
  const created = await createContinuation(workspace, request);
  assert.equal((await readContinuation(workspace, created.id)).request.prompt, "Inspect");
  await consumeContinuation(workspace, created.id);
  await assert.rejects(() => readContinuation(workspace, created.id), /unavailable/);
});

test("continuations reject Git HEAD and dirty-content drift", async () => {
  const repository = repositoryFixture();
  const request: WorkerRequest = {
    host: "codex", kind: "ask", cwd: repository, prompt: "Inspect", mode: "readonly",
    executionMode: "supervised", sandboxMode: "strict", timeoutMs: 30_000,
  };
  const committed = await createContinuation(repository, request);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "next commit\n");
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", repository, "commit", "-am", "next"], { stdio: "ignore" });
  await assert.rejects(() => readContinuation(repository, committed.id), /workspace changed/);

  fs.writeFileSync(path.join(repository, "tracked.txt"), "first dirty value\n");
  const dirty = await createContinuation(repository, request);
  assert.equal((await readContinuation(repository, dirty.id)).id, dirty.id);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "second dirty value\n");
  await assert.rejects(() => readContinuation(repository, dirty.id), /workspace changed/);
});

test("resume uses the durable prompt after the host temporary file is gone", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-resume-"));
  const created = await createContinuation(workspace, {
    host: "codex", kind: "ask", cwd: workspace, prompt: "Durable request", mode: "readonly",
    executionMode: "supervised", sandboxMode: "strict", timeoutMs: 30_000,
  });
  let received = "";
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => { throw new Error("resume must not read a prompt file"); },
    createSession: async () => ({
      subscribe(listener) {
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt(prompt) { received = prompt; },
      dispose() {},
    }),
  };
  const result = await runCommand({
    command: "resume", continuationId: created.id, reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("success" in result && result.success, true);
  assert.match(received, /Durable request/);
  await assert.rejects(() => readContinuation(workspace, created.id), /unavailable/);
});

test("status treats a non-Git folder as degraded rather than blocked when a model is ready", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-readiness-"));
  await updateState(workspace, (state) => { state.config.modelPriority = ["test/model"]; });
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "",
    createSession: async () => { throw new Error("status must not create a session"); },
  };
  const result = await runCommand({ command: "status", reconfigure: false, reset: false, json: true }, workspace, dependencies);
  assert.equal("status" in result && result.status, "degraded");
  assert.equal("workspace" in result && result.workspace.disposition, "non-git-empty");
});

test("scaffold remains staged until an explicit materialize command", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-scaffold-host-"));
  const target = path.join(workspace, "new-app");
  const spec = JSON.stringify({ version: 1, request: "Create the approved fixture", projectName: "new-app", targetMode: "empty" });
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => spec,
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: scaffold matches the request" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") fs.writeFileSync(path.join(options.cwd, "README.md"), "# New app\n");
      },
      dispose() {},
    }),
  };
  const result = await runCommand({
    command: "scaffold", host: "codex", specFile: "spec.json", target,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("success" in result && result.success, true);
  assert.equal("artifact" in result && result.artifact?.deliverable, true);
  assert.equal(fs.existsSync(target), false);
  const staging = "artifact" in result ? result.artifact?.worktree : undefined;
  const jobId = "jobId" in result ? result.jobId! : "";
  const materialized = await runCommand({
    command: "jobs", jobsAction: "materialize", jobId,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("materialized" in materialized && materialized.materialized, true);
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "# New app\n");
  assert.equal(execFileSync("git", ["-C", target, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.equal(Boolean(staging && fs.existsSync(staging)), false);
});

test("scaffold adoption requires explicit confirmation before a worker starts", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-adopt-host-"));
  const target = path.join(workspace, "existing-app");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "README.md"), "existing\n");
  let sessions = 0;
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => JSON.stringify({
      version: 1, request: "Adopt the existing project", projectName: "existing-app", targetMode: "adopt",
    }),
    createSession: async () => {
      sessions += 1;
      throw new Error("worker must not start before adoption is confirmed");
    },
  };
  const result = await runCommand({
    command: "scaffold", host: "codex", specFile: "spec.json", target,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("event" in result && result.event, "workspace-action-required");
  assert.equal(sessions, 0);
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "existing\n");
});

test("materialization fails closed for preserved-path collisions and rolls back bookkeeping failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-materialize-safety-"));
  const target = path.join(root, "app");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, ".env"), "USER_SECRET=keep\n");
  fs.writeFileSync(path.join(target, "README.md"), "original\n");
  const workspace = await prepareScaffoldWorkspace(root, target, `collision-${Date.now()}`, {
    version: 1, request: "Adopt", projectName: "app", targetMode: "adopt",
  });
  fs.writeFileSync(path.join(workspace.worktree, ".env"), "SCAFFOLD=value\n");
  const collisionCommit = await checkpointScaffold(workspace, "collision");
  const result = {
    kind: "scaffold" as const,
    status: "succeeded" as const,
    success: true,
    output: "",
    model: "test/model",
    changedFiles: [],
    diffStat: "",
    verification: { status: "passed" as const, commands: [] },
    artifact: { worktree: workspace.worktree, branch: workspace.branch, commit: collisionCommit, deliverable: true },
  };
  await assert.rejects(
    () => materializeScaffold({ workspace, result }),
    /artifact also contains preserved path \.env/,
  );
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "USER_SECRET=keep\n");

  fs.unlinkSync(path.join(workspace.worktree, ".env"));
  fs.writeFileSync(path.join(workspace.worktree, "README.md"), "artifact\n");
  const rollbackCommit = await checkpointScaffold(workspace, "rollback");
  await assert.rejects(
    () => materializeScaffold({
      workspace,
      result: { ...result, artifact: { ...result.artifact, commit: rollbackCommit } },
      afterSwap: async () => { throw new Error("state update failed"); },
    }),
    /state update failed/,
  );
  assert.equal(fs.readFileSync(path.join(target, "README.md"), "utf8"), "original\n");
  assert.equal(fs.readFileSync(path.join(target, ".env"), "utf8"), "USER_SECRET=keep\n");
});

test("materialization does not create a legacy and Git state conflict", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-runtime-conflict-"));
  const target = path.join(root, "app");
  fs.mkdirSync(path.join(target, ".swarm-pi-code-plugin"), { recursive: true });
  fs.writeFileSync(path.join(target, ".swarm-pi-code-plugin", "state.json"), "{}\n");
  const workspace = await prepareScaffoldWorkspace(root, target, `runtime-${Date.now()}`, {
    version: 1, request: "Adopt", projectName: "app", targetMode: "adopt",
  });
  const commit = await checkpointScaffold(workspace, "runtime");
  const stateDir = path.join(root, "control-state");
  fs.mkdirSync(stateDir);
  await assert.rejects(
    () => materializeScaffold({
      workspace,
      stateDir,
      result: {
        kind: "scaffold", status: "succeeded", success: true, output: "", model: "test/model",
        changedFiles: [], diffStat: "", verification: { status: "passed", commands: [] },
        artifact: { worktree: workspace.worktree, branch: workspace.branch, commit, deliverable: true },
      },
    }),
    /legacy runtime state/,
  );
  assert.equal(fs.existsSync(path.join(target, ".swarm-pi-code-plugin", "state.json")), true);
});

test("materializing into the current non-Git workspace moves runtime state behind the new Git boundary", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-current-scaffold-"));
  await updateState(workspace, (state) => { state.config.modelPriority = ["test/model"]; });
  const oldStateDir = await resolveStateDir(workspace);
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => JSON.stringify({
      version: 1, request: "Create a project here", projectName: "current-app", targetMode: "empty",
    }),
    createSession: async (options) => ({
      subscribe(listener) {
        if (options.mode === "readonly") {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "VERIFIED: ready" } });
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        return () => {};
      },
      async prompt() {
        if (options.mode === "implement") fs.writeFileSync(path.join(options.cwd, "README.md"), "# Current app\n");
      },
      dispose() {},
    }),
  };
  const result = await runCommand({
    command: "scaffold", host: "codex", specFile: "spec.json", target: workspace,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  assert.equal("success" in result && result.success, true);
  const jobId = "jobId" in result ? result.jobId! : "";
  await runCommand({
    command: "jobs", jobsAction: "materialize", jobId,
    reconfigure: false, reset: false, json: true,
  }, workspace, dependencies);
  const newStateDir = await resolveStateDir(workspace);
  assert.notEqual(newStateDir, oldStateDir);
  assert.equal(newStateDir, path.join(fs.realpathSync(workspace), ".git", "swarm-pi-code-plugin"));
  assert.equal(fs.existsSync(path.join(newStateDir, "state.json")), true);
  assert.equal(fs.existsSync(oldStateDir), false);
  assert.deepEqual((await loadState(workspace)).config.modelPriority, ["test/model"]);
});

test("isolated snapshot preserves tracked rename and deletion without changing the source worktree", async () => {
  const repository = repositoryFixture();
  fs.renameSync(path.join(repository, "tracked.txt"), path.join(repository, "renamed.txt"));
  fs.writeFileSync(path.join(repository, "untracked.txt"), "local\n");
  const artifact = await prepareJobWorktree(repository, `snapshot-${Date.now()}`, "isolated-snapshot");
  try {
    assert.equal(fs.existsSync(path.join(artifact.worktree, "tracked.txt")), false);
    assert.equal(fs.readFileSync(path.join(artifact.worktree, "renamed.txt"), "utf8"), "fixture\n");
    assert.equal(fs.readFileSync(path.join(artifact.worktree, "untracked.txt"), "utf8"), "local\n");
    assert.equal(fs.existsSync(path.join(repository, "tracked.txt")), false);
    assert.equal(fs.readFileSync(path.join(repository, "renamed.txt"), "utf8"), "fixture\n");
  } finally {
    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", artifact.worktree]);
    execFileSync("git", ["-C", repository, "branch", "-D", artifact.branch], { stdio: "ignore" });
  }
});

test("current project state migrates into the common Git directory and conflicts fail closed", async () => {
  const repository = repositoryFixture();
  const legacy = path.join(repository, ".swarm-pi-code-plugin");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "state.json"), JSON.stringify({ version: 1, config: {}, jobs: [] }));
  const state = await loadState(repository);
  assert.equal(state.migration?.source, ".swarm-pi-code-plugin");
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(path.join(await resolveStateDir(repository), "state.json")), true);

  const conflictRepository = repositoryFixture();
  const conflictLegacy = path.join(conflictRepository, ".swarm-pi-code-plugin");
  const conflictDestination = await resolveStateDir(conflictRepository);
  fs.mkdirSync(conflictLegacy);
  fs.writeFileSync(path.join(conflictLegacy, "state.json"), "{}");
  fs.mkdirSync(conflictDestination, { recursive: true });
  fs.writeFileSync(path.join(conflictDestination, "state.json"), "{}");
  await assert.rejects(() => loadState(conflictRepository), StateMigrationConflictError);
});
