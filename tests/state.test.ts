import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clearConfiguration,
  loadState,
  resolveStateDir,
  saveProfile,
  setModelPriority,
} from "../src/state/state.js";

function repositoryFixture(): { repository: string; worktree: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-state-"));
  const worktree = `${repository}-feature`;
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-C", repository, "commit", "-m", "fixture"],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", repository, "worktree", "add", "-b", "feature", worktree], {
    stdio: "ignore",
  });
  return { repository: fs.realpathSync(repository), worktree: fs.realpathSync(worktree) };
}

async function withDataDir<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.SWARM_PI_CODE_DATA_DIR;
  if (value === undefined) delete process.env.SWARM_PI_CODE_DATA_DIR;
  else process.env.SWARM_PI_CODE_DATA_DIR = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SWARM_PI_CODE_DATA_DIR;
    else process.env.SWARM_PI_CODE_DATA_DIR = previous;
  }
}

test("linked worktrees resolve one shared state directory", async () => {
  const { repository, worktree } = repositoryFixture();
  await withDataDir(undefined, async () => {
    assert.equal(await resolveStateDir(repository), path.join(repository, ".swarm-pi-code"));
    assert.equal(await resolveStateDir(worktree), path.join(repository, ".swarm-pi-code"));

    await setModelPriority(repository, ["test/primary", "test/fallback"]);
    assert.deepEqual((await loadState(worktree)).config.modelPriority, [
      "test/primary",
      "test/fallback",
    ]);
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
      jobs: [{ id: "old-opencode-job" }],
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
    assert.deepEqual(reset.jobs, [{ id: "pi-job", status: "succeeded" }]);
  });
});
