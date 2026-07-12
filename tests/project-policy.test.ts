import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProjectPolicyError,
  assertChangedPathsAllowed,
  assertPathAllowed,
  assertTaskAdmitted,
  bindProjectPolicy,
  compileEffectiveProjectPolicy,
} from "../src/policy/project-policy.js";

function workspace(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-policy-")));
}

test("default project policy allows every task kind and the workspace", async () => {
  const policy = await compileEffectiveProjectPolicy({ cwd: workspace() });
  assert.deepEqual(policy.allowedTaskKinds, ["ask", "discover", "implement", "orchestrate", "plan", "review", "scaffold", "setup"]);
  assert.deepEqual(policy.roots, { read: ["."], search: ["."], write: ["."], shell: ["."] });
});

test("explicit empty roots and task kinds fail closed", async () => {
  const cwd = workspace();
  const noPaths = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: [] } });
  assert.deepEqual(noPaths.roots, { read: [], search: [], write: [], shell: [] });
  const bound = await bindProjectPolicy(noPaths, cwd);
  for (const operation of ["read", "search", "write", "shell"] as const) {
    await assert.rejects(() => assertPathAllowed(bound, operation, "anything"), ProjectPolicyError);
  }

  const noTasks = await compileEffectiveProjectPolicy({ cwd, profile: { tasks: [] } });
  assert.deepEqual(noTasks.allowedTaskKinds, []);
  for (const kind of ["ask", "review", "plan", "implement", "orchestrate", "scaffold", "setup"] as const) {
    assert.throws(() => assertTaskAdmitted(noTasks, kind), ProjectPolicyError);
  }
});

test("duplicate roots are deduplicated", async () => {
  const policy = await compileEffectiveProjectPolicy({ cwd: workspace(), profile: { dirs: ["src", "src"] } });
  assert.deepEqual(policy.roots.write, ["src"]);
});

test("roots are minimized and task aliases are expanded", async () => {
  const policy = await compileEffectiveProjectPolicy({ cwd: workspace(), profile: { dirs: ["src/app", "src"], tasks: ["analysis", "planning"] } });
  assert.deepEqual(policy.roots.write, ["src"]);
  assert.deepEqual(policy.allowedTaskKinds, ["ask", "orchestrate", "plan"]);
});

test("the discovery choice expands to the discover task kind", async () => {
  const policy = await compileEffectiveProjectPolicy({ cwd: workspace(), profile: { tasks: ["discovery"] } });
  assert.deepEqual(policy.allowedTaskKinds, ["discover"]);
});

test("unknown task choices fail closed, while mixed choices retain valid choices", async () => {
  await assert.rejects(
    () => compileEffectiveProjectPolicy({ cwd: workspace(), profile: { tasks: ["unknown"] } }),
    (error: unknown) => error instanceof ProjectPolicyError
      && error.rejection.errorCode === "project-scope-invalid"
      && error.rejection.stage === "admission",
  );
  const policy = await compileEffectiveProjectPolicy({ cwd: workspace(), profile: { tasks: ["unknown", "implementation"] } });
  assert.deepEqual(policy.allowedTaskKinds, ["implement"]);
});

test("policy hashes are canonical and separate scope from deny rules", async () => {
  const cwd = workspace();
  const one = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["lib", "src"], tasks: ["planning", "implementation"] }, repositoryDenyRules: [{ id: "a", effect: "deny", capability: "shell.execute" }] });
  const reordered = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src", "lib"], tasks: ["implementation", "planning"] }, repositoryDenyRules: [{ capability: "shell.execute", effect: "deny", id: "a" }] });
  const denyChanged = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src", "lib"], tasks: ["implementation", "planning"] }, repositoryDenyRules: [{ id: "b", effect: "deny", capability: "shell.execute" }] });
  const scopeChanged = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"], tasks: ["implementation"] } });
  assert.equal(one.scopeHash, reordered.scopeHash);
  assert.equal(one.hash, reordered.hash);
  assert.equal(one.scopeHash, denyChanged.scopeHash);
  assert.notEqual(one.hash, denyChanged.hash);
  assert.notEqual(one.scopeHash, scopeChanged.scopeHash);
});

test("policy hash canonicalization does not depend on locale-sensitive comparison", async () => {
  const cwd = workspace();
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = () => { throw new Error("localeCompare must not be used for policy hashes"); };
  try {
    const one = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src-two", "Src"] } });
    const reordered = await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["Src", "src-two"] } });
    assert.equal(one.scopeHash, reordered.scopeHash);
    assert.equal(one.hash, reordered.hash);
  } finally {
    String.prototype.localeCompare = original;
  }
});

test("path checks use segment prefixes and report every changed-path violation", async () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, "src"));
  fs.mkdirSync(path.join(cwd, "src-other"));
  const bound = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }), cwd);
  await assertPathAllowed(bound, "write", "src/file.ts");
  await assert.rejects(() => assertPathAllowed(bound, "write", "src-other/file.ts"), ProjectPolicyError);
  await assert.rejects(
    () => assertChangedPathsAllowed(bound, ["src/ok.ts", "src-other/a.ts", "elsewhere/b.ts"]),
    (error: unknown) => error instanceof ProjectPolicyError
      && error.rejection.violatingPaths?.join(",") === "src-other/a.ts,elsewhere/b.ts",
  );
});

test("invalid roots reject traversal, absolute paths, and backslashes", async () => {
  for (const dir of ["../outside", path.resolve(workspace(), "outside"), "src\\app", "src\\/app"]) {
    await assert.rejects(
      () => compileEffectiveProjectPolicy({ cwd: workspace(), profile: { dirs: [dir] } }),
      (error: unknown) => error instanceof ProjectPolicyError
        && error.rejection.errorCode === "project-scope-invalid"
        && error.rejection.stage === "admission",
    );
  }
});

test("escaping root and candidate symlinks are rejected, including nonexistent leaves", async (t) => {
  const cwd = workspace();
  const outside = workspace();
  fs.symlinkSync(outside, path.join(cwd, "escape"));
  await assert.rejects(() => compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["escape"] } }), ProjectPolicyError);

  fs.mkdirSync(path.join(cwd, "src"));
  try {
    fs.symlinkSync(outside, path.join(cwd, "src", "escape"));
  } catch (error) {
    t.skip(`symlinks unavailable: ${String(error)}`);
    return;
  }
  const bound = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }), cwd);
  assert.equal(await assertPathAllowed(bound, "write", "src/new/deep.ts"), path.join(cwd, "src", "new", "deep.ts"));
  await assert.rejects(() => assertPathAllowed(bound, "write", "src/escape/new.ts"), ProjectPolicyError);
});

test("dangling symlinks cannot certify an out-of-workspace write", async (t) => {
  const cwd = workspace();
  const outside = workspace();
  fs.mkdirSync(path.join(cwd, "src"));
  try {
    fs.symlinkSync(path.join(outside, "gone.txt"), path.join(cwd, "src", "dangling"));
  } catch (error) {
    t.skip(`symlinks unavailable: ${String(error)}`);
    return;
  }
  const bound = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }), cwd);
  await assert.rejects(() => assertPathAllowed(bound, "write", "src/dangling"), ProjectPolicyError);
});

test("filesystem resolution failures are structured and changed-path batches continue", async (t) => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, "src"));
  try {
    fs.symlinkSync("loop", path.join(cwd, "src", "loop"));
  } catch (error) {
    t.skip(`symlinks unavailable: ${String(error)}`);
    return;
  }
  const bound = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }), cwd);
  await assert.rejects(
    () => assertPathAllowed(bound, "write", "src/loop"),
    (error: unknown) => error instanceof ProjectPolicyError
      && error.rejection.errorCode === "project-scope-violation"
      && error.rejection.stage === "preflight",
  );
  await assert.rejects(
    () => assertChangedPathsAllowed(bound, ["src/loop", "outside/file.ts"]),
    (error: unknown) => error instanceof ProjectPolicyError
      && error.rejection.stage === "postflight"
      && error.rejection.violatingPaths?.join(",") === "src/loop,outside/file.ts",
  );
});

test("task admission rejection includes recovery actions", async () => {
  const policy = await compileEffectiveProjectPolicy({ cwd: workspace(), profile: { tasks: ["planning"] } });
  assert.throws(
    () => assertTaskAdmitted(policy, "implement"),
    (error: unknown) => error instanceof ProjectPolicyError
      && error.rejection.errorCode === "task-kind-not-allowed"
      && error.rejection.stage === "admission"
      && error.rejection.nextActions.length > 0,
  );
});

test("bind rejects every tampered policy snapshot field", async () => {
  const cwd = workspace();
  const policy = await compileEffectiveProjectPolicy({
    cwd,
    profile: { dirs: ["src"], tasks: ["planning"] },
    repositoryDenyRules: [{ id: "deny-shell", effect: "deny", capability: "shell.execute" }],
  });
  const mutations: Array<Record<string, unknown>> = [
    { allowedTaskKinds: ["implement"] },
    { roots: { ...policy.roots, write: ["elsewhere"] } },
    { repositoryDenyRules: [] },
    { hash: `${policy.hash[0] === "0" ? "1" : "0"}${policy.hash.slice(1)}` },
    { scopeHash: `${policy.scopeHash[0] === "0" ? "1" : "0"}${policy.scopeHash.slice(1)}` },
    { version: 2 },
    { workspaceRoot: "src" },
  ];
  for (const mutation of mutations) {
    const tampered = { ...policy, ...mutation } as unknown as typeof policy;
    await assert.rejects(
      () => bindProjectPolicy(tampered, cwd),
      (error: unknown) => error instanceof ProjectPolicyError
        && error.rejection.errorCode === "policy-snapshot-invalid",
    );
  }
});

test("path behavior follows the filesystem's actual case semantics", async () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, "src"));
  const insensitive = fs.existsSync(path.join(cwd, "SRC"));
  const bound = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }), cwd);
  if (insensitive) await assertPathAllowed(bound, "read", "SRC/file.ts");
  else await assert.rejects(() => assertPathAllowed(bound, "read", "SRC/file.ts"), ProjectPolicyError);
});
