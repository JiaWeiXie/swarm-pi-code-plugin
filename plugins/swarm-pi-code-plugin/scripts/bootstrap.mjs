#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dependency = path.join(
  pluginRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
);
const installLock = path.join(pluginRoot, ".installing-runtime");

export function ensureRuntime() {
  assertNodeVersion();
  if (existsSync(dependency)) return;
  if (process.env.SWARM_PI_CODE_PLUGIN_SKIP_BOOTSTRAP === "1") {
    throw new Error(`Pi runtime dependencies are missing in ${pluginRoot}`);
  }

  const ownsLock = acquireInstallLock();
  if (!ownsLock) return;

  try {
    process.stderr.write("swarm-pi-code-plugin: installing pinned Pi runtime dependencies...\n");
    const result = spawnSync(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: pluginRoot, encoding: "utf8" },
    );
    if (result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error("Unable to install swarm-pi-code-plugin runtime dependencies.");
    }
  } finally {
    rmSync(installLock, { recursive: true, force: true });
  }
}

function acquireInstallLock() {
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      mkdirSync(installLock);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (existsSync(dependency)) return false;
      const age = Date.now() - statSync(installLock).mtimeMs;
      if (age > 300_000) {
        rmSync(installLock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Pi runtime installation.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function assertNodeVersion() {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(
      `swarm-pi-code-plugin requires Node.js 22.19.0 or newer; found ${process.versions.node}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureRuntime();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
