import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireWorktreeLease,
  assertWorktreeBaseline,
  captureWorktreeChanges,
  inspectWorktree,
  requireCleanWorktree,
  validateChangedPaths,
} from "../src/git/worktree.js";
import { resolveStateDir } from "../src/state/state.js";

function repositoryFixture(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-git-"));
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "before\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-C", repository, "commit", "-m", "fixture"],
    { stdio: "ignore" },
  );
  return repository;
}

test("clean preflight ignores state but rejects user changes", async () => {
  const repository = repositoryFixture();
  fs.mkdirSync(path.join(repository, ".swarm-pi-code-plugin"));
  fs.writeFileSync(path.join(repository, ".swarm-pi-code-plugin", "state.json"), "{}");
  fs.mkdirSync(path.join(repository, ".swarm-pi-code"));
  fs.writeFileSync(path.join(repository, ".swarm-pi-code", "state.json"), "{}");
  fs.mkdirSync(path.join(repository, ".swarm-code"));
  fs.writeFileSync(path.join(repository, ".swarm-code", "state.json"), "{}");
  assert.equal((await inspectWorktree(repository)).clean, true);
  await requireCleanWorktree(repository);

  fs.writeFileSync(path.join(repository, "tracked.txt"), "user change\n");
  const inspected = await inspectWorktree(repository);
  assert.equal(inspected.clean, false);
  assert.deepEqual(inspected.changedFiles, ["tracked.txt"]);
  await assert.rejects(() => requireCleanWorktree(repository), /clean worktree/i);
});

test("change capture reports tracked and untracked files after implementation", async () => {
  const repository = repositoryFixture();
  fs.writeFileSync(path.join(repository, "tracked.txt"), "after\n");
  fs.writeFileSync(path.join(repository, "new.txt"), "new\n");

  const changes = await captureWorktreeChanges(repository);
  assert.deepEqual(changes.changedFiles, ["new.txt", "tracked.txt"]);
  assert.match(changes.diff, /tracked\.txt/);
  assert.match(changes.diff, /new\.txt/);
  assert.match(changes.diffStat, /tracked\.txt/);
  assert.match(changes.diffStat, /new\.txt \(untracked\)/);
});

test("implementation leases serialize writers and preserve the HEAD baseline", async () => {
  const repository = repositoryFixture();
  const lease = await acquireWorktreeLease(repository, "job-one");
  await assert.rejects(
    () => acquireWorktreeLease(repository, "job-two"),
    /already owns this worktree/i,
  );
  await assertWorktreeBaseline(repository, lease.baseline);
  await lease.release();

  const replacement = await acquireWorktreeLease(repository, "job-two");
  await replacement.release();
});

test("a failed worktree baseline does not leave a stale lease", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-non-git-"));
  await assert.rejects(() => acquireWorktreeLease(workspace, "failed-job"));
  const leaseDirectory = path.join(await resolveStateDir(workspace), "worktree-leases");
  assert.deepEqual(fs.readdirSync(leaseDirectory), []);
});

test("postflight rejects changed symlinks that escape the worktree", async () => {
  const repository = repositoryFixture();
  fs.symlinkSync(os.tmpdir(), path.join(repository, "outside-link"));
  await assert.rejects(
    () => validateChangedPaths(repository, ["outside-link"]),
    /symlink points outside/i,
  );
});
