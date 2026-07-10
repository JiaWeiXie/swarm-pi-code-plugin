import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertMutationPath } from "../src/pi/scoped-tools.js";

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
