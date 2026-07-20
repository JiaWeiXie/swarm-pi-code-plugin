import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkerResult } from "../src/core/contracts.js";
import { WORKFLOW_BOUNDS } from "../src/orchestration/roles.js";
import {
  acknowledgeJob,
  attachJobProcess,
  cancelJob,
  getJob,
  finishJob,
  jobDirectory,
  listJobs,
  reconcileJobs,
  startJob,
  waitForJob,
} from "../src/state/jobs.js";
import {
  clearConfiguration,
  defaultState,
  loadState,
  prepareConfigurationStorage,
  resolveStateDir,
  resolveStateFile,
  saveProfile,
  setSandboxMode,
  setModelPriority,
  updateState,
  writeState,
  StateMigrationActiveJobsError,
} from "../src/state/state.js";
import { readTelemetryEvents } from "../src/telemetry/store.js";

test("new configuration defaults to adaptive without changing legacy normalization", () => {
  assert.equal(defaultState().config.sandboxMode, "adaptive");
  assert.equal(defaultState().config.hostAssistance?.reviewMode, "host-first");
  assert.equal(defaultState().config.hostAssistance?.autoApprovalScope, "reversible");
  assert.equal(defaultState().config.hostAssistance?.autoApproveDiscoveryGates, true);
});

test("legacy Host Assistance settings do not gain Host-first authority on load", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-legacy-host-policy-"));
  await updateState(workspace, () => {});
  const stateFile = await resolveStateFile(workspace);
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    config: { hostAssistance: Record<string, unknown> };
  };
  delete raw.config.hostAssistance.reviewMode;
  delete raw.config.hostAssistance.autoApprovalScope;
  delete raw.config.hostAssistance.autoApproveDiscoveryGates;
  fs.writeFileSync(stateFile, `${JSON.stringify(raw, null, 2)}\n`);
  const loaded = await loadState(workspace);
  assert.equal(loaded.config.hostAssistance?.reviewMode, "user-only");
  assert.equal(loaded.config.hostAssistance?.autoApprovalScope, "context-only");
  assert.equal(loaded.config.hostAssistance?.autoApproveDiscoveryGates, false);
});

test("legacy workflow values clamp to canonical bounds and malformed rules fail closed", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-legacy-workflow-bounds-"));
  await updateState(workspace, (state) => {
    state.config.contextBudget = 999;
    state.config.hostAssistance = {
      enabled: true,
      mode: "on",
      contextClasses: ["workspace"],
      privateConnector: "ask",
      maxRequests: 1,
      maxFanOut: 99,
    };
    state.config.advisor = {
      enabled: false,
      targets: ["review"],
      maxRequests: 99,
      maxPerspectives: 99,
    };
    state.config.adaptivePolicy = {
      classifierModels: [],
      classifierThinkingLevel: "medium",
      approvalPolicy: "deny",
      trustedDomains: [],
      rules: [
        { id: "valid", effect: "ask", capability: "shell.execute" },
        { id: "invalid", effect: "allow", capability: "invalid" as never },
      ],
      diagnostics: false,
    };
  });
  const loaded = await loadState(workspace);
  assert.equal(loaded.config.contextBudget, WORKFLOW_BOUNDS.contextBudget.max);
  assert.equal(loaded.config.hostAssistance?.maxFanOut, 1);
  assert.equal(loaded.config.advisor?.maxRequests, WORKFLOW_BOUNDS.advisor.requests.max);
  assert.equal(loaded.config.advisor?.maxPerspectives, WORKFLOW_BOUNDS.advisor.perspectives.max);
  assert.deepEqual(loaded.config.adaptivePolicy?.rules, [
    { id: "valid", effect: "ask", capability: "shell.execute" },
  ]);

  const stateFile = await resolveStateFile(workspace);
  const partial = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
    config: { hostAssistance: Record<string, unknown> };
  };
  partial.config.hostAssistance.maxRequests = 0;
  delete partial.config.hostAssistance.maxFanOut;
  fs.writeFileSync(stateFile, `${JSON.stringify(partial, null, 2)}\n`);
  const reloaded = await loadState(workspace);
  assert.equal(reloaded.config.hostAssistance?.maxRequests, 0);
  assert.equal(reloaded.config.hostAssistance?.maxFanOut, 0);
});

function workerResult(status: WorkerResult["status"] = "succeeded"): WorkerResult {
  return {
    kind: "ask",
    status,
    success: status === "succeeded",
    output: status === "succeeded" ? "done" : status,
    model: "test/model",
    changedFiles: [],
    diffStat: "",
    verification: { status: "not-run", commands: [] },
  };
}

test("adaptive role and approval settings survive state normalization", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-adaptive-state-"));
  await updateState(workspace, (state) => {
    state.config.sandboxMode = "adaptive";
    state.config.rolePolicies = {
      planner: { models: ["test/planner"], thinkingLevel: "xhigh", maxAttempts: 2 },
    };
    state.config.adaptivePolicy = {
      classifierModels: ["test/classifier"],
      classifierThinkingLevel: "medium",
      approvalPolicy: "wait",
      trustedDomains: ["registry.npmjs.org"],
      rules: [],
      diagnostics: true,
    };
    state.config.backgroundRolePolicy = { mechanicalExecutor: true };
  });
  const loaded = await loadState(workspace);
  assert.equal(loaded.config.sandboxMode, "adaptive");
  assert.equal(loaded.config.rolePolicies?.planner?.thinkingLevel, "xhigh");
  assert.equal(loaded.config.adaptivePolicy?.approvalPolicy, "wait");
  assert.equal(loaded.config.backgroundRolePolicy?.mechanicalExecutor, true);
});

function repositoryFixture(): { repository: string; worktree: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-state-"));
  const worktree = `${repository}-feature`;
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", repository, "commit", "-m", "fixture"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repository, "worktree", "add", "-b", "feature", worktree], {
    stdio: "ignore",
  });
  return { repository: fs.realpathSync(repository), worktree: fs.realpathSync(worktree) };
}

async function withDataDir<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.SWARM_PI_CODE_PLUGIN_DATA_DIR;
  if (value === undefined) delete process.env.SWARM_PI_CODE_PLUGIN_DATA_DIR;
  else process.env.SWARM_PI_CODE_PLUGIN_DATA_DIR = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SWARM_PI_CODE_PLUGIN_DATA_DIR;
    else process.env.SWARM_PI_CODE_PLUGIN_DATA_DIR = previous;
  }
}

function migrationEnvironment(root: string, dataDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SWARM_PI_CODE_PLUGIN_USER_STATE_DIR: root,
    ...(dataDir ? { SWARM_PI_CODE_PLUGIN_DATA_DIR: dataDir } : {}),
  };
}

function initUnbornRepository(directory: string): void {
  execFileSync("git", ["init", directory], { stdio: "ignore" });
}

test("configuration preparation reports and migrates non-Git user state after git init", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-user-state-migration-"));
  const userState = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-user-state-root-"));
  const env = migrationEnvironment(userState);
  const state = defaultState();
  state.config.modelPriority = ["test/primary"];
  await writeState(workspace, state, env);
  const source = await resolveStateDir(workspace, env);
  fs.mkdirSync(path.join(source, "jobs", "job-1"), { recursive: true });
  fs.writeFileSync(path.join(source, "model.json"), '{"primary":"test/primary"}\n');
  fs.writeFileSync(path.join(source, "jobs", "job-1", "artifact.txt"), "durable\n");

  initUnbornRepository(workspace);
  const destination = await resolveStateDir(workspace, env);
  const pending = await prepareConfigurationStorage(workspace, env, { migrate: false });
  assert.equal(pending.migrationStatus, "pending");
  assert.equal(pending.migratedFrom, source);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), false);

  const migrated = await prepareConfigurationStorage(workspace, env, { migrate: true });
  assert.equal(migrated.migrationStatus, "migrated");
  assert.equal(migrated.migratedFrom, source);
  assert.equal(fs.existsSync(source), false);
  assert.equal(
    fs.readFileSync(path.join(destination, "jobs", "job-1", "artifact.txt"), "utf8"),
    "durable\n",
  );
  const migratedState = JSON.parse(
    fs.readFileSync(path.join(destination, "state.json"), "utf8"),
  ) as {
    migration?: { source?: string; migratedAt?: string };
  };
  assert.equal(migratedState.migration?.source, "user-state-workspace");
  assert.equal(typeof migratedState.migration?.migratedAt, "string");
});

test("configuration preparation blocks active Jobs and leaves the source untouched", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-active-migration-"));
  const userState = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-active-state-root-"));
  const env = migrationEnvironment(userState);
  const state = defaultState();
  state.jobs = [{ id: "active", status: "running" }];
  await writeState(workspace, state, env);
  const source = await resolveStateDir(workspace, env);
  initUnbornRepository(workspace);

  const inspected = await prepareConfigurationStorage(workspace, env, { migrate: false });
  assert.equal(inspected.migrationStatus, "blocked");
  await assert.rejects(
    () => prepareConfigurationStorage(workspace, env, { migrate: true }),
    StateMigrationActiveJobsError,
  );
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(source, "state.json")), true);
});

test("subdirectory and root non-Git state candidates fail closed as a conflict", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-ambiguous-migration-"));
  const subdirectory = path.join(workspace, "packages", "app");
  fs.mkdirSync(subdirectory, { recursive: true });
  const userState = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-ambiguous-state-root-"));
  const env = migrationEnvironment(userState);
  await writeState(workspace, defaultState(), env);
  await writeState(subdirectory, defaultState(), env);
  const rootSource = await resolveStateDir(workspace, env);
  const subdirectorySource = await resolveStateDir(subdirectory, env);
  initUnbornRepository(workspace);

  const inspected = await prepareConfigurationStorage(subdirectory, env, { migrate: false });
  assert.equal(inspected.migrationStatus, "conflict");
  assert.equal(fs.existsSync(rootSource), true);
  assert.equal(fs.existsSync(subdirectorySource), true);
});

test("an explicit data directory disables Git-state migration", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-explicit-state-"));
  const userState = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-explicit-state-root-"));
  const dataDirectory = path.join(userState, "owned");
  const env = migrationEnvironment(userState, dataDirectory);
  await writeState(workspace, defaultState(), env);
  initUnbornRepository(workspace);

  const storage = await prepareConfigurationStorage(workspace, env, { migrate: true });
  assert.equal(storage.directory, dataDirectory);
  assert.equal(storage.migrationStatus, "none");
  assert.equal(fs.existsSync(path.join(dataDirectory, "state.json")), true);
});

test("linked worktrees resolve one shared state directory", async () => {
  const { repository, worktree } = repositoryFixture();
  await withDataDir(undefined, async () => {
    assert.equal(
      await resolveStateDir(repository),
      path.join(repository, ".git", "swarm-pi-code-plugin"),
    );
    assert.equal(
      await resolveStateDir(worktree),
      path.join(repository, ".git", "swarm-pi-code-plugin"),
    );

    await setModelPriority(repository, ["test/primary", "test/fallback"]);
    await setSandboxMode(repository, "lenient");
    assert.deepEqual((await loadState(worktree)).config.modelPriority, [
      "test/primary",
      "test/fallback",
    ]);
    assert.equal((await loadState(worktree)).config.sandboxMode, "lenient");
  });
});

test("state loading skips the migration lock when no current legacy directory exists", async () => {
  const { repository } = repositoryFixture();
  const gitDir = path.join(repository, ".git");
  const migrationLock = path.join(gitDir, "swarm-pi-code-plugin.migration.lock");
  const originalMode = fs.statSync(gitDir).mode & 0o777;
  fs.writeFileSync(migrationLock, "held by another process\n");
  fs.chmodSync(gitDir, originalMode & ~0o222);

  try {
    await withDataDir(undefined, async () => {
      const state = await loadState(repository);
      assert.deepEqual(state.config.modelPriority, []);
    });
    assert.equal(fs.readFileSync(migrationLock, "utf8"), "held by another process\n");
  } finally {
    fs.chmodSync(gitDir, originalMode);
  }
});

test("state normalization preserves omitted and explicit empty directory scopes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-profile-scope-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-profile-state-"));

  await withDataDir(stateDir, async () => {
    await saveProfile(workspace, { goal: "Whole repository", tasks: ["Analysis"] });
    assert.equal(Object.hasOwn((await loadState(workspace)).config.profile!, "dirs"), false);

    await saveProfile(workspace, { goal: "Deny repository access", dirs: [], tasks: ["Analysis"] });
    const explicitEmpty = (await loadState(workspace)).config.profile!;
    assert.equal(Object.hasOwn(explicitEmpty, "dirs"), true);
    assert.deepEqual(explicitEmpty.dirs, []);
  });
});

test("previous swarm-pi-code state migrates with configuration and Pi jobs", async () => {
  const { repository } = repositoryFixture();
  const previousDir = path.join(repository, ".swarm-pi-code");
  fs.mkdirSync(previousDir);
  fs.writeFileSync(
    path.join(previousDir, "state.json"),
    JSON.stringify({
      version: 1,
      config: {
        modelPriority: ["test/model"],
        availableModels: ["test/model"],
        availableModelsCheckedAt: "2026-07-10T00:00:00.000Z",
        profile: { goal: "existing Pi project", tasks: ["Implementation"] },
      },
      jobs: [{ id: "pi-job-1", status: "succeeded" }],
    }),
  );

  await withDataDir(undefined, async () => {
    const state = await loadState(repository);
    assert.deepEqual(state.config.modelPriority, ["test/model"]);
    assert.equal(state.config.profile?.goal, "existing Pi project");
    assert.deepEqual(state.jobs, [{ id: "pi-job-1", status: "succeeded" }]);
    assert.equal(state.config.sandboxMode, "strict");
    assert.equal(state.migration?.source, ".swarm-pi-code");
    assert.equal(
      fs.existsSync(path.join(repository, ".git", "swarm-pi-code-plugin", "state.json")),
      true,
    );
  });
});

test("data directory override wins and state writes are atomic", async () => {
  const { repository } = repositoryFixture();
  const override = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-override-"));
  await withDataDir(override, async () => {
    assert.equal(await resolveStateDir(repository), path.resolve(override));
    await saveProfile(repository, { goal: "ship", dirs: ["src"], tasks: ["Implementation"] });
    const files = fs.readdirSync(override);
    assert.deepEqual(files, ["state.json"]);
    assert.equal((await loadState(repository)).config.profile?.goal, "ship");
  });
});

test("legacy swarm-code profile and model preferences migrate without jobs", async () => {
  const { repository } = repositoryFixture();
  const legacyDir = path.join(repository, ".swarm-code");
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(
    path.join(legacyDir, "state.json"),
    JSON.stringify({
      config: {
        modelPriority: ["test/model"],
        swarmProfile: { goal: "legacy", dirs: ["src"], tasks: ["Code review"] },
      },
      jobs: [{ id: "old-worker-job" }],
    }),
  );

  await withDataDir(undefined, async () => {
    const state = await loadState(repository);
    assert.deepEqual(state.config.modelPriority, ["test/model"]);
    assert.equal(state.config.profile?.goal, "legacy");
    assert.deepEqual(state.jobs, []);
    assert.equal(state.migration?.source, ".swarm-code");
  });
});

test("reset clears configuration while preserving Pi job history", async () => {
  const { repository } = repositoryFixture();
  await withDataDir(undefined, async () => {
    await setModelPriority(repository, ["test/model"]);
    const statePath = path.join(await resolveStateDir(repository), "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.jobs = [{ id: "pi-job", status: "succeeded" }];
    fs.writeFileSync(statePath, JSON.stringify(state));

    await clearConfiguration(repository);
    const reset = await loadState(repository);
    assert.deepEqual(reset.config.modelPriority, []);
    assert.equal(reset.config.profile, undefined);
    assert.equal(reset.config.sandboxMode, "adaptive");
    assert.deepEqual(reset.jobs, [{ id: "pi-job", status: "succeeded" }]);
  });
});

test("concurrent state updates do not lose job records", async () => {
  const { repository } = repositoryFixture();
  await withDataDir(undefined, async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        updateState(repository, (state) => {
          state.jobs.push({ id: `job-${index}`, status: "done" });
        }),
      ),
    );
    const state = await loadState(repository);
    assert.equal(state.jobs.length, 12);
    assert.deepEqual(
      state.jobs.map((job) => job.id).sort(),
      Array.from({ length: 12 }, (_, index) => `job-${index}`).sort(),
    );
  });
});

test("job lifecycle persists terminal results and acknowledges notifications", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-job-lifecycle-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "Inspect",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 30_000,
  });

  assert.equal((await getJob(workspace, handle.id)).job.status, "queued");
  const cancelled = await cancelJob(workspace, handle.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await listJobs(workspace, true)).length, 1);
  assert.equal((await waitForJob(workspace, handle.id)).status, "cancelled");

  const acknowledged = await acknowledgeJob(workspace, handle.id);
  assert.equal(acknowledged.notification, "acknowledged");
  assert.equal((await listJobs(workspace, true)).length, 0);
});

test("terminal job results feed the local telemetry report", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-job-telemetry-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    role: "scout",
    prompt: "Inspect",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 30_000,
  });
  await finishJob(workspace, handle.id, {
    kind: "ask",
    status: "succeeded",
    success: true,
    output: "done",
    model: "test-provider/test-model",
    role: "scout",
    changedFiles: [],
    diffStat: "",
    verification: { status: "not-run", commands: [] },
    telemetry: {
      attempts: [
        {
          attempt: 1,
          startedAt: "2026-07-16T12:00:00.000Z",
          finishedAt: "2026-07-16T12:00:01.000Z",
          durationMs: 1000,
          outcome: "succeeded",
          provider: "test-provider",
          model: "test-model",
          usage: { provider: "test-provider", model: "test-model", inputTokens: 3 },
        },
      ],
    },
  });
  const stored = await readTelemetryEvents(await resolveStateDir(workspace));
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0]?.kind, "attempt");
});

test("reconciliation converts stale dead workers to orphaned", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-job-orphan-"));
  const handle = await startJob(workspace, {
    host: "claude",
    kind: "plan",
    prompt: "Plan",
    cwd: workspace,
    executionMode: "background",
    timeoutMs: 30_000,
  });
  await attachJobProcess(workspace, handle.id, handle.workerToken, 999_999);
  await updateState(workspace, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === handle.id)!;
    job.status = "running";
    job.updatedAt = "2000-01-01T00:00:00.000Z";
  });
  const directory = await jobDirectory(workspace, handle.id);
  fs.writeFileSync(
    path.join(directory, "heartbeat.json"),
    JSON.stringify({
      jobId: handle.id,
      workerToken: handle.workerToken,
      pid: 999_999,
      updatedAt: "2000-01-01T00:00:00.000Z",
    }),
  );

  await reconcileJobs(workspace);
  const snapshot = await getJob(workspace, handle.id);
  assert.equal(snapshot.job.status, "orphaned");
  assert.equal(snapshot.result?.status, "orphaned");
  assert.match(snapshot.result?.output ?? "", /disappeared/i);
});

test("reconciliation repairs state when result artifact already exists", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-job-repair-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "Inspect",
    cwd: workspace,
    executionMode: "supervised",
    timeoutMs: 30_000,
  });
  const result = { ...workerResult(), host: "codex", jobId: handle.id };
  fs.writeFileSync(
    path.join(await jobDirectory(workspace, handle.id), "result.json"),
    `${JSON.stringify(result)}\n`,
  );

  await reconcileJobs(workspace);
  const snapshot = await getJob(workspace, handle.id);
  assert.equal(snapshot.job.status, "succeeded");
  assert.equal(snapshot.job.notification, "pending");
  assert.equal(snapshot.result?.output, "done");
});

test("reconciliation preserves a stale heartbeat while the worker PID is alive", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-job-live-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "review",
    prompt: "Review",
    cwd: workspace,
    executionMode: "background",
    timeoutMs: 30_000,
  });
  await attachJobProcess(workspace, handle.id, handle.workerToken, process.pid);
  await updateState(workspace, (state) => {
    const job = state.jobs.find((candidate) => candidate.id === handle.id)!;
    job.status = "running";
    job.updatedAt = "2000-01-01T00:00:00.000Z";
  });
  fs.writeFileSync(
    path.join(await jobDirectory(workspace, handle.id), "heartbeat.json"),
    JSON.stringify({
      jobId: handle.id,
      workerToken: handle.workerToken,
      pid: process.pid,
      updatedAt: "2000-01-01T00:00:00.000Z",
    }),
  );

  await reconcileJobs(workspace);
  assert.equal((await getJob(workspace, handle.id)).job.status, "running");
});

test("the first terminal result wins concurrent completion races", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-job-terminal-race-"));
  const handle = await startJob(workspace, {
    host: "codex",
    kind: "ask",
    prompt: "Inspect",
    cwd: workspace,
    executionMode: "background",
    timeoutMs: 30_000,
  });

  await finishJob(workspace, handle.id, { ...workerResult("cancelled"), jobId: handle.id });
  await finishJob(workspace, handle.id, { ...workerResult("succeeded"), jobId: handle.id });

  const snapshot = await getJob(workspace, handle.id);
  assert.equal(snapshot.job.status, "cancelled");
  assert.equal(snapshot.result?.status, "cancelled");
});
