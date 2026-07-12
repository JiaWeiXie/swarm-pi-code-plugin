import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BoundProjectPolicy } from "../src/core/contracts.js";
import {
  ProjectPolicyError,
  bindProjectPolicy,
  compileEffectiveProjectPolicy,
} from "../src/policy/project-policy.js";
import { assertMutationPath, createScopedFilesystemTools } from "../src/pi/scoped-tools.js";

test("mutation paths stay inside the assigned worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-scope-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-outside-"));
  fs.mkdirSync(path.join(root, "src"));

  assert.equal(
    await assertMutationPath(root, path.join(root, "src", "new.ts")),
    path.join(root, "src", "new.ts"),
  );
  await assert.rejects(() => assertMutationPath(root, path.join(outside, "bad.ts")), /outside/i);
});

test("mutation paths reject symlinks that escape the worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-scope-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-outside-"));
  fs.symlinkSync(outside, path.join(root, "escape"));

  await assert.rejects(
    () => assertMutationPath(root, path.join(root, "escape", "bad.ts")),
    /outside/i,
  );
});

test("mutation paths protect Git, runtime state, policy, and environment files", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-protected-"));
  for (const candidate of [".git/config", ".swarm-pi-code-plugin/state.json", ".swarm-pi-policy.json", ".env"]) {
    await assert.rejects(() => assertMutationPath(workspace, candidate), /protected/);
  }
});

interface Harness {
  cwd: string;
  bound: BoundProjectPolicy;
  violations: ProjectPolicyError[];
  names: string[];
  run: (name: string, params: unknown) => Promise<unknown>;
}

async function harness(dirs: string[] | undefined, mode: "readonly" | "implement" = "implement"): Promise<Harness> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-scoped-")));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "docs"));
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
  fs.writeFileSync(path.join(cwd, "docs", "x.md"), "doc\n");
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy(dirs === undefined ? { cwd } : { cwd, profile: { dirs } }),
    cwd,
  );
  const violations: ProjectPolicyError[] = [];
  const tools = createScopedFilesystemTools({
    cwd,
    mode,
    boundProjectPolicy: bound,
    onPolicyViolation: (error) => violations.push(error),
  });
  const byName = new Map(tools.map((entry) => [(entry as { name: string }).name, entry]));
  const run = (name: string, params: unknown): Promise<unknown> => {
    const tool = byName.get(name) as
      | { execute: (id: string, p: unknown, s: undefined, u: undefined, c: unknown) => Promise<unknown> }
      | undefined;
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.execute("call", params, undefined, undefined, {});
  };
  return { cwd, bound, violations, names: [...byName.keys()], run };
}

/**
 * Assert the operation is denied for being out of scope. The reliable signal is
 * the structured `onPolicyViolation` callback: the SDK edit tool wraps thrown
 * operation errors, so the thrown value is not always a `ProjectPolicyError`,
 * but the callback always receives the original structured rejection.
 */
async function assertScopeDenied(h: Harness, name: string, params: unknown): Promise<void> {
  const before = h.violations.length;
  await assert.rejects(() => h.run(name, params), `${name} should reject an out-of-scope path`);
  assert.ok(h.violations.length > before, `${name} should notify onPolicyViolation`);
  const violation = h.violations.at(-1);
  assert.ok(violation instanceof ProjectPolicyError);
  assert.equal(violation.rejection.errorCode, "project-scope-violation");
}

/** Assert the policy layer does not reject (it may still delegate to the SDK implementation). */
async function assertScopeAllowed(h: Harness, name: string, params: unknown): Promise<void> {
  try {
    await h.run(name, params);
  } catch (error) {
    assert.ok(
      !(error instanceof ProjectPolicyError),
      `${name} should not be rejected by project policy: ${(error as Error).message}`,
    );
  }
}

test("scoped write is confined to allowed roots", async () => {
  const h = await harness(["src"]);
  await h.run("write", { path: "src/new.ts", content: "x" });
  assert.ok(fs.existsSync(path.join(h.cwd, "src", "new.ts")));
  await assertScopeDenied(h, "write", { path: "package.json", content: "x" });
  await assertScopeDenied(h, "write", { path: "docs/x.md", content: "x" });
});

test("scoped edit requires read and write scope", async () => {
  const h = await harness(["src"]);
  await h.run("edit", { path: "src/a.ts", edits: [{ oldText: "1", newText: "2" }] });
  assert.match(fs.readFileSync(path.join(h.cwd, "src", "a.ts"), "utf8"), /a = 2/);
  await assertScopeDenied(h, "edit", { path: "docs/x.md", edits: [{ oldText: "doc", newText: "z" }] });
});

test("scoped read is confined to allowed roots", async () => {
  const h = await harness(["src"]);
  await assertScopeAllowed(h, "read", { path: "src/a.ts" });
  await assertScopeDenied(h, "read", { path: "package.json" });
});

test("scoped grep, find, and ls only search allowed roots", async () => {
  const h = await harness(["src"]);
  for (const name of ["grep", "find", "ls"]) {
    await assertScopeDenied(h, name, name === "ls" ? { path: "." } : { pattern: "a", path: "." });
    await assertScopeDenied(h, name, name === "ls" ? { path: "docs" } : { pattern: "a", path: "docs" });
    await assertScopeAllowed(h, name, name === "ls" ? { path: "src" } : { pattern: "a", path: "src" });
  }
});

test("an unrestricted policy allows the whole workspace", async () => {
  const h = await harness(undefined);
  await h.run("write", { path: "package.json", content: "{}\n" });
  await assertScopeAllowed(h, "read", { path: "package.json" });
  await assertScopeAllowed(h, "ls", { path: "." });
});

test("protected paths are rejected regardless of policy", async () => {
  const h = await harness(undefined);
  await assert.rejects(() => h.run("write", { path: ".git/config", content: "x" }));
  assert.ok(!fs.existsSync(path.join(h.cwd, ".git", "config")));
});

test("readonly mode does not expose write or edit tools", async () => {
  const h = await harness(["src"], "readonly");
  assert.deepEqual(h.names, ["read", "grep", "find", "ls"]);
});
