import fs, { type FSWatcher } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export type StateObserverWake = "changed" | "timeout";

export interface StateObserverHandle {
  isWatching(): boolean;
  generation(): number;
  waitForChange(generation: number, timeoutMs: number): Promise<StateObserverWake>;
  release(): void;
}

export interface StateObserverSource {
  acquire(stateFile: string): StateObserverHandle;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StateObserverOptions {
  watchFile?: (
    stateFile: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => FSWatcher;
  setTimer?: (callback: () => void, timeoutMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  scheduleRearm?: (callback: () => void) => void;
}

interface PendingWait {
  promise: Promise<StateObserverWake>;
  cancel(): void;
}

interface Entry {
  generation: number;
  watcher: FSWatcher | undefined;
  references: number;
  waiters: Set<(outcome: StateObserverWake) => void>;
}

export async function canonicalStateFile(stateFile: string): Promise<string> {
  const resolved = path.resolve(stateFile);
  const directory = await fsPromises
    .realpath(path.dirname(resolved))
    .catch(() => path.dirname(resolved));
  return path.join(directory, path.basename(resolved));
}

/**
 * Process-local shared observers for atomically replaced state files.
 * Events are re-read hints only; timer polling remains the correctness path.
 */
export class StateObserverRegistry implements StateObserverSource {
  private readonly entries = new Map<string, Entry>();
  private readonly watchFile: NonNullable<StateObserverOptions["watchFile"]>;
  private readonly setTimer: NonNullable<StateObserverOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<StateObserverOptions["clearTimer"]>;
  private readonly scheduleRearm: NonNullable<StateObserverOptions["scheduleRearm"]>;

  constructor(options: StateObserverOptions = {}) {
    this.watchFile =
      options.watchFile ??
      ((stateFile, listener) =>
        fs.watch(stateFile, (eventType, filename) =>
          listener(eventType, filename?.toString() ?? null),
        ));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.scheduleRearm =
      options.scheduleRearm ??
      ((callback) => {
        setTimeout(callback, 10);
      });
  }

  get size(): number {
    return this.entries.size;
  }

  acquire(stateFile: string): StateObserverHandle {
    const key = path.resolve(stateFile);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        generation: 0,
        watcher: undefined,
        references: 0,
        waiters: new Set(),
      };
      this.entries.set(key, entry);
      this.start(key, entry);
    }
    const acquired = entry;
    acquired.references++;
    let released = false;
    let pending: PendingWait | undefined;

    return {
      isWatching: () => acquired.watcher !== undefined,
      generation: () => acquired.generation,
      waitForChange: (generation, timeoutMs) => {
        if (released) return Promise.resolve("changed");
        if (!acquired.watcher) this.start(key, acquired);
        if (!pending) {
          const created = this.wait(acquired, generation, timeoutMs);
          pending = created;
          void created.promise.then(() => {
            if (pending === created) pending = undefined;
          });
        }
        return pending.promise;
      },
      release: () => {
        if (released) return;
        released = true;
        pending?.cancel();
        pending = undefined;
        acquired.references--;
        if (acquired.references === 0) this.dispose(key, acquired);
      },
    };
  }

  private start(key: string, entry: Entry): void {
    try {
      const watcher = this.watchFile(key, (eventType) => {
        if (entry.watcher !== watcher) return;
        if (eventType === "rename") {
          this.rearm(key, entry, watcher);
        } else {
          this.signal(entry);
        }
      });
      watcher.on("error", () => this.stopWatching(entry, watcher));
      watcher.on("close", () => this.stopWatching(entry, watcher));
      entry.watcher = watcher;
    } catch {
      // Creation errors, including EMFILE, deliberately degrade to timer polling.
    }
  }

  private rearm(key: string, entry: Entry, watcher: FSWatcher): void {
    if (entry.watcher !== watcher) return;
    entry.watcher = undefined;
    try {
      watcher.close();
    } catch {
      // The replacement itself is already an authoritative re-read hint.
    }
    this.scheduleRearm(() => {
      if (this.entries.get(key) !== entry || entry.watcher) return;
      this.start(key, entry);
      this.signal(entry);
    });
  }

  private stopWatching(entry: Entry, watcher: FSWatcher): void {
    if (entry.watcher !== watcher) return;
    entry.watcher = undefined;
    try {
      watcher.close();
    } catch {
      // A failed or already closed watcher still degrades safely to polling.
    }
    this.signal(entry);
  }

  private signal(entry: Entry): void {
    entry.generation++;
    for (const finish of entry.waiters) finish("changed");
  }

  private wait(entry: Entry, generation: number, timeoutMs: number): PendingWait {
    if (entry.generation !== generation) {
      return { promise: Promise.resolve("changed"), cancel() {} };
    }

    let finish!: (outcome: StateObserverWake) => void;
    const promise = new Promise<StateObserverWake>((resolve) => {
      let settled = false;
      let timer: TimerHandle | undefined;
      finish = (outcome) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) this.clearTimer(timer);
        entry.waiters.delete(finish);
        resolve(outcome);
      };
      entry.waiters.add(finish);
      timer = this.setTimer(() => finish("timeout"), Math.max(0, timeoutMs));
      if (entry.generation !== generation) finish("changed");
    });
    return { promise, cancel: () => finish("changed") };
  }

  private dispose(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    const watcher = entry.watcher;
    entry.watcher = undefined;
    try {
      watcher?.close();
    } catch {
      // Disposal remains idempotent even if the watcher already failed.
    }
    this.signal(entry);
  }
}

export const stateObservers = new StateObserverRegistry();
