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
  const canonicalWorkspace = fs.realpathSync(workspace);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-home-"));
  const readonly = await sandboxConfiguration(workspace, tempRoot, "readonly");
  const implement = await sandboxConfiguration(workspace, tempRoot, "implement");
  const adaptive = await sandboxConfiguration(
    workspace,
    tempRoot,
    "readonly",
    process.env,
    "adaptive",
    ["registry.npmjs.org"],
  );

  assert.equal(readonly.filesystem.allowWrite.includes(path.resolve(workspace)), false);
  assert.equal(implement.filesystem.allowWrite.includes(canonicalWorkspace), true);
  assert.equal(
    implement.filesystem.denyWrite.includes(path.join(canonicalWorkspace, ".git")),
    true,
  );
  assert.equal(
    implement.filesystem.denyWrite.includes(path.join(os.homedir(), ".npm", "_logs")),
    true,
  );
  assert.equal(implement.filesystem.denyWrite.includes(path.resolve("/tmp/claude")), true);
  assert.deepEqual(implement.network.allowedDomains, []);
  assert.equal(implement.network.allowAllUnixSockets, false);
  assert.deepEqual(adaptive.network.allowedDomains, []);
  assert.equal(adaptive.network.deniedDomains.includes("localhost"), true);
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

test(
  "OS sandbox writes only when the worker mode permits it",
  {
    skip: !detectSandboxAvailability().available,
  },
  async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-live-"));
    const outside = path.join(os.tmpdir(), `swarm-pi-outside-${process.pid}.txt`);
    fs.rmSync(outside, { force: true });

    const readonly = await createSandboxRunner({ cwd: workspace, mode: "readonly" });
    try {
      const tool = readonly.createBashTool();
      await assert.rejects(
        () =>
          tool.execute(
            "readonly",
            { command: "printf blocked > readonly.txt" },
            undefined,
            undefined,
            {} as never,
          ),
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
        { command: 'printf allowed > written.txt; test -z "$OPENAI_API_KEY"' },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal(fs.readFileSync(path.join(workspace, "written.txt"), "utf8"), "allowed");
      await assert.rejects(
        () =>
          tool.execute(
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
        () =>
          tool.execute(
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
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

test("sandbox write allowlist follows bound project policy roots", async () => {
  const cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-bound-policy-")),
  );
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-bound-home-")),
  );
  fs.mkdirSync(path.join(cwd, "src"));

  const { bindProjectPolicy, compileEffectiveProjectPolicy } =
    await import("../src/policy/project-policy.js");
  const scoped = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }),
    cwd,
  );
  const unrestricted = await bindProjectPolicy(await compileEffectiveProjectPolicy({ cwd }), cwd);
  const scopedImplement = await sandboxConfiguration(
    cwd,
    tempRoot,
    "implement",
    process.env,
    "lenient",
    [],
    scoped,
  );
  const fallbackImplement = await sandboxConfiguration(cwd, tempRoot, "implement");
  const unrestrictedImplement = await sandboxConfiguration(
    cwd,
    tempRoot,
    "implement",
    process.env,
    "lenient",
    [],
    unrestricted,
  );
  const scopedReadonly = await sandboxConfiguration(
    cwd,
    tempRoot,
    "readonly",
    process.env,
    "lenient",
    [],
    scoped,
  );

  assert.deepEqual(scopedImplement.filesystem.allowWrite, [path.join(cwd, "src"), tempRoot]);
  assert.equal(scopedImplement.filesystem.allowWrite.includes(cwd), false);
  assert.equal((scopedImplement.filesystem.allowRead ?? []).includes(path.join(cwd, "src")), true);
  assert.equal((scopedImplement.filesystem.allowRead ?? []).includes(cwd), false);
  assert.deepEqual(fallbackImplement.filesystem.allowWrite, [cwd, tempRoot]);
  assert.deepEqual(unrestrictedImplement.filesystem.allowWrite, [cwd, tempRoot]);
  assert.deepEqual(scopedReadonly.filesystem.allowWrite, [tempRoot]);

  const { resolveStateDir } = await import("../src/state/state.js");
  const stateDir = await resolveStateDir(cwd);
  for (const configuration of [
    scopedImplement,
    fallbackImplement,
    unrestrictedImplement,
    scopedReadonly,
  ]) {
    assert.equal(configuration.filesystem.denyWrite.includes(stateDir), true);
    assert.equal(configuration.filesystem.denyWrite.includes(path.join(cwd, ".git")), true);
    assert.equal(configuration.filesystem.denyWrite.includes(path.join(cwd, ".env")), true);
    assert.equal(
      configuration.filesystem.denyWrite.includes(path.join(cwd, ".swarm-pi-policy.json")),
      true,
    );
  }
});

test("sandbox policy canonicalizes symlinked workspace aliases", async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-alias-")));
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-alias-home-")),
  );
  fs.mkdirSync(path.join(cwd, "src"));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-alias-link-"));
  const alias = path.join(aliasParent, "workspace");
  fs.symlinkSync(cwd, alias);
  const { bindProjectPolicy, compileEffectiveProjectPolicy } =
    await import("../src/policy/project-policy.js");
  const bound = await bindProjectPolicy(
    await compileEffectiveProjectPolicy({ cwd, profile: { dirs: ["src"] } }),
    cwd,
  );
  const configuration = await sandboxConfiguration(
    alias,
    tempRoot,
    "implement",
    process.env,
    "lenient",
    [],
    bound,
  );
  assert.equal((configuration.filesystem.allowRead ?? []).includes(path.join(cwd, "src")), true);
});
