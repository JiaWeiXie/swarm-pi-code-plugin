import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentSession,
  CredentialSynchronizationError,
  defineTool,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

test("the pinned Pi SDK exposes the embedded runtime, session, and custom-tool APIs", () => {
  assert.equal(typeof createAgentSession, "function");
  assert.equal(typeof defineTool, "function");
  assert.equal(typeof ModelRuntime.create, "function");
  assert.equal(typeof CredentialSynchronizationError, "function");

  const cause = new Error("snapshot write failed");
  const failure = new CredentialSynchronizationError("openai", "login", undefined, { cause });
  assert.ok(failure instanceof Error);
  assert.equal(failure.providerId, "openai");
  assert.equal(failure.operation, "login");
  assert.equal(failure.credential, undefined);
  assert.equal(failure.cause, cause);
});
