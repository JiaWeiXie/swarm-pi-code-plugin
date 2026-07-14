import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { jobWorktreeBranch } from "../src/git/job-worktree.js";
import { readJobPrompt } from "../src/state/jobs.js";
import { formatPruneReport, pruneJobs } from "../src/state/prune.js";
import {
  defaultState,
  loadState,
  resolveStateDir,
  writeState,
  type JobRecord,
} from "../src/state/state.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-07-14T12:00:00.000Z");
const OLD = "2026-07-01T12:00:00.000Z";

test("prune preview is read-only and reports retention blockers and orphan directories", async () => {
  const fixture = await createFixture([
    terminalJob("eligible"),
    terminalJob("pending", { notification: "pending" }),
    terminalJob("approval", { pendingApprovalId: "approval-1" }),
    terminalJob("host", { pendingHostRequestIds: ["request-1"] }),
    terminalJob("active"),
  ]);
  try {
    await writeArtifacts(fixture.cwd, "eligible", "payload");
    await writeArtifacts(fixture.cwd, "pending", "retain");
    await writeArtifacts(fixture.cwd, "approval", "retain");
    await writeArtifacts(fixture.cwd, "host", "retain");
    await writeArtifacts(fixture.cwd, "active", "retain");
    await fs.writeFile(
      path.join(await resolveStateDir(fixture.cwd), "jobs", "active", "heartbeat.json"),
      `${JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() })}\n`,
    );
    const orphan = path.join(await resolveStateDir(fixture.cwd), "jobs", "orphan-job");
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, "log.txt"), "orphan");
    const stateFile = path.join(await resolveStateDir(fixture.cwd), "state.json");
    const before = await fs.readFile(stateFile, "utf8");

    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: false,
      now: NOW,
    });

    assert.equal(report.mode, "preview");
    assert.equal(report.summary.eligible, 1);
    assert.equal(report.jobs.find((job) => job.jobId === "pending")?.eligible, false);
    assert.deepEqual(report.jobs.find((job) => job.jobId === "approval")?.reasons, [
      "pending-approval",
    ]);
    assert.deepEqual(report.jobs.find((job) => job.jobId === "host")?.reasons, [
      "pending-host-assistance",
    ]);
    assert.deepEqual(report.jobs.find((job) => job.jobId === "active")?.reasons, ["active-worker"]);
    assert.deepEqual(report.orphans, ["orphan-job"]);
    assert.ok(report.summary.estimatedBytes > 0);
    assert.equal(await fs.readFile(stateFile, "utf8"), before);
    assert.equal(
      await fs.readFile(
        path.join(await resolveStateDir(fixture.cwd), "jobs", "eligible", "prompt.md"),
        "utf8",
      ),
      "payload",
    );
    assert.match(formatPruneReport(report), /eligible/);
  } finally {
    await fixture.cleanup();
  }
});

test("prune apply deletes artifacts and leaves a compact tombstone", async () => {
  const fixture = await createFixture([terminalJob("done")]);
  try {
    await writeArtifacts(fixture.cwd, "done", "large prompt");
    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });

    assert.equal(report.success, true);
    assert.equal(report.summary.pruned, 1);
    assert.ok(report.summary.actualBytes > 0);
    const state = await loadState(fixture.cwd, { migrateLegacy: false });
    const tombstone = state.jobs[0]!;
    assert.equal(tombstone.id, "done");
    assert.equal(tombstone.status, "succeeded");
    assert.equal(typeof tombstone.prunedAt, "string");
    assert.equal(tombstone.pruneOperation, undefined);
    assert.equal(tombstone.executionWorkspace, undefined);
    await assert.rejects(() => readJobPrompt(fixture.cwd, "done"), /artifacts were pruned/);
    const jobDirectory = path.join(await resolveStateDir(fixture.cwd), "jobs", "done");
    await assert.rejects(() => fs.stat(jobDirectory), /ENOENT/);

    const repeated = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });
    assert.equal(repeated.summary.pruned, 0);
    assert.deepEqual(repeated.jobs[0]!.reasons, ["already-pruned"]);
  } finally {
    await fixture.cleanup();
  }
});

test("prune resumes after a crash at every durable phase", async (context) => {
  for (const targetPhase of ["claimed", "workspace-cleaned", "quarantined", "artifacts-removed"]) {
    await context.test(targetPhase, async () => {
      const fixture = await createFixture([terminalJob(`resume-${targetPhase}`)]);
      const jobId = `resume-${targetPhase}`;
      try {
        await writeArtifacts(fixture.cwd, jobId, "recover me");
        const interrupted = await pruneJobs(fixture.cwd, {
          olderThanMs: 7 * 86_400_000,
          apply: true,
          now: NOW,
          afterPhase(_jobId, phase) {
            if (phase === targetPhase) throw new Error("simulated crash");
          },
        });
        assert.equal(interrupted.success, false);
        assert.equal(interrupted.summary.failed, 1);
        const interruptedState = await loadState(fixture.cwd, { migrateLegacy: false });
        assert.equal(
          (interruptedState.jobs[0]!.pruneOperation as { phase: string }).phase,
          targetPhase,
        );

        const resumed = await pruneJobs(fixture.cwd, {
          olderThanMs: 7 * 86_400_000,
          apply: true,
          now: NOW,
        });
        assert.equal(resumed.success, true);
        assert.equal(resumed.summary.pruned, 1);
        assert.equal(
          typeof (await loadState(fixture.cwd, { migrateLegacy: false })).jobs[0]!.prunedAt,
          "string",
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("one prune failure does not stop later jobs", async () => {
  const fixture = await createFixture([terminalJob("first"), terminalJob("second")]);
  try {
    await writeArtifacts(fixture.cwd, "first", "first");
    await writeArtifacts(fixture.cwd, "second", "second");
    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
      afterPhase(jobId, phase) {
        if (jobId === "first" && phase === "claimed") throw new Error("first failed");
      },
    });
    assert.equal(report.success, false);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.pruned, 1);
    const state = await loadState(fixture.cwd, { migrateLegacy: false });
    assert.equal(typeof state.jobs.find((job) => job.id === "second")?.prunedAt, "string");
  } finally {
    await fixture.cleanup();
  }
});

test("prune removes only a clean, disposable owned worktree", async () => {
  const fixture = await createFixture([]);
  const jobId = "worktree-job";
  const branch = jobWorktreeBranch(jobId);
  const worktree = path.join(fixture.root, "owned-worktree");
  try {
    const base = (await git(fixture.cwd, ["rev-parse", "HEAD"])).trim();
    await git(fixture.cwd, ["worktree", "add", "-b", branch, worktree, base]);
    const state = defaultState();
    state.jobs.push(
      terminalJob(jobId, {
        executionWorkspace: { worktree, branch, base },
        materializedAt: OLD,
      }),
    );
    await writeState(fixture.cwd, state);
    await writeArtifacts(fixture.cwd, jobId, "artifact");

    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });
    assert.equal(report.success, true);
    assert.equal(report.jobs[0]!.actions.worktree, "removed");
    assert.equal(report.jobs[0]!.actions.branch, "removed");
    await assert.rejects(() => fs.stat(worktree), /ENOENT/);
    await assert.rejects(() => git(fixture.cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  } finally {
    await fixture.cleanup();
  }
});

test("prune retains a dirty worktree", async () => {
  const fixture = await createFixture([]);
  const dirtyId = "dirty-job";
  const dirtyBranch = jobWorktreeBranch(dirtyId);
  const dirtyWorktree = path.join(fixture.root, "dirty-worktree");
  try {
    const base = (await git(fixture.cwd, ["rev-parse", "HEAD"])).trim();
    await git(fixture.cwd, ["worktree", "add", "-b", dirtyBranch, dirtyWorktree, base]);
    await fs.writeFile(path.join(dirtyWorktree, "dirty.txt"), "uncommitted");
    const state = defaultState();
    state.jobs.push(
      terminalJob(dirtyId, {
        executionWorkspace: { worktree: dirtyWorktree, branch: dirtyBranch, base },
        materializedAt: OLD,
      }),
    );
    await writeState(fixture.cwd, state);
    await writeArtifacts(fixture.cwd, dirtyId, "retain");

    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });
    assert.equal(report.summary.pruned, 0);
    assert.deepEqual(report.jobs[0]!.reasons, ["worktree-has-uncommitted-changes"]);
    assert.equal((await fs.stat(dirtyWorktree)).isDirectory(), true);
  } finally {
    await fixture.cleanup();
  }
});

test("prune retains a clean committed artifact that was not integrated", async () => {
  const fixture = await createFixture([]);
  const jobId = "unintegrated-job";
  const branch = jobWorktreeBranch(jobId);
  const worktree = path.join(fixture.root, "unintegrated-worktree");
  try {
    const base = (await git(fixture.cwd, ["rev-parse", "HEAD"])).trim();
    await git(fixture.cwd, ["worktree", "add", "-b", branch, worktree, base]);
    await fs.writeFile(path.join(worktree, "artifact.txt"), "recoverable\n");
    await git(worktree, ["add", "artifact.txt"]);
    await git(worktree, ["commit", "-m", "test: create recoverable artifact"]);
    const state = defaultState();
    state.jobs.push(
      terminalJob(jobId, {
        kind: "implement",
        executionWorkspace: { worktree, branch, base },
      }),
    );
    await writeState(fixture.cwd, state);
    await writeArtifacts(fixture.cwd, jobId, "retain");

    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });
    assert.equal(report.summary.pruned, 0);
    assert.deepEqual(report.jobs[0]!.reasons, ["recoverable-artifact"]);
    assert.equal((await fs.stat(worktree)).isDirectory(), true);
  } finally {
    await fixture.cleanup();
  }
});

test("prune retains a deliverable when its missing workspace cannot prove integration", async () => {
  const jobId = "missing-artifact";
  const fixture = await createFixture([
    terminalJob(jobId, {
      kind: "implement",
      executionWorkspace: {
        worktree: path.join(os.tmpdir(), "missing-prune-worktree"),
        branch: jobWorktreeBranch(jobId),
        base: "missing",
      },
    }),
  ]);
  try {
    await writeArtifacts(fixture.cwd, jobId, "retain");
    const directory = path.join(await resolveStateDir(fixture.cwd), "jobs", jobId);
    await fs.writeFile(
      path.join(directory, "result.json"),
      `${JSON.stringify({
        status: "succeeded",
        artifact: { deliverable: true, kind: "implementation", commit: "deadbeef" },
      })}\n`,
    );

    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });
    assert.equal(report.summary.pruned, 0);
    assert.deepEqual(report.jobs[0]!.reasons, ["recoverable-artifact"]);
    assert.equal((await fs.stat(directory)).isDirectory(), true);
  } finally {
    await fixture.cleanup();
  }
});

test("prune rejects a symbolic-link artifact directory without following it", async () => {
  const fixture = await createFixture([terminalJob("linked")]);
  try {
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "keep\n");
    const jobsDirectory = path.join(await resolveStateDir(fixture.cwd), "jobs");
    await fs.mkdir(jobsDirectory, { recursive: true });
    await fs.symlink(outside, path.join(jobsDirectory, "linked"));

    const report = await pruneJobs(fixture.cwd, {
      olderThanMs: 7 * 86_400_000,
      apply: true,
      now: NOW,
    });
    assert.equal(report.summary.pruned, 0);
    assert.deepEqual(report.jobs[0]!.reasons, ["artifact-directory-is-symbolic-link"]);
    assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "keep\n");
  } finally {
    await fixture.cleanup();
  }
});

function terminalJob(id: string, patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    host: "codex",
    kind: "ask",
    status: "succeeded",
    createdAt: OLD,
    startedAt: OLD,
    finishedAt: OLD,
    updatedAt: OLD,
    notification: "acknowledged",
    notifications: [
      {
        id: `terminal:${id}`,
        kind: "terminal",
        status: "acknowledged",
        createdAt: OLD,
        acknowledgedAt: OLD,
      },
    ],
    ...patch,
  };
}

async function createFixture(jobs: JobRecord[]): Promise<{
  root: string;
  cwd: string;
  cleanup(): Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-prune-test-"));
  const cwd = path.join(root, "repo");
  await fs.mkdir(cwd);
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.name", "Prune Test"]);
  await git(cwd, ["config", "user.email", "prune@example.test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(cwd, "README.md"), "fixture\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "test: initialize fixture"]);
  const state = defaultState();
  state.jobs = structuredClone(jobs);
  await writeState(cwd, state);
  return { root, cwd, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function writeArtifacts(cwd: string, jobId: string, prompt: string): Promise<void> {
  const directory = path.join(await resolveStateDir(cwd), "jobs", jobId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "prompt.md"), prompt);
  await fs.writeFile(path.join(directory, "request.json"), `${JSON.stringify({ id: jobId })}\n`);
  await fs.writeFile(
    path.join(directory, "result.json"),
    `${JSON.stringify({ status: "succeeded" })}\n`,
  );
  await fs.writeFile(path.join(directory, "worker.log"), "log output\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}
