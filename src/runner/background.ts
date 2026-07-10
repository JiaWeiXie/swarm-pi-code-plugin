import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { jobDirectory } from "../state/jobs.js";

export interface SpawnBackgroundWorkerOptions {
  cwd: string;
  jobId: string;
  workerToken: string;
}

export async function spawnBackgroundWorker(options: SpawnBackgroundWorkerOptions): Promise<number> {
  const runner = process.argv[1];
  if (!runner) throw new Error("Cannot resolve the Pi runner entry point for background execution");
  const directory = await jobDirectory(options.cwd, options.jobId);
  const stdout = fs.openSync(path.join(directory, "worker.stdout.log"), "a", 0o600);
  const stderr = fs.openSync(path.join(directory, "worker.stderr.log"), "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [runner, "__worker", "--job", options.jobId, "--worker-token", options.workerToken, "--json"],
      {
        cwd: options.cwd,
        detached: true,
        env: process.env,
        stdio: ["ignore", stdout, stderr],
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("Background worker did not report a process ID");
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}
