#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repositoryRoot = process.cwd();
const packagedRuntime = join(repositoryRoot, "plugins/swarm-pi-code-plugin/runtime");
const temporaryRoot = mkdtempSync(join(tmpdir(), "swarm-pi-code-plugin-runtime-"));
const compiledRuntime = join(temporaryRoot, "runtime");

try {
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      join(repositoryRoot, "tsconfig.plugin.json"),
      "--outDir",
      compiledRuntime,
      "--incremental",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );

  const expectedFiles = listFiles(compiledRuntime);
  const actualFiles = listFiles(packagedRuntime);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const differences = [
    ...expectedFiles.filter((file) => !actualSet.has(file)).map((file) => `missing packaged runtime file: ${file}`),
    ...actualFiles.filter((file) => !expectedSet.has(file)).map((file) => `unexpected packaged runtime file: ${file}`),
    ...expectedFiles
      .filter((file) => actualSet.has(file))
      .filter((file) => !readFileSync(join(compiledRuntime, file)).equals(readFileSync(join(packagedRuntime, file))))
      .map((file) => `runtime content differs: ${file}`),
  ];

  if (differences.length > 0) {
    throw new Error(`Checked-in packaged runtime has drifted from src/.\n${differences.join("\n")}`);
  }

  process.stdout.write("Packaged runtime matches a clean plugin compilation.\n");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const nested of listFiles(absolute)) files.push(join(entry.name, nested));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute));
    } else if (statSync(absolute).isFile()) {
      files.push(relative(root, absolute));
    }
  }
  return files.sort();
}
