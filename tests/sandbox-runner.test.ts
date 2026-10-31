import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
// The package does not export its resolved-address guard; the test loads it from the
// installed dist to apply the runner's own network config to an injected resolver.
import { createResolvedAddressGuard } from "@anthropic-ai/sandbox-runtime/dist/sandbox/resolved-address-guard.js";

import { detectSandboxAvailability } from "../src/sandbox/availability.js";
import {
  createSandboxRunner,
  sandboxConfiguration,
  sanitizedSandboxEnvironment,
} from "../src/sandbox/runner.js";

// The `live-sandbox` CI job, which prepares its disposable runner for user namespaces,
// sets SWARM_PI_REQUIRE_LIVE_SANDBOX=1. The live tests then always run, and a missing
// sandbox fails the suite instead of silently skipping containment checks. Other
// GitHub-hosted Linux jobs keep skipping them, because they cannot create sandboxes.
const liveSandboxRequired = process.env.SWARM_PI_REQUIRE_LIVE_SANDBOX === "1";
const liveSandboxAvailable =
  detectSandboxAvailability().available &&
  (liveSandboxRequired ||
    !(process.platform === "linux" && process.env.RUNNER_ENVIRONMENT === "github-hosted"));

test("live sandbox tests are not skipped where they are required", () => {
  if (!liveSandboxRequired) return;
  assert.equal(
    liveSandboxAvailable,
    true,
    `live sandbox required but unavailable: ${detectSandboxAvailability().reason ?? "unknown"}`,
  );
});

test("sandbox configuration parses with the installed sandbox runtime schema", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-schema-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-home-"));
  for (const mode of ["readonly", "implement"] as const) {
    for (const sandboxMode of ["lenient", "adaptive"] as const) {
      const config = await sandboxConfiguration(
        workspace,
        tempRoot,
        mode,
        process.env,
        sandboxMode,
      );
      const parsed = SandboxRuntimeConfigSchema.safeParse(config);
      assert.equal(parsed.success, true, `${mode}/${sandboxMode}: ${JSON.stringify(parsed.error)}`);
    }
  }
});

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

test("adaptive sandbox refuses a host name that resolves to a loopback or private address", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-resolve-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-home-"));
  const config = await sandboxConfiguration(
    workspace,
    tempRoot,
    "readonly",
    process.env,
    "adaptive",
    ["allowed.example.test"],
  );
  assert.equal(config.network.deniedDomains.includes("localhost"), true);
  assert.deepEqual(
    config.network.deniedDomains.filter((entry) => entry.includes("/")),
    [],
    "deniedDomains matches names exactly, so it holds no ranges",
  );
  const answers = new Map<string, string>([
    ["loopback.example.test", "127.0.0.1"],
    ["rfc1918-a.example.test", "10.1.2.3"],
    ["rfc1918-b.example.test", "172.20.0.5"],
    ["rfc1918-c.example.test", "192.168.1.10"],
    ["cgnat.example.test", "100.64.0.1"],
    ["cgnat-edge.example.test", "100.127.255.254"],
    ["ula-fc.example.test", "fc00::1"],
    ["ula-fd.example.test", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:fffe"],
    ["metadata.example.test", "169.254.169.254"],
    ["public.example.test", "93.184.216.34"],
    ["public-v6.example.test", "2606:4700:4700::1111"],
  ]);
  const guard = createResolvedAddressGuard({
    allowedDomains: config.network.allowedDomains,
    deniedDomains: config.network.deniedDomains,
    deniedResolvedAddresses: config.network.deniedResolvedAddresses ?? [],
    resolve: (
      hostname: string,
      _options: unknown,
      callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
    ) => {
      const address = answers.get(hostname) ?? "0.0.0.0";
      callback(null, [{ address, family: net.isIP(address) }]);
    },
    localAddresses: () => [],
  });
  const lookup = (hostname: string) =>
    new Promise<{ error?: { code?: string; message: string }; addresses: unknown[] }>((resolve) =>
      guard.lookupFor(443)(hostname, { all: true }, (error: Error | null, addresses: unknown) =>
        resolve({
          ...(error ? { error } : {}),
          addresses: Array.isArray(addresses) ? addresses : [],
        }),
      ),
    );

  for (const name of [
    "loopback.example.test",
    "rfc1918-a.example.test",
    "rfc1918-b.example.test",
    "rfc1918-c.example.test",
    "cgnat.example.test",
    "cgnat-edge.example.test",
    "ula-fc.example.test",
    "ula-fd.example.test",
    "metadata.example.test",
  ]) {
    const result = await lookup(name);
    assert.equal(result.error?.code, "ERR_SRT_RESOLVED_ADDRESS_DENIED", name);
    assert.deepEqual(result.addresses, [], name);
  }
  for (const name of ["public.example.test", "public-v6.example.test"]) {
    const allowed = await lookup(name);
    assert.equal(allowed.error, undefined, name);
    assert.equal(allowed.addresses.length, 1, name);
  }
});

test("sandbox keeps the runtime's bundled seccomp helper readable", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-helper-"));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-home-"));
  const config = await sandboxConfiguration(workspace, tempRoot, "readonly");
  const helper = (config.filesystem.allowRead ?? []).find((entry) =>
    (typeof entry === "string" ? entry : entry.path).endsWith(path.join("vendor", "seccomp")),
  );
  assert.ok(helper && typeof helper !== "string", "allowRead names the helper literally");
  assert.equal(helper.literal, true);
  // Seccomp is required on Linux; a macOS npm install may still ship the
  // Linux helper files, so their presence is not an OS capability assertion.
  if (process.platform === "linux")
    assert.equal(fs.existsSync(path.join(helper.path, process.arch, "apply-seccomp")), true);
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
  if (process.platform === "darwin") {
    const entries = (env.PATH ?? "").split(path.delimiter);
    const commandLineTools = "/Library/Developer/CommandLineTools/usr/bin";
    if (fs.existsSync(commandLineTools)) {
      assert.ok(entries.indexOf(commandLineTools) < entries.indexOf("/usr/bin"));
    }
  }
});

test("isolated worktree sandbox grants read-only Git administrative linkage", async () => {
  const { worktree } = createLinkedWorktree();
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-git-home-")),
  );
  const configuration = await sandboxConfiguration(
    worktree,
    tempRoot,
    "implement",
    process.env,
    "adaptive",
    [],
    undefined,
    true,
  );
  const gitDir = path.resolve(
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
      cwd: worktree,
      encoding: "utf8",
    }).trim(),
  );
  const commonDir = path.resolve(
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: worktree,
      encoding: "utf8",
    }).trim(),
  );
  for (const metadataPath of [path.join(worktree, ".git"), gitDir, commonDir]) {
    assert.equal(configuration.filesystem.allowRead?.includes(metadataPath), true);
    assert.equal(configuration.filesystem.denyRead.includes(metadataPath), false);
    assert.equal(configuration.filesystem.denyWrite.includes(metadataPath), true);
  }
});

test(
  "OS sandbox writes only when the worker mode permits it",
  {
    skip: !liveSandboxAvailable,
  },
  async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-live-"));
    const outside = path.join(os.tmpdir(), `swarm-pi-outside-${process.pid}.txt`);
    fs.rmSync(outside, { force: true });

    const readonly = await createSandboxRunner({ cwd: workspace, mode: "readonly" });
    try {
      const tool = readonly.createBashTool();
      const denied = await tool.execute(
        "readonly",
        { command: "printf blocked > readonly.txt" },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(denied.isError, true);
      assert.match(
        JSON.stringify(denied.content),
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
        undefined as never,
      );
      assert.equal(fs.readFileSync(path.join(workspace, "written.txt"), "utf8"), "allowed");
      await assert.rejects(
        () =>
          tool.execute(
            "timeout",
            { command: "sleep 2; printf late > late.txt", timeout: 0.05 },
            undefined,
            undefined,
            undefined as never,
          ),
        /timed out/i,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.existsSync(path.join(workspace, "late.txt")), false);
      const denied = await tool.execute(
        "outside",
        { command: `printf blocked > ${shellQuote(outside)}` },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(denied.isError, true);
      assert.match(
        JSON.stringify(denied.content),
        /exited with code|operation not permitted|permission denied/i,
      );
      assert.equal(fs.existsSync(outside), false);
    } finally {
      await implement.dispose();
      fs.rmSync(outside, { force: true });
    }
  },
);

async function runInSandbox(
  runner: Awaited<ReturnType<typeof createSandboxRunner>>,
  command: string,
) {
  return runner
    .createBashTool()
    .execute("containment", { command }, undefined, undefined, undefined as never);
}

test(
  "OS sandbox denies protected reads and writes inside an implement workspace",
  { skip: !liveSandboxAvailable },
  async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-contain-"));
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-secret-"));
    const credentials = path.join(secretDir, "aws-credentials");
    const control = path.join(secretDir, "control.txt");
    fs.writeFileSync(credentials, "synthetic-credential-value\n");
    fs.writeFileSync(control, "readable\n");
    const homeProfile = [".profile", ".bashrc"]
      .map((name) => path.join(os.homedir(), name))
      .find((candidate) => fs.existsSync(candidate));

    const runner = await createSandboxRunner({
      cwd: workspace,
      mode: "implement",
      env: { ...process.env, AWS_SHARED_CREDENTIALS_FILE: credentials },
    });
    try {
      const credentialRead = await runInSandbox(runner, `cat ${shellQuote(credentials)}`);
      assert.equal(credentialRead.isError, true);
      assert.doesNotMatch(JSON.stringify(credentialRead.content), /synthetic-credential-value/);

      const controlRead = await runInSandbox(runner, `cat ${shellQuote(control)}`);
      assert.notEqual(controlRead.isError, true);
      assert.match(JSON.stringify(controlRead.content), /readable/);

      if (homeProfile) {
        const homeRead = await runInSandbox(runner, `cat ${shellQuote(homeProfile)}`);
        assert.equal(homeRead.isError, true, "files in the real home directory are unreadable");
      }

      for (const target of [".env", ".env.local", ".swarm-pi-policy.json"]) {
        const denied = await runInSandbox(runner, `printf x > ${shellQuote(target)}`);
        assert.equal(denied.isError, true, `${target} must not be writable`);
        assert.equal(fs.existsSync(path.join(workspace, target)), false);
      }
    } finally {
      await runner.dispose();
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  },
);

test(
  "OS sandbox gives the worker no direct network path",
  { skip: !liveSandboxAvailable },
  async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-net-"));
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.end("hello\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const runner = await createSandboxRunner({ cwd: workspace, mode: "readonly" });
    try {
      const result = await runInSandbox(
        runner,
        `${shellQuote(process.execPath)} -e ${shellQuote(
          `const s = require('node:net').connect(${port}, '127.0.0.1'); process.stdout.write('node-ready\\n'); s.setTimeout(1000, () => process.exit(74)); s.on('error', () => process.exit(73)); s.on('data', b => process.stdout.write(b)); s.on('end', () => process.exit(0));`,
        )}`,
      );
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(result.content), /hello/);
      assert.match(
        JSON.stringify(result.content),
        /node-ready/,
        "Node executed inside the sandbox",
      );
      assert.equal(connections, 0, "the sandboxed process never reached the owned listener");
    } finally {
      await runner.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test(
  "isolated worktree sandbox can inspect Git without metadata writes",
  {
    skip: !liveSandboxAvailable,
  },
  async () => {
    const { worktree } = createLinkedWorktree();
    const runner = await createSandboxRunner({
      cwd: worktree,
      mode: "implement",
      sandboxMode: "adaptive",
      allowGitMetadataRead: true,
    });
    try {
      const tool = runner.createBashTool();
      await tool.execute(
        "status",
        { command: "git status --porcelain=v1 --untracked-files=all" },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(
        execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: worktree,
          encoding: "utf8",
        }),
        "",
      );
    } finally {
      await runner.dispose();
    }
  },
);

function createLinkedWorktree(): { source: string; worktree: string } {
  const source = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-git-source-")),
  );
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  fs.writeFileSync(path.join(source, "README.md"), "sandbox fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: source });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Sandbox Test",
      "-c",
      "user.email=sandbox@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: source },
  );
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-sandbox-git-worktree-"));
  const worktree = path.join(worktreeParent, "child");
  execFileSync("git", ["worktree", "add", "--detach", "--quiet", worktree], { cwd: source });
  return { source, worktree: fs.realpathSync(worktree) };
}

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
