#!/usr/bin/env node

import { ensureRuntime } from "./bootstrap.mjs";

try {
  ensureRuntime();
  const { main } = await import("../runtime/cli.js");
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
