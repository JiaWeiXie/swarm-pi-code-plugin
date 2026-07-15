import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkerResult } from "../src/core/contracts.js";
import { jobWatchFallbackMs } from "../src/cli.js";
import { type JobSnapshot, type JobWaitDependencies, waitForJob } from "../src/state/jobs.js";
import {
  StateObserverRegistry,
  type StateObserverHandle,
  type StateObserverSource,
} from "../src/state/state-observer.js";

class FakeWatcher extends EventEmitter {
  closeCalls = 0;

  close(): void {
    this.closeCalls++;
    this.emit("close");
  }
}

function fakeTimer() {
  let callback: (() => void) | undefined;
  return {
    setTimer(run: () => void): ReturnType<typeof setTimeout> {
      callback = run;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(): void {
      callback = undefined;
    },
    fire(): void {
      const run = callback;
      callback = undefined;
      run?.();
    },
  };
}

test("state observers share one process-local watcher and rearm after replacement", async () => {
  let watchCalls = 0;
  const notifications: Array<(eventType: string, filename: string | null) => void> = [];
  const watchers: FakeWatcher[] = [];
  const registry = new StateObserverRegistry({
    watchFile: (_stateFile, listener) => {
      watchCalls++;
      notifications.push(listener);
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
    scheduleRearm: (callback) => callback(),
  });
  const first = registry.acquire("/tmp/swarm/state.json");
  const second = registry.acquire("/tmp/swarm/state.json");
  assert.equal(watchCalls, 1);

  const generation = first.generation();
  notifications[0]?.("rename", "state.json");
  assert.equal(await first.waitForChange(generation, 10_000), "changed");
  assert.equal(watchCalls, 2);

  first.release();
  first.release();
  assert.equal(registry.size, 1);
  second.release();
  assert.equal(registry.size, 0);
  assert.equal(watchers[0]?.closeCalls, 1);
  assert.equal(watchers[1]?.closeCalls, 1);
});

test("observer creation and watcher failures wake safely into polling fallback", async () => {
  const timer = fakeTimer();
  const failed = new StateObserverRegistry({
    watchFile: () => {
      const error = new Error("too many files") as NodeJS.ErrnoException;
      error.code = "EMFILE";
      throw error;
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  const fallback = failed.acquire("/tmp/swarm/state.json");
  const waiting = fallback.waitForChange(fallback.generation(), 500);
  timer.fire();
  assert.equal(await waiting, "timeout");
  fallback.release();

  const watcher = new FakeWatcher();
  const registry = new StateObserverRegistry({
    watchFile: () => watcher as unknown as FSWatcher,
  });
  const observed = registry.acquire("/tmp/swarm/state.json");
  const generation = observed.generation();
  const changed = observed.waitForChange(generation, 10_000);
  watcher.emit("error", new Error("watch failed"));
  assert.equal(await changed, "changed");
  assert.ok(observed.generation() > generation);
  observed.release();
});

test("observer health selects the watch fallback and transient failures retry", async () => {
  let attempts = 0;
  let notify: ((eventType: string, filename: string | null) => void) | undefined;
  const watcher = new FakeWatcher();
  const registry = new StateObserverRegistry({
    watchFile: (_stateFile, listener) => {
      attempts++;
      if (attempts === 1) {
        const error = new Error("temporary watcher exhaustion") as NodeJS.ErrnoException;
        error.code = "EMFILE";
        throw error;
      }
      notify = listener;
      return watcher as unknown as FSWatcher;
    },
  });
  const observer = registry.acquire("/tmp/swarm/state.json");
  assert.equal(observer.isWatching(), false);
  assert.equal(jobWatchFallbackMs(observer), 500);

  const generation = observer.generation();
  const changed = observer.waitForChange(generation, 500);
  assert.equal(observer.isWatching(), true);
  assert.equal(jobWatchFallbackMs(observer), 5_000);
  notify?.("change", "state.json");
  assert.equal(await changed, "changed");
  observer.release();
});

test("one handle coalesces concurrent waits and close wakes the pending read", async () => {
  const watcher = new FakeWatcher();
  const registry = new StateObserverRegistry({
    watchFile: () => watcher as unknown as FSWatcher,
  });
  const observer = registry.acquire("/tmp/swarm/state.json");
  const generation = observer.generation();
  const first = observer.waitForChange(generation, 10_000);
  const second = observer.waitForChange(generation, 10_000);
  assert.equal(first, second);
  watcher.emit("close");
  assert.equal(await first, "changed");
  observer.release();
  assert.equal(registry.size, 0);
});

test("state-file rename events rearm the atomically replaced path", async () => {
  const notifications: Array<(eventType: string, filename: string | null) => void> = [];
  const watchers: FakeWatcher[] = [];
  const registry = new StateObserverRegistry({
    watchFile: (_stateFile, listener) => {
      notifications.push(listener);
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
    scheduleRearm: (callback) => callback(),
  });
  const observer = registry.acquire("/tmp/swarm/state.json");
  const firstGeneration = observer.generation();
  notifications[0]?.("rename", "state.json");
  assert.equal(observer.generation(), firstGeneration + 1);
  assert.equal(watchers.length, 2);

  const secondGeneration = observer.generation();
  const changed = observer.waitForChange(secondGeneration, 10_000);
  notifications[1]?.("change", "state.json");
  assert.equal(await changed, "changed");
  observer.release();
});

test("file observation survives atomic replacement of state.json", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-state-observer-"));
  const stateFile = path.join(directory, "state.json");
  fs.writeFileSync(stateFile, "before\n");
  const registry = new StateObserverRegistry();
  const observer = registry.acquire(stateFile);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    for (const value of ["after-one\n", "after-two\n"]) {
      const generation = observer.generation();
      const changed = observer.waitForChange(generation, 1_000);
      const replacement = path.join(directory, "state.tmp");
      fs.writeFileSync(replacement, value);
      fs.renameSync(replacement, stateFile);
      assert.equal(await changed, "changed");
      assert.equal(fs.readFileSync(stateFile, "utf8"), value);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    observer.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function terminalResult(): WorkerResult {
  return {
    kind: "ask",
    status: "succeeded",
    success: true,
    model: "test/model",
    output: "done",
    changedFiles: [],
    diffStat: "",
    verification: { status: "passed", commands: [] },
  };
}

function runningSnapshot(): JobSnapshot {
  return { job: { id: "job-1", status: "running" }, result: null };
}

function asWorkerResult(value: Awaited<ReturnType<typeof waitForJob>>): WorkerResult {
  if ("event" in value) assert.fail(`Expected worker result, received ${value.event}`);
  return value;
}

function observerSource(handle: StateObserverHandle): StateObserverSource {
  return { acquire: () => handle };
}

test("waitForJob closes the read-to-subscribe lost-wakeup window", async () => {
  let generation = 0;
  let reads = 0;
  let releases = 0;
  const waits: number[] = [];
  const result = terminalResult();
  const handle: StateObserverHandle = {
    isWatching: () => true,
    generation: () => generation,
    waitForChange: async (expected, timeoutMs) => {
      waits.push(timeoutMs);
      return generation === expected ? "timeout" : "changed";
    },
    release: () => {
      releases++;
    },
  };
  const dependencies: JobWaitDependencies = {
    observerSource: observerSource(handle),
    resolveStateFile: async () => "/tmp/swarm/state.json",
    readJob: async () => {
      reads++;
      if (reads === 1) {
        generation++;
        return runningSnapshot();
      }
      return { job: { id: "job-1", status: "succeeded" }, result };
    },
  };

  assert.equal(await waitForJob("/tmp", "job-1", 1_000, dependencies), result);
  assert.equal(reads, 2);
  assert.deepEqual(waits, [500]);
  assert.equal(releases, 1);
});

test("concurrent waitForJob calls share one observer and clean it up", async () => {
  let watchCalls = 0;
  let notify: ((eventType: string, filename: string | null) => void) | undefined;
  let terminal = false;
  const watchers: FakeWatcher[] = [];
  const registry = new StateObserverRegistry({
    watchFile: (_stateFile, listener) => {
      watchCalls++;
      notify = listener;
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
  });
  const results = new Map([
    ["job-1", terminalResult()],
    ["job-2", { ...terminalResult(), output: "done-2" }],
  ]);
  const dependencies: JobWaitDependencies = {
    observerSource: registry,
    resolveStateFile: async () => "/tmp/swarm/state.json",
    readJob: async (_cwd, jobId) =>
      terminal
        ? { job: { id: jobId, status: "succeeded" }, result: results.get(jobId)! }
        : { job: { id: jobId, status: "running" }, result: null },
  };

  const first = waitForJob("/tmp", "job-1", 1_000, dependencies);
  const second = waitForJob("/tmp", "job-2", 1_000, dependencies);
  for (let attempt = 0; attempt < 20 && watchCalls === 0; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(watchCalls, 1);
  terminal = true;
  notify?.("rename", "state.json");
  assert.equal(asWorkerResult(await first).output, "done");
  assert.equal(asWorkerResult(await second).output, "done-2");
  assert.equal(watchCalls, 2);
  assert.equal(registry.size, 0);
  assert.equal(watchers[0]?.closeCalls, 1);
  assert.equal(watchers[1]?.closeCalls, 1);
});

test("waitForJob preserves terminal fallback when the result artifact is missing", async () => {
  const handle: StateObserverHandle = {
    isWatching: () => false,
    generation: () => 0,
    waitForChange: async () => "timeout",
    release() {},
  };
  const result = await waitForJob("/tmp", "job-1", 1_000, {
    observerSource: observerSource(handle),
    resolveStateFile: async () => "/tmp/swarm/state.json",
    readJob: async () => ({
      job: { id: "job-1", status: "failed", kind: "ask" },
      result: null,
    }),
  });
  const terminal = asWorkerResult(result);
  assert.equal(terminal.status, "failed");
  assert.match(terminal.output, /without a result artifact/);
});

test("waitForJob bounds fallback by the deadline and releases after read failures", async () => {
  let now = 1_000;
  let releases = 0;
  const waits: number[] = [];
  const handle: StateObserverHandle = {
    isWatching: () => false,
    generation: () => 0,
    waitForChange: async (_generation, timeoutMs) => {
      waits.push(timeoutMs);
      now += timeoutMs;
      return "timeout";
    },
    release: () => {
      releases++;
    },
  };
  const dependencies: JobWaitDependencies = {
    now: () => now,
    observerSource: observerSource(handle),
    resolveStateFile: async () => "/tmp/swarm/state.json",
    readJob: async () => runningSnapshot(),
  };

  const result = await waitForJob("/tmp", "job-1", 120, dependencies);
  assert.equal("event" in result && result.event, "wait-timed-out");
  assert.deepEqual(waits, [120]);
  assert.equal(releases, 1);

  await assert.rejects(
    waitForJob("/tmp", "job-1", 120, {
      ...dependencies,
      readJob: async () => {
        throw new Error("read failed");
      },
    }),
    /read failed/,
  );
  assert.equal(releases, 2);
});

test("waitForJob preserves approval, host-assistance, and human-decision events", async () => {
  const handle: StateObserverHandle = {
    isWatching: () => false,
    generation: () => 0,
    waitForChange: async () => "timeout",
    release() {},
  };
  const base: Omit<JobWaitDependencies, "readJob"> = {
    observerSource: observerSource(handle),
    resolveStateFile: async () => "/tmp/swarm/state.json",
  };
  const snapshots = [
    {
      expected: "approval-required",
      snapshot: {
        job: {
          id: "job-1",
          status: "awaiting-approval",
          pendingApprovalId: "approval-1",
          approvals: [{ id: "approval-1" }],
        },
        result: null,
      },
    },
    {
      expected: "host-assistance-required",
      snapshot: {
        job: {
          id: "job-1",
          status: "awaiting-host",
          pendingHostRequestIds: ["request-1"],
          hostAssistanceRequests: [{ id: "request-1", kind: "context", status: "pending" }],
        },
        result: null,
      },
    },
    {
      expected: "human-decision-required",
      snapshot: {
        job: {
          id: "job-1",
          status: "awaiting-decision",
          pendingHostRequestIds: ["request-2"],
          hostAssistanceRequests: [{ id: "request-2", kind: "decision", status: "pending" }],
        },
        result: null,
      },
    },
  ] as const;

  for (const item of snapshots) {
    const result = await waitForJob("/tmp", "job-1", 1_000, {
      ...base,
      readJob: async () => item.snapshot as unknown as JobSnapshot,
    });
    assert.equal("event" in result && result.event, item.expected);
  }
});
