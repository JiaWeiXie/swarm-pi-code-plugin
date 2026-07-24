import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultModelConfiguration } from "../src/state/model-config.js";
import {
  createSealEvidenceController,
  createSealEvidenceTool,
  getSealEvidenceAttempt,
  parseSealEvidenceInput,
  serializeSealedEvidence,
  validateSealedEvidenceSeed,
} from "../src/orchestration/sealed-evidence.js";
import { createWorkerSession, workerToolAllowlist } from "../src/pi/runtime.js";

const entry = {
  kind: "evidence" as const,
  summary: "The workspace has a bounded test seam.",
  basis: "workspace" as const,
};

function executeTool(tool: ReturnType<typeof createSealEvidenceTool>, entries = [entry]) {
  return tool.execute("seal", { entries }, undefined, undefined, {} as never);
}

test("sealed evidence validates exact schema, bounds, and deep immutability", () => {
  const input = { entries: [{ ...entry }] };
  const seal = parseSealEvidenceInput(input);
  input.entries[0]!.summary = "mutated after validation";
  assert.equal(seal.entries[0]!.summary, "The workspace has a bounded test seam.");
  assert.equal(Object.isFrozen(seal), true);
  assert.equal(Object.isFrozen(seal.entries), true);
  assert.equal(Object.isFrozen(seal.entries[0]), true);
  assert.throws(() => (seal.entries as SealedEvidenceEntryForTest[]).push(entry), TypeError);
  assert.throws(() => parseSealEvidenceInput({ entries: [] }), /out of bounds/);
  assert.throws(
    () => parseSealEvidenceInput({ entries: Array.from({ length: 9 }, () => entry) }),
    /out of bounds/,
  );
  assert.throws(
    () => parseSealEvidenceInput({ entries: [{ ...entry, extra: "nope" }] }),
    /unsupported field/,
  );
  assert.throws(() => validateSealedEvidenceSeed({ version: 2, entries: [entry] }), /version/);
});

test("sealed summary privacy rules are explicit and do not reject ordinary slashes", () => {
  const accepted = ["src/module.ts changed", "compare A/B behavior", "unknown: / not a path"];
  for (const summary of accepted)
    assert.doesNotThrow(() => parseSealEvidenceInput({ entries: [{ ...entry, summary }] }));
  const rejected = [
    "line\nfeed",
    "use `literal`",
    "see https://example.test/a",
    "read /Users/example/project/file.ts",
    "read C:\\Users\\example\\file.ts",
    "read \\\\server\\share\\file.ts",
    `digest ${"a".repeat(64)}`,
    "path=/tmp/private.txt",
    "read,/Users/example/secret.txt",
    "see:www.example.test/x",
  ];
  for (const summary of rejected) {
    assert.throws(
      () => parseSealEvidenceInput({ entries: [{ ...entry, summary }] }),
      /privacy-safe|invalid|out of bounds/,
    );
  }
});

test("seal_evidence authenticates the controller, seals once, and never echoes entries", async () => {
  const controller = createSealEvidenceController();
  const tool = createSealEvidenceTool(controller);
  assert.equal(tool.name, "seal_evidence");
  const accepted = await executeTool(tool);
  assert.equal(accepted.content[0]?.type, "text");
  assert.equal(
    accepted.content[0]?.type === "text" && accepted.content[0].text.includes(entry.summary),
    false,
  );
  await assert.rejects(executeTool(tool), (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : String(error), "Evidence seal rejected.");
    assert.equal(error instanceof Error ? error.message.includes(entry.summary) : false, false);
    return true;
  });
  assert.deepEqual(getSealEvidenceAttempt(controller).calls, 2);
  assert.throws(
    () => createSealEvidenceTool({ kind: "review-coordinator" } as never),
    /authentication/,
  );
});

test("a malformed seal invocation consumes the controller's exact-once boundary", async () => {
  const controller = createSealEvidenceController();
  const tool = createSealEvidenceTool(controller);
  const privateSummary = "read /Users/example/project/private.ts";
  await assert.rejects(
    tool.execute(
      "malformed",
      { entries: [{ ...entry, summary: privateSummary, unsupported: true }] },
      undefined,
      undefined,
      {} as never,
    ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message, "Evidence seal rejected.");
      assert.equal(message.includes(privateSummary), false);
      return true;
    },
  );
  await assert.rejects(executeTool(tool), /Evidence seal rejected/);
  assert.deepEqual(getSealEvidenceAttempt(controller).calls, 2);
  assert.equal(getSealEvidenceAttempt(controller).seal, undefined);
});

test("runtime custom-message seeding passes only the validated immutable seal", async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sealed-seed-")));
  const seed = validateSealedEvidenceSeed({ version: 1, entries: [entry] });
  const { session } = await createWorkerSession({
    cwd: workspace,
    mode: "readonly",
    modelConfiguration: defaultModelConfiguration(),
    sealedEvidenceSeed: seed,
  });
  try {
    const customMessage = session.sessionManager
      .getEntries()
      .find((candidate) => candidate.type === "custom_message");
    assert.equal(customMessage?.type, "custom_message");
    if (customMessage?.type === "custom_message") {
      assert.equal(customMessage.display, false);
      assert.equal(customMessage.customType, "swarm-pi-code-plugin/sealed-evidence-v1");
      assert.equal(customMessage.content, serializeSealedEvidence(seed));
    }
  } finally {
    session.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("controller and seed runtime options are mutually exclusive and allow-list scoped", async () => {
  const workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sealed-boundary-")),
  );
  const controller = createSealEvidenceController();
  await assert.rejects(
    createWorkerSession({
      cwd: workspace,
      mode: "readonly",
      modelConfiguration: defaultModelConfiguration(),
      sealEvidenceController: controller,
      sealedEvidenceSeed: { version: 1, entries: [entry] },
    }),
    /incompatible/,
  );
  assert.deepEqual(workerToolAllowlist("readonly", [{ name: "read" }]), [
    "read",
    "grep",
    "find",
    "ls",
  ]);
  const { session } = await createWorkerSession({
    cwd: workspace,
    mode: "readonly",
    modelConfiguration: defaultModelConfiguration(),
    sealEvidenceController: controller,
  });
  try {
    assert.equal(session.getActiveToolNames().includes("seal_evidence"), true);
  } finally {
    session.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

type SealedEvidenceEntryForTest = {
  readonly kind: "evidence";
  readonly summary: string;
  readonly basis: "workspace";
};
