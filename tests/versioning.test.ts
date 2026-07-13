import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const script = path.join(repoRoot, "scripts/plugin-version.mjs");
const pluginName = "swarm-pi-code-plugin";
const versionFiles = [
  "package.json",
  "package-lock.json",
  "plugins/swarm-pi-code-plugin/package.json",
  "plugins/swarm-pi-code-plugin/package-lock.json",
  "plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json",
  "plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

for (const [target, expected] of [
  ["patch", "0.6.1"],
  ["minor", "0.7.0"],
  ["major", "1.0.0"],
  ["1.2.3", "1.2.3"],
] as const) {
  test(`version bump ${target} synchronizes every version source`, (context) => {
    const fixture = createFixture(context, { marketplacePluginIndex: 1 });
    const output = run(fixture, ["bump", target]);

    assert.match(output, new RegExp(`next: ${expected.replaceAll(".", "\\.")}`));
    assertVersionState(fixture, expected);
    const marketplace = readJson(fixture, ".claude-plugin/marketplace.json");
    assert.equal((marketplace.plugins as Array<{ name: string }>)[0]?.name, "unrelated-plugin");
  });
}

test("version dry-run reports the plan without modifying files", (context) => {
  const fixture = createFixture(context);
  const before = snapshot(fixture);
  const output = run(fixture, ["bump", "--reinstall", "patch", "--dry-run"]);

  assert.match(output, /Version bump dry run:/);
  assert.match(output, /next: 0\.6\.1/);
  assert.deepEqual(snapshot(fixture), before);
});

test("version check rejects drift before a bump writes files", (context) => {
  const fixture = createFixture(context);
  const rootLock = readJson(fixture, "package-lock.json");
  rootLock.version = "0.5.0";
  writeJson(fixture, "package-lock.json", rootLock);
  const before = snapshot(fixture);

  const result = runFailure(fixture, ["bump", "patch"]);
  assert.match(result.stderr, /Version drift: package-lock\.json version is "0\.5\.0"/);
  assert.deepEqual(snapshot(fixture), before);
});

test("version check rejects a duplicate Claude hooks declaration", (context) => {
  const fixture = createFixture(context);
  const claude = readJson(fixture, "plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json");
  claude.hooks = "./hooks/hooks.json";
  writeJson(fixture, "plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json", claude);

  const result = runFailure(fixture, ["check"]);
  assert.match(result.stderr, /Claude plugin manifest must not declare hooks/);
});

test("installed version check validates Claude and Codex records", (context) => {
  const fixture = createFixture(context);
  const expectedVersion = readJson(fixture, "package.json").version as string;
  const expectedCodexVersion = readJson(
    fixture,
    "plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json",
  ).version as string;
  const bin = path.join(fixture, "fake-bin");
  const claudeInstall = path.join(fixture, "claude-install");
  fs.mkdirSync(path.join(bin), { recursive: true });
  fs.mkdirSync(path.join(claudeInstall, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(claudeInstall, "hooks"), { recursive: true });
  fs.copyFileSync(
    path.join(fixture, "plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json"),
    path.join(claudeInstall, ".claude-plugin/plugin.json"),
  );
  fs.copyFileSync(
    path.join(repoRoot, "plugins/swarm-pi-code-plugin/hooks/hooks.json"),
    path.join(claudeInstall, "hooks/hooks.json"),
  );
  writeExecutable(
    path.join(bin, "claude"),
    `process.stdout.write(${JSON.stringify(
      JSON.stringify([
        {
          id: "swarm-pi-code-plugin@swarm-pi-code-plugin",
          version: expectedVersion,
          enabled: true,
          installPath: claudeInstall,
        },
      ]),
    )});\n`,
  );
  writeExecutable(
    path.join(bin, "codex"),
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({
        installed: [
          {
            pluginId: "swarm-pi-code-plugin@swarm-pi-code-plugin-local",
            version: expectedCodexVersion,
            enabled: true,
            source: { path: path.join(fixture, "plugins/swarm-pi-code-plugin") },
          },
        ],
      }),
    )});\n`,
  );

  const output = run(fixture, ["check", "--installed"], {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  assert.match(output, /Installed Claude Code and Codex plugins are current and enabled/);
});

test("installed version check reports a stale Claude plugin", (context) => {
  const fixture = createFixture(context);
  const bin = path.join(fixture, "fake-bin");
  fs.mkdirSync(bin, { recursive: true });
  writeExecutable(
    path.join(bin, "claude"),
    `process.stdout.write(${JSON.stringify(
      JSON.stringify([
        {
          id: "swarm-pi-code-plugin@swarm-pi-code-plugin",
          version: "0.5.1",
          enabled: true,
          installPath: fixture,
        },
      ]),
    )});\n`,
  );
  const result = runFailure(fixture, ["check", "--installed"], {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  });
  assert.match(result.stderr, /Claude Code plugin is stale/);
});

for (const target of ["1.2", "v1.2.3", "1.2.3-beta.1", "0.6.0", "0.5.9"]) {
  test(`version bump rejects ${target}`, (context) => {
    const fixture = createFixture(context);
    const before = snapshot(fixture);
    const result = runFailure(fixture, ["bump", target]);

    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(fixture), before);
  });
}

test("version bump replaces one Codex cachebuster suffix", (context) => {
  const fixture = createFixture(context);
  run(fixture, ["bump", "patch"]);
  const manifest = readJson(fixture, "plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json");

  assert.match(manifest.version as string, /^0\.6\.1\+codex\.\d{14}$/);
  assert.equal((manifest.version as string).match(/\+codex\./g)?.length, 1);
});

test("version bump reinstalls the local Codex plugin before and after writing", (context) => {
  const fixture = createFixture(context);
  const bin = path.join(fixture, "fake-bin");
  const log = path.join(fixture, "codex-commands.log");
  fs.mkdirSync(bin, { recursive: true });
  writeExecutable(
    path.join(bin, "codex"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.SWARM_PI_VERSION_TEST_REINSTALL_LOG, `${process.argv.slice(2).join(" ")}\\n`);\n',
  );

  run(fixture, ["bump", "patch", "--reinstall"], {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SWARM_PI_VERSION_TEST_REINSTALL_LOG: log,
  });

  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    "plugin remove swarm-pi-code-plugin@swarm-pi-code-plugin-local",
    "plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local",
    "plugin remove swarm-pi-code-plugin@swarm-pi-code-plugin-local",
    "plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local",
  ]);
  assertVersionState(fixture, "0.6.1");
});

test("post-write validation failure restores every original file", (context) => {
  const fixture = createFixture(context);
  const before = snapshot(fixture);
  const result = runFailure(fixture, ["bump", "patch"], {
    SWARM_PI_VERSION_TEST_FAIL_POSTWRITE: "1",
  });

  assert.match(result.stderr, /Injected post-write validation failure/);
  assert.match(result.stderr, /All version files were restored/);
  assert.deepEqual(snapshot(fixture), before);
});

function createFixture(
  context: { after(callback: () => void): void },
  options: { marketplacePluginIndex?: number } = {},
): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-version-test-"));
  context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const relativePath of versionFiles) {
    const source = path.join(repoRoot, relativePath);
    const destination = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  if (options.marketplacePluginIndex === 1) {
    const marketplace = readJson(fixture, ".claude-plugin/marketplace.json");
    (marketplace.plugins as unknown[]).unshift({
      name: "unrelated-plugin",
      version: "9.9.9",
      source: "./plugins/unrelated-plugin",
    });
    writeJson(fixture, ".claude-plugin/marketplace.json", marketplace);
  }
  return fixture;
}

function assertVersionState(fixture: string, expected: string): void {
  const rootPackage = readJson(fixture, "package.json");
  const rootLock = readJson(fixture, "package-lock.json");
  const pluginPackage = readJson(fixture, "plugins/swarm-pi-code-plugin/package.json");
  const pluginLock = readJson(fixture, "plugins/swarm-pi-code-plugin/package-lock.json");
  const claude = readJson(fixture, "plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json");
  const codex = readJson(fixture, "plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json");
  const marketplace = readJson(fixture, ".claude-plugin/marketplace.json");
  const marketplacePlugin = (marketplace.plugins as Array<{ name: string; version?: string }>).find(
    (entry) => entry.name === pluginName,
  );

  assert.equal(rootPackage.version, expected);
  assert.equal(rootLock.version, expected);
  assert.equal((rootLock.packages as Record<string, { version: string }>)[""]?.version, expected);
  assert.equal(pluginPackage.version, expected);
  assert.equal(pluginLock.version, expected);
  assert.equal((pluginLock.packages as Record<string, { version: string }>)[""]?.version, expected);
  assert.equal(claude.version, expected);
  assert.match(
    codex.version as string,
    new RegExp(`^${expected.replaceAll(".", "\\.")}\\+codex\\.\\d{14}$`),
  );
  assert.equal((marketplace.metadata as { version: string }).version, expected);
  assert.equal(marketplacePlugin?.version, expected);
}

function snapshot(fixture: string): Record<string, string> {
  return Object.fromEntries(
    versionFiles.map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(fixture, relativePath), "utf8"),
    ]),
  );
}

function readJson(fixture: string, relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(fixture, relativePath), "utf8"));
}

function writeJson(fixture: string, relativePath: string, value: unknown): void {
  fs.writeFileSync(path.join(fixture, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function run(fixture: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

function runFailure(
  fixture: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.notEqual(result.status, 0);
  return { status: result.status, stderr: result.stderr };
}

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(file, 0o755);
}
