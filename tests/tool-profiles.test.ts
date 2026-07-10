import assert from "node:assert/strict";
import test from "node:test";

import { IMPLEMENT_TOOLS, READ_ONLY_TOOLS, toolsForMode } from "../src/pi/tool-profiles.js";

test("readonly workers cannot mutate files or run shell commands", () => {
  assert.deepEqual(READ_ONLY_TOOLS, ["read", "grep", "find", "ls"]);
  assert.equal(READ_ONLY_TOOLS.includes("write" as never), false);
  assert.equal(READ_ONLY_TOOLS.includes("edit" as never), false);
  assert.equal(READ_ONLY_TOOLS.includes("bash" as never), false);
});

test("implementation workers can edit but cannot run arbitrary shell commands", () => {
  assert.equal(IMPLEMENT_TOOLS.includes("write"), true);
  assert.equal(IMPLEMENT_TOOLS.includes("edit"), true);
  assert.equal(IMPLEMENT_TOOLS.includes("bash" as never), false);
  assert.deepEqual(toolsForMode("implement"), [...IMPLEMENT_TOOLS]);
});
