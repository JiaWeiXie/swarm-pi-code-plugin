import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPrewalkController, withPrewalkBashGate } from "../src/pi/prewalk.js";
import { createScopedMutationTools } from "../src/pi/scoped-tools.js";
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

test("prewalk preflights mutations and gates Bash until the same-session handoff", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-prewalk-tools-"));
  const controller = createPrewalkController({
    guideModel: "frontier/guide",
    executorModel: "cheap/executor",
    executorModelObject: { id: "executor" },
    executorThinkingLevel: "low",
  });
  let switched = false;
  controller.attach({
    async setModel() {
      switched = true;
    },
  });
  let bashCalls = 0;
  const bash = withPrewalkBashGate(
    {
      name: "bash",
      async execute() {
        bashCalls += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
    },
    controller,
  ) as { execute(...args: unknown[]): Promise<unknown> };
  await assert.rejects(
    () => bash.execute("call", { command: "touch should-not-exist" }),
    /guide phase does not allow Bash/,
  );
  assert.equal(bashCalls, 0);

  const tools = createScopedMutationTools(
    workspace,
    () => controller.onWorkspaceMutation(),
    () => controller.beforeWorkspaceMutation(),
  );
  const write = tools.find((entry) => (entry as { name: string }).name === "write") as {
    execute: (
      id: string,
      params: { path: string; content: string },
      signal: undefined,
      update: undefined,
      context: unknown,
    ) => Promise<unknown>;
  };
  await assert.rejects(
    () =>
      write.execute(
        "call",
        { path: "created.txt", content: "no partial mutation" },
        undefined,
        undefined,
        {},
      ),
    /TODO/,
  );
  assert.equal(fs.existsSync(path.join(workspace, "created.txt")), false);

  await (controller.tool as { execute(id: string, params: unknown): Promise<unknown> }).execute(
    "call",
    { items: [{ task: "Create file", verification: "Read it back", status: "in_progress" }] },
  );
  await write.execute(
    "call",
    { path: "created.txt", content: "after handoff" },
    undefined,
    undefined,
    {},
  );
  assert.equal(switched, true);
  assert.equal(fs.readFileSync(path.join(workspace, "created.txt"), "utf8"), "after handoff");
  await bash.execute("call", { command: "true" });
  assert.equal(bashCalls, 1);
});

test("prewalk marks a session without a handoff as incomplete", () => {
  const controller = createPrewalkController({
    guideModel: "frontier/guide",
    executorModel: "cheap/executor",
    executorModelObject: { id: "executor" },
    executorThinkingLevel: "low",
  });
  controller.finalize();
  assert.equal(controller.metadata.status, "incomplete");
  assert.equal(controller.metadata.switchFailure, "missing-todos");
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
