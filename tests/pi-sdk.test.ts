import assert from "node:assert/strict";
import test from "node:test";

import { createAgentSession } from "@earendil-works/pi-coding-agent";

test("the pinned Pi SDK exposes the embedded session API", () => {
  assert.equal(typeof createAgentSession, "function");
});
