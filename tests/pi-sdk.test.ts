import assert from "node:assert/strict";
import test from "node:test";

import { createAgentSession, defineTool, ModelRuntime } from "@earendil-works/pi-coding-agent";

test("the pinned Pi SDK exposes the embedded runtime, session, and custom-tool APIs", () => {
  assert.equal(typeof createAgentSession, "function");
  assert.equal(typeof defineTool, "function");
  assert.equal(typeof ModelRuntime.create, "function");
});
