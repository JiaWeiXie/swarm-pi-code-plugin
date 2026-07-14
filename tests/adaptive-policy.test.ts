import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePolicyRulesLegacy,
  normalizePolicyRulesStrict,
} from "../src/policy/adaptive-policy.js";

test("strict Adaptive rules canonicalize bounded domain selectors", () => {
  assert.deepEqual(
    normalizePolicyRulesStrict([
      {
        id: "allow-docs",
        effect: "allow",
        capability: "network.connect",
        roles: ["scout", "advisor"],
        taskKinds: ["ask"],
        domain: "*.EXAMPLE.TEST.",
      },
      {
        id: "ask-writes",
        effect: "ask",
        capability: "filesystem.write-workspace",
        pathPrefix: "src/generated",
      },
    ]),
    [
      {
        id: "allow-docs",
        effect: "allow",
        capability: "network.connect",
        roles: ["scout", "advisor"],
        taskKinds: ["ask"],
        domain: "*.example.test",
      },
      {
        id: "ask-writes",
        effect: "ask",
        capability: "filesystem.write-workspace",
        pathPrefix: "src/generated",
      },
    ],
  );
});

test("strict Adaptive rules reject malformed and incompatible selectors with rule context", () => {
  const invalid = [
    [{ id: "UPPER", effect: "allow", capability: "network.connect" }],
    [
      { id: "duplicate", effect: "ask", capability: "shell.execute" },
      { id: "duplicate", effect: "deny", capability: "shell.execute" },
    ],
    [{ id: "unknown-key", effect: "ask", capability: "shell.execute", extra: true }],
    [{ id: "empty-roles", effect: "ask", capability: "shell.execute", roles: [] }],
    [
      {
        id: "duplicate-task",
        effect: "ask",
        capability: "shell.execute",
        taskKinds: ["plan", "plan"],
      },
    ],
    [{ id: "unknown-role", effect: "ask", capability: "shell.execute", roles: ["root"] }],
    [
      {
        id: "unknown-task",
        effect: "ask",
        capability: "shell.execute",
        taskKinds: ["testing"],
      },
    ],
    [
      {
        id: "escaping-path",
        effect: "allow",
        capability: "filesystem.write-workspace",
        pathPrefix: "../outside",
      },
    ],
    [
      {
        id: "wrong-path-capability",
        effect: "allow",
        capability: "shell.execute",
        pathPrefix: "src",
      },
    ],
    [
      {
        id: "wrong-domain-capability",
        effect: "allow",
        capability: "git.read",
        domain: "example.test",
      },
    ],
    [
      {
        id: "local-domain",
        effect: "allow",
        capability: "network.connect",
        domain: "localhost",
      },
    ],
    [
      {
        id: "mixed-selectors",
        effect: "allow",
        capability: "network.connect",
        domain: "example.test",
        pathPrefix: "src",
      },
    ],
  ];
  for (const rules of invalid) {
    assert.throws(() => normalizePolicyRulesStrict(rules), /Adaptive policy rule [12]/);
  }
  assert.throws(
    () =>
      normalizePolicyRulesStrict(
        Array.from({ length: 129 }, (_, id) => ({
          id: `r${id}`,
          effect: "ask",
          capability: "shell.execute",
        })),
      ),
    /at most 128/,
  );
});

test("legacy Adaptive rules fail closed without blocking state loading", () => {
  assert.deepEqual(
    normalizePolicyRulesLegacy([
      { id: "valid", effect: "ask", capability: "shell.execute" },
      { id: "valid", effect: "allow", capability: "shell.execute" },
      { id: "invalid", effect: "allow", capability: "unknown" },
      null,
    ]),
    [{ id: "valid", effect: "ask", capability: "shell.execute" }],
  );
  assert.deepEqual(normalizePolicyRulesLegacy({}), []);
});
