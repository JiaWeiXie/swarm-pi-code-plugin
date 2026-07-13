#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const automatic = process.argv.includes("--automatic");
const uninstall = process.argv.includes("--uninstall");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
  if (process.env.CI === "true" || process.env.CI === "1") {
    console.log("Skipping repository Git hook installation in CI.");
    return 0;
  }
  let current;
  try {
    current = git(["config", "--local", "--get", "core.hooksPath"]);
  } catch {
    current = "";
  }
  if (uninstall) {
    if (!current || current === ".githooks") {
      try {
        git(["config", "--local", "--unset", "core.hooksPath"]);
      } catch {}
      console.log("Repository Git hook path removed.");
      return 0;
    }
    console.error(`Refusing to remove a different local core.hooksPath: ${current}`);
    return automatic ? 0 : 2;
  }
  if (current === ".githooks") {
    console.log("Repository Git hooks are already enabled.");
    return 0;
  }
  if (current) {
    console.error(`Refusing to overwrite existing local core.hooksPath: ${current}`);
    return automatic ? 0 : 2;
  }
  git(["config", "--local", "core.hooksPath", ".githooks"]);
  console.log("Enabled repository Git hooks at .githooks.");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (automatic) {
    console.error(`Git hook installation skipped: ${error.message}`);
    process.exitCode = 0;
  } else {
    console.error(error.message);
    process.exitCode = 2;
  }
}
