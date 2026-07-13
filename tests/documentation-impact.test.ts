import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const checker = path.join(root, "scripts/check-documentation-impact.mjs");
const installer = path.join(root, "scripts/install-git-hooks.mjs");
const screenshot = path.join(root, "docs/assets/setup/01-empty-connections.png");

function git(cwd: string, args: string[]): string {
  const command = args[0] === "commit" ? ["-c", "commit.gpgSign=false", ...args] : args;
  return execFileSync("git", command, { cwd, encoding: "utf8" }).trim();
}

function fixture(files: Record<string, string> = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-doc-impact-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Documentation Test"]);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (Object.keys(files).length === 0) fs.writeFileSync(path.join(cwd, ".fixture"), "fixture\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "fixture"]);
  return cwd;
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [checker, ...args], { cwd, encoding: "utf8" });
}

function withBaseline(cwd: string): void {
  fs.mkdirSync(path.join(cwd, "docs/assets/setup"), { recursive: true });
  fs.copyFileSync(screenshot, path.join(cwd, "docs/assets/setup/01-empty-connections.png"));
  fs.writeFileSync(
    path.join(cwd, "docs/configuration.md"),
    "![setup](assets/setup/01-empty-connections.png)\n",
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "baseline"]);
}

test("worktree functional changes require both README translations", () => {
  const cwd = fixture({
    "src/feature.ts": "export const changed = true;\n",
    "README.md": "# Product\n",
  });
  fs.appendFileSync(path.join(cwd, "src/feature.ts"), "export const secondChange = true;\n");
  const report = run(cwd, ["worktree", "--format", "json"]);
  assert.equal(report.status, 1);
  assert.match(report.stdout, /README\.zh-TW\.md/);
});

test("unborn worktrees compare against Git's empty tree", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-doc-unborn-"));
  git(cwd, ["init", "-q"]);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/feature.ts"), "export const changed = true;\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Product\n");
  fs.writeFileSync(path.join(cwd, "README.zh-TW.md"), "# 產品\n");
  const report = run(cwd, ["worktree", "--format", "json"]);
  assert.equal(report.status, 0);
});

test("staged mode ignores an unstaged documentation edit", () => {
  const cwd = fixture({
    "src/feature.ts": "old\n",
    "README.md": "old\n",
    "README.zh-TW.md": "old\n",
  });
  fs.writeFileSync(path.join(cwd, "src/feature.ts"), "new\n");
  git(cwd, ["add", "src/feature.ts"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "updated\n");
  const report = run(cwd, ["staged", "--format", "json"]);
  assert.equal(report.status, 1);
  assert.match(report.stdout, /README\.md/);
  assert.match(report.stdout, /README\.zh-TW\.md/);
});

test("Configuration UI change requires Web docs and a screenshot outcome", () => {
  const cwd = fixture({ "README.md": "old\n", "README.zh-TW.md": "old\n" });
  fs.mkdirSync(path.join(cwd, "src/web"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src/web/ui.ts"), "export const ui = true;\n");
  git(cwd, ["add", "."]);
  const report = run(cwd, ["staged", "--format", "json"]);
  assert.equal(report.status, 1);
  assert.match(report.stdout, /docs\/configuration\.md/);
  assert.match(report.stdout, /Screenshot-Impact/);
});

test("CI compares explicit revisions and accepts only the head declaration", () => {
  const cwd = fixture({
    "src/feature.ts": "old\n",
    "README.md": "old\n",
    "README.zh-TW.md": "old\n",
  });
  const base = git(cwd, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(cwd, "src/feature.ts"), "new\n");
  git(cwd, ["add", "."]);
  git(cwd, [
    "commit",
    "-qm",
    "feature\n\nDocumentation-Impact: not-applicable\nDocumentation-Impact-Reason: Internal refactor changes no user-facing behavior.",
  ]);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const report = run(cwd, ["ci", "--base", base, "--head", head, "--format", "json"]);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /documentation-not-applicable/);
});

test("broken and unreferenced setup images are reported", () => {
  const cwd = fixture({ "README.md": "# Product\n", "README.zh-TW.md": "# 產品\n" });
  withBaseline(cwd);
  fs.writeFileSync(
    path.join(cwd, "docs/assets/setup/unreferenced.png"),
    fs.readFileSync(screenshot),
  );
  fs.writeFileSync(path.join(cwd, "docs/configuration.md"), "![missing](assets/setup/nope.png)\n");
  const report = run(cwd, ["worktree", "--format", "json"]);
  assert.equal(report.status, 1);
  assert.match(report.stdout, /missing image/);
  assert.match(report.stdout, /Unreferenced setup screenshot/);
});

test("hook installer is local, idempotent, and refuses a different hooks path", () => {
  const cwd = fixture();
  const first = spawnSync(process.execPath, [installer], { cwd, encoding: "utf8" });
  assert.equal(first.status, 0);
  assert.equal(git(cwd, ["config", "--local", "--get", "core.hooksPath"]), ".githooks");
  const second = spawnSync(process.execPath, [installer], { cwd, encoding: "utf8" });
  assert.equal(second.status, 0);
  git(cwd, ["config", "--local", "core.hooksPath", ".other-hooks"]);
  const conflict = spawnSync(process.execPath, [installer], { cwd, encoding: "utf8" });
  assert.equal(conflict.status, 2);
  const uninstall = spawnSync(process.execPath, [installer, "--uninstall"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 2);
});

test("invalid CI revisions return usage status 2", () => {
  const cwd = fixture();
  const report = run(cwd, ["ci", "--base", "missing-base", "--head", "missing-head"]);
  assert.equal(report.status, 2);
});
