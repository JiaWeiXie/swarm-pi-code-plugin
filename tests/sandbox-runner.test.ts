import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectSandboxAvailability } from "../src/sandbox/availability.js";
import {
  createSandboxRunner,
  sandboxConfiguration,
  sanitizedSandboxEnvironment,
} from "../src/sandbox/runner.js";

test("sandbox policy separates readonly and implementation write access", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-policy-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-home-"));
  const readonly = await sandboxConfiguration(workspace, tempRoot, "readonly");
  const implement = await sandboxConfiguration(workspace, tempRoot, "implement");

  assert.equal(readonly.filesystem.allowWrite.includes(path.resolve(workspace)), false);
  assert.equal(implement.filesystem.allowWrite.includes(path.resolve(workspace)), true);
  assert.equal(implement.filesystem.denyWrite.includes(path.join(workspace, ".git")), true);
  assert.equal(implement.filesystem.denyWrite.includes(path.join(os.homedir(), ".npm", "_logs")), true);
  assert.equal(implement.filesystem.denyWrite.includes(path.resolve("/tmp/claude")), true);
  assert.deepEqual(implement.network.allowedDomains, []);
  assert.equal(implement.network.allowAllUnixSockets, false);
});

test("sandbox environment omits host credentials and isolates user directories", () => {
  const workspace = "/tmp/swarm-pi-workspace";
  const tempRoot = "/tmp/swarm-pi-home";
  const env = sanitizedSandboxEnvironment(workspace, tempRoot, {
    PATH: process.env.PATH,
    OPENAI_API_KEY: "do-not-copy",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    AWS_SECRET_ACCESS_KEY: "do-not-copy",
    LANG: "en_US.UTF-8",
  });

  assert.equal(env.HOME, tempRoot);
  assert.equal(env.TMPDIR, tempRoot);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.LANG, "en_US.UTF-8");
});

test("OS sandbox writes only when the worker mode permits it", {
  skip: !detectSandboxAvailability().available,
}, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-live-"));
  const outside = path.join(os.tmpdir(), `swarm-pi-outside-${process.pid}.txt`);
  fs.rmSync(outside, { force: true });

  const readonly = await createSandboxRunner({ cwd: workspace, mode: "readonly" });
  try {
    const tool = readonly.createBashTool();
    await assert.rejects(
      () => tool.execute("readonly", { command: "printf blocked > readonly.txt" }, undefined, undefined, {} as never),
      /exited with code|operation not permitted|permission denied/i,
    );
    assert.equal(fs.existsSync(path.join(workspace, "readonly.txt")), false);
  } finally {
    await readonly.dispose();
  }

  const implement = await createSandboxRunner({
    cwd: workspace,
    mode: "implement",
    env: { ...process.env, OPENAI_API_KEY: "do-not-copy" },
  });
  try {
    const tool = implement.createBashTool();
    await tool.execute(
      "implement",
      { command: "printf allowed > written.txt; test -z \"$OPENAI_API_KEY\"" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(fs.readFileSync(path.join(workspace, "written.txt"), "utf8"), "allowed");
    await assert.rejects(
      () => tool.execute(
        "timeout",
        { command: "sleep 2; printf late > late.txt", timeout: 0.05 },
        undefined,
        undefined,
        {} as never,
      ),
      /timed out/i,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(path.join(workspace, "late.txt")), false);
    await assert.rejects(
      () => tool.execute(
        "outside",
        { command: `printf blocked > ${shellQuote(outside)}` },
        undefined,
        undefined,
        {} as never,
      ),
      /exited with code|operation not permitted|permission denied/i,
    );
    assert.equal(fs.existsSync(outside), false);
  } finally {
    await implement.dispose();
    fs.rmSync(outside, { force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
