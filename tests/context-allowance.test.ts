import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_CONTEXT_ALLOWANCE_PRESETS,
  hostContextCharacterLimit,
} from "../src/host-assistance/context-allowance.js";

test("Host context allowance presets map to explicit character limits", () => {
  assert.deepEqual(
    HOST_CONTEXT_ALLOWANCE_PRESETS.map((preset) => preset.value),
    [0, 1, 4, 8],
  );
  assert.equal(hostContextCharacterLimit(0), 0);
  assert.equal(hostContextCharacterLimit(1), 8_192);
  assert.equal(hostContextCharacterLimit(4), 32_768);
  assert.equal(hostContextCharacterLimit(8), 64_000);
  assert.equal(hostContextCharacterLimit(64), 64_000);
});
