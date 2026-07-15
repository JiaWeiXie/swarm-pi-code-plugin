import fs, {} from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
export async function canonicalStateFile(stateFile) {
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
export class StateObserverRegistry {
    entries = new Map();
    watchFile;
    setTimer;
    clearTimer;
    scheduleRearm;
    constructor(options = {}) {
        this.watchFile =
            options.watchFile ??
                ((stateFile, listener) => fs.watch(stateFile, (eventType, filename) => listener(eventType, filename?.toString() ?? null)));
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.scheduleRearm =
            options.scheduleRearm ??
                ((callback) => {
                    setTimeout(callback, 10);
                });
    }
    get size() {
        return this.entries.size;
    }
    acquire(stateFile) {
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
        let pending;
        return {
            isWatching: () => acquired.watcher !== undefined,
            generation: () => acquired.generation,
            waitForChange: (generation, timeoutMs) => {
                if (released)
                    return Promise.resolve("changed");
                if (!acquired.watcher)
                    this.start(key, acquired);
                if (!pending) {
                    const created = this.wait(acquired, generation, timeoutMs);
                    pending = created;
                    void created.promise.then(() => {
                        if (pending === created)
                            pending = undefined;
                    });
                }
                return pending.promise;
            },
            release: () => {
                if (released)
                    return;
                released = true;
                pending?.cancel();
                pending = undefined;
                acquired.references--;
                if (acquired.references === 0)
                    this.dispose(key, acquired);
            },
        };
    }
    start(key, entry) {
        try {
            const watcher = this.watchFile(key, (eventType) => {
                if (entry.watcher !== watcher)
                    return;
                if (eventType === "rename") {
                    this.rearm(key, entry, watcher);
                }
                else {
                    this.signal(entry);
                }
            });
            watcher.on("error", () => this.stopWatching(entry, watcher));
            watcher.on("close", () => this.stopWatching(entry, watcher));
            entry.watcher = watcher;
        }
        catch {
            // Creation errors, including EMFILE, deliberately degrade to timer polling.
        }
    }
    rearm(key, entry, watcher) {
        if (entry.watcher !== watcher)
            return;
        entry.watcher = undefined;
        try {
            watcher.close();
        }
        catch {
            // The replacement itself is already an authoritative re-read hint.
        }
        this.scheduleRearm(() => {
            if (this.entries.get(key) !== entry || entry.watcher)
                return;
            this.start(key, entry);
            this.signal(entry);
        });
    }
    stopWatching(entry, watcher) {
        if (entry.watcher !== watcher)
            return;
        entry.watcher = undefined;
        try {
            watcher.close();
        }
        catch {
            // A failed or already closed watcher still degrades safely to polling.
        }
        this.signal(entry);
    }
    signal(entry) {
        entry.generation++;
        for (const finish of entry.waiters)
            finish("changed");
    }
    wait(entry, generation, timeoutMs) {
        if (entry.generation !== generation) {
            return { promise: Promise.resolve("changed"), cancel() { } };
        }
        let finish;
        const promise = new Promise((resolve) => {
            let settled = false;
            let timer;
            finish = (outcome) => {
                if (settled)
                    return;
                settled = true;
                if (timer !== undefined)
                    this.clearTimer(timer);
                entry.waiters.delete(finish);
                resolve(outcome);
            };
            entry.waiters.add(finish);
            timer = this.setTimer(() => finish("timeout"), Math.max(0, timeoutMs));
            if (entry.generation !== generation)
                finish("changed");
        });
        return { promise, cancel: () => finish("changed") };
    }
    dispose(key, entry) {
        if (this.entries.get(key) !== entry)
            return;
        this.entries.delete(key);
        const watcher = entry.watcher;
        entry.watcher = undefined;
        try {
            watcher?.close();
        }
        catch {
            // Disposal remains idempotent even if the watcher already failed.
        }
        this.signal(entry);
    }
}
export const stateObservers = new StateObserverRegistry();
