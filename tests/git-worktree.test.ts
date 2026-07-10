import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureWorktreeChanges,
  inspectWorktree,
  requireCleanWorktree,
} from "../src/git/worktree.js";

function repositoryFixture(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-git-"));
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repository, ".gitignore"), ".swarm-pi-code/\n");
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
  fs.mkdirSync(path.join(repository, ".swarm-pi-code"));
  fs.writeFileSync(path.join(repository, ".swarm-pi-code", "state.json"), "{}");
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
