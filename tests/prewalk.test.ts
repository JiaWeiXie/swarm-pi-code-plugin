import assert from "node:assert/strict";
import test from "node:test";

import { createPrewalkController } from "../src/pi/prewalk.js";
import { parseArguments } from "../src/runner/args.js";

test("prewalk only switches after a bounded TODO list and first successful mutation", async () => {
  const controller = createPrewalkController({
    guideModel: "frontier/guide",
    executorModel: "cheap/executor",
    executorModelObject: { id: "executor" },
    executorThinkingLevel: "low",
  });
  let switched: unknown;
  controller.attach({
    agent: { state: { messages: [{ content: "[PREWALK_GUIDE]secret[/PREWALK_GUIDE]\nrequest" }] } },
    async setModel(model: unknown) {
      switched = model;
    },
    setThinkingLevel() {},
  });
  await assert.rejects(controller.onWorkspaceMutation(), /TODO/);
  assert.equal(controller.metadata.switchFailure, "missing-todos");
  await (controller.tool as { execute(id: string, params: unknown): Promise<unknown> }).execute(
    "call",
    {
      items: [
        { task: "Change the guard", verification: "Run targeted test", status: "in_progress" },
      ],
    },
  );
  await controller.onWorkspaceMutation();
  assert.deepEqual(switched, { id: "executor" });
  assert.equal(controller.metadata.status, "switched");
  assert.equal(controller.metadata.todoCount, 1);
});

test("prewalk and shared reconnaissance profiles are command-scoped", () => {
  assert.equal(
    parseArguments([
      "implement",
      "--host",
      "codex",
      "--prompt-file",
      "request.md",
      "--implementation-profile",
      "prewalk",
    ]).implementationProfile,
    "prewalk",
  );
  assert.equal(
    parseArguments([
      "orchestrate",
      "--host",
      "codex",
      "--prompt-file",
      "request.md",
      "--orchestration-profile",
      "shared-recon",
    ]).orchestrationProfile,
    "shared-recon",
  );
  assert.throws(
    () =>
      parseArguments([
        "plan",
        "--host",
        "codex",
        "--prompt-file",
        "request.md",
        "--implementation-profile",
        "prewalk",
      ]),
    /only supported by implement/,
  );
});
