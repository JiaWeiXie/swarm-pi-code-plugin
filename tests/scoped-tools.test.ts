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

test("scoped writes reject dangling final-component symlinks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-dangling-write-"));
  const canonicalRoot = fs.realpathSync(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.symlinkSync(path.join(root, "missing-outside"), path.join(root, "src", "escape"));
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd: canonicalRoot, profile: { dirs: ["src"] } }),
    canonicalRoot,
  );
  const tools = createScopedFilesystemTools({
    cwd: canonicalRoot,
    mode: "implement",
    boundProjectPolicy: bound,
  });
  const write = tools.find((entry) => (entry as { name: string }).name === "write") as {
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(
    () => write.execute("call", { path: "src/escape", content: "nope" }, undefined, undefined, {}),
    /symlink|scope/i,
  );
  assert.equal(fs.existsSync(path.join(root, "missing-outside")), false);
});

test("scoped writes use no-follow open and never truncate a final symlink target", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-nofollow-write-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "target.txt"), "preserve\n");
  fs.symlinkSync(path.join(root, "target.txt"), path.join(root, "src", "link.txt"));
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd: root, profile: { dirs: ["src"] } }),
    root,
  );
  const tools = createScopedFilesystemTools({
    cwd: root,
    mode: "implement",
    boundProjectPolicy: bound,
  });
  const write = tools.find((entry) => (entry as { name: string }).name === "write") as {
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(
    () =>
      write.execute(
        "call",
        { path: "src/link.txt", content: "truncate" },
        undefined,
        undefined,
        {},
      ),
    /symlink|scope|root/i,
  );
  assert.equal(fs.readFileSync(path.join(root, "target.txt"), "utf8"), "preserve\n");
});

test("scoped writes reject intermediate symlinks outside the write root", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-intermediate-link-")),
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "outside"));
  fs.symlinkSync(path.join(root, "outside"), path.join(root, "src", "link"));
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd: root, profile: { dirs: ["src"] } }),
    root,
  );
  const tools = createScopedFilesystemTools({
    cwd: root,
    mode: "implement",
    boundProjectPolicy: bound,
  });
  const write = tools.find((entry) => (entry as { name: string }).name === "write") as {
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(
    () =>
      write.execute(
        "call",
        { path: "src/link/pwned.txt", content: "nope" },
        undefined,
        undefined,
        {},
      ),
    /scope|symlink|root/i,
  );
  assert.equal(fs.existsSync(path.join(root, "outside", "pwned.txt")), false);
});

test("scoped reads reject symlinks outside the read root", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-read-link-")));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "secret.txt"), "secret");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(root, "src", "secret"));
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd: root, profile: { dirs: ["src"] } }),
    root,
  );
  const tools = createScopedFilesystemTools({
    cwd: root,
    mode: "readonly",
    boundProjectPolicy: bound,
  });
  const read = tools.find((entry) => (entry as { name: string }).name === "read") as {
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(
    () => read.execute("call", { path: "src/secret" }, undefined, undefined, {}),
    /scope|root/i,
  );
});

test("mutation paths protect Git, runtime state, policy, and environment files", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-protected-"));
  for (const candidate of [
    ".git/config",
    ".swarm-pi-code-plugin/state.json",
    ".swarm-pi-policy.json",
    ".env",
  ]) {
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

async function harness(
  dirs: string[] | undefined,
  mode: "readonly" | "implement" = "implement",
): Promise<Harness> {
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
    onPolicyViolation: (error) => {
      violations.push(error);
    },
  });
  const byName = new Map(tools.map((entry) => [(entry as { name: string }).name, entry]));
  const run = (name: string, params: unknown): Promise<unknown> => {
    const tool = byName.get(name) as
      | {
          execute: (
            id: string,
            p: unknown,
            s: undefined,
            u: undefined,
            c: unknown,
          ) => Promise<unknown>;
        }
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
  await assertScopeDenied(h, "edit", {
    path: "docs/x.md",
    edits: [{ oldText: "doc", newText: "z" }],
  });
});

test("scoped read is confined to allowed roots", async () => {
  const h = await harness(["src"]);
  await assertScopeAllowed(h, "read", { path: "src/a.ts" });
  await assertScopeDenied(h, "read", { path: "package.json" });
});

test("scoped policy violation waits for asynchronous audit callback", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-scoped-audit-")));
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }),
    cwd,
  );
  let completed = false;
  const tools = createScopedFilesystemTools({
    cwd,
    mode: "readonly",
    boundProjectPolicy: bound,
    onPolicyViolation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = true;
    },
  });
  const read = tools.find((entry) => (entry as { name: string }).name === "read") as {
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(() =>
    read.execute("call", { path: "outside.txt" }, undefined, undefined, {}),
  );
  assert.equal(completed, true);
});

test("scoped policy rejection survives audit callback failure", async () => {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-scoped-audit-failure-")),
  );
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }),
    cwd,
  );
  const tools = createScopedFilesystemTools({
    cwd,
    mode: "readonly",
    boundProjectPolicy: bound,
    onPolicyViolation: async () => {
      throw new Error("audit unavailable");
    },
  });
  const read = tools.find((entry) => (entry as { name: string }).name === "read") as {
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(
    () => read.execute("call", { path: "outside.txt" }, undefined, undefined, {}),
    (error: unknown) =>
      error instanceof ProjectPolicyError &&
      error.rejection.errorCode === "project-scope-violation",
  );
});

test("search selectors reject traversal and absolute paths", async () => {
  const h = await harness(["src"], "readonly");
  await assertScopeDenied(h, "find", { pattern: "../**/*.ts", path: "src" });
  await assertScopeDenied(h, "grep", { pattern: "a", glob: "../../**/*.ts", path: "src" });
  await assertScopeDenied(h, "find", { pattern: "/etc/*", path: "src" });
  await assertScopeDenied(h, "find", { pattern: "C:outside/**/*.ts", path: "src" });
  await assertScopeDenied(h, "grep", { pattern: "a", glob: "C:outside/**/*.ts", path: "src" });
  await assertScopeDenied(h, "grep", {
    pattern: "a",
    glob: "{../outside/**,**/*.ts}",
    path: "src",
  });
  await assertScopeDenied(h, "find", { pattern: "@(../outside/**|**/*.ts)", path: "src" });
  await assertScopeDenied(h, "grep", { pattern: "a", glob: "{src/**,/etc/**}", path: "src" });
  await assertScopeDenied(h, "find", { pattern: "{src/**,C:/Windows/**}", path: "src" });
  await assertScopeAllowed(h, "grep", { pattern: "a", glob: "**/*..test.ts", path: "src" });
  await assertScopeAllowed(h, "grep", { pattern: "../", path: "src" });
});

test("scoped grep, find, and ls only search allowed roots", async () => {
  const h = await harness(["src"]);
  for (const name of ["grep", "find", "ls"]) {
    await assertScopeDenied(h, name, name === "ls" ? { path: "." } : { pattern: "a", path: "." });
    await assertScopeDenied(
      h,
      name,
      name === "ls" ? { path: "docs" } : { pattern: "a", path: "docs" },
    );
    await assertScopeAllowed(
      h,
      name,
      name === "ls" ? { path: "src" } : { pattern: "a", path: "src" },
    );
  }
});

test("recursive search rejects every symlink entry before delegating to the SDK", async () => {
  const h = await harness(["src"], "readonly");
  fs.mkdirSync(path.join(h.cwd, "src", "nested"));
  fs.symlinkSync(path.join(h.cwd, "src", "a.ts"), path.join(h.cwd, "src", "nested", "linked.ts"));
  await assert.rejects(
    () => h.run("find", { pattern: "**/*.ts", path: "src" }),
    /refuses symlinked entries/,
  );
  await assert.rejects(
    () => h.run("grep", { pattern: "a", glob: "**/*.ts", path: "src" }),
    /refuses symlinked entries/,
  );
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
