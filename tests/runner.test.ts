import assert from "node:assert/strict";
import test from "node:test";

import { executeSession, type RunnableSession } from "../src/pi/execute.js";
import { describeModels, selectModel, type PiModel } from "../src/pi/models.js";
import { parseArguments } from "../src/runner/args.js";
import { runCommand, type RunnerDependencies } from "../src/runner/run.js";

const fakeModel = {
  provider: "test-provider",
  id: "test-model",
  name: "Test Model",
} as PiModel;

test("argument parsing requires host and prompt file for ask", () => {
  assert.deepEqual(
    parseArguments([
      "ask",
      "--host",
      "codex",
      "--prompt-file",
      "/tmp/prompt.md",
      "--model",
      "test-provider/test-model",
      "--json",
    ]),
    {
      command: "ask",
      host: "codex",
      promptFile: "/tmp/prompt.md",
      model: "test-provider/test-model",
      json: true,
    },
  );
  assert.throws(() => parseArguments(["ask", "--host", "codex"]), /--prompt-file/);
  assert.throws(() => parseArguments(["ask", "--prompt-file", "prompt.md"]), /--host/);
});

test("model helpers expose stable provider/model identifiers", () => {
  assert.deepEqual(describeModels([fakeModel]), [
    {
      id: "test-provider/test-model",
      provider: "test-provider",
      model: "test-model",
      name: "Test Model",
    },
  ]);
  assert.equal(selectModel([fakeModel], "test-provider/test-model"), fakeModel);
  assert.equal(selectModel([fakeModel], "missing/model"), undefined);
});

test("session execution collects streamed output and always disposes", async () => {
  let disposed = false;
  const listeners = new Set<(event: any) => void>();
  const session: RunnableSession = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(prompt) {
      assert.equal(prompt, "Inspect this repository.");
      for (const delta of ["Inspection ", "complete."]) {
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      }
    },
    dispose() {
      disposed = true;
    },
  };

  const result = await executeSession({
    kind: "ask",
    model: "test-provider/test-model",
    prompt: "Inspect this repository.",
    session,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Inspection complete.");
  assert.equal(disposed, true);
});

test("ask runs through injected model and session dependencies", async () => {
  const session: RunnableSession = {
    subscribe(listener) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "done" },
      });
      return () => {};
    },
    async prompt(prompt) {
      assert.equal(prompt, "Question from file");
    },
    dispose() {},
  };
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "Question from file",
    createSession: async () => session,
  };

  const result = await runCommand(
    {
      command: "ask",
      host: "claude",
      promptFile: "prompt.md",
      json: true,
    },
    "/workspace",
    dependencies,
  );

  assert.equal("success" in result && result.success, true);
  assert.equal("model" in result && result.model, "test-provider/test-model");
});

test("mutating commands fail closed until the safety boundary exists", async () => {
  const dependencies: RunnerDependencies = {
    catalog: { available: () => [fakeModel] },
    readFile: async () => "unused",
    createSession: async () => {
      throw new Error("must not create a session");
    },
  };
  const result = await runCommand(
    { command: "implement", host: "codex", promptFile: "prompt.md", json: true },
    "/workspace",
    dependencies,
  );

  assert.equal("status" in result && result.status, "not-implemented");
});
