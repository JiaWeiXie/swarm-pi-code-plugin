#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PLUGIN_NAME = "swarm-pi-code-plugin";
const CLAUDE_PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_NAME}`;
const CODEX_MARKETPLACE = "swarm-pi-code-plugin-local";
const CODEX_PLUGIN_ID = `${PLUGIN_NAME}@${CODEX_MARKETPLACE}`;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CODEX_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\+codex\.(\d{14})$/;
const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "plugins/swarm-pi-code-plugin/package.json",
  "plugins/swarm-pi-code-plugin/package-lock.json",
  "plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json",
  "plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

const root = process.cwd();

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const { command, target, dryRun, installed, reinstall } = parseArguments(process.argv.slice(2));
  const state = await readVersionState(root);
  const current = validateVersionState(state);

  if (command === "check") {
    if (installed) await checkInstalledPlugins(current, root);
    process.stdout.write(
      [
        `Version sources are consistent: ${current.baseVersion} (${current.codexVersion}).`,
        ...(installed ? ["Installed Claude Code and Codex plugins are current and enabled."] : []),
        "",
      ].join("\n"),
    );
    return;
  }

  const nextVersion = resolveNextVersion(current.baseVersion, target);
  const codexVersion = `${nextVersion}+codex.${utcTimestamp(new Date())}`;
  const plan = createVersionPlan(state, nextVersion, codexVersion);

  if (reinstall && !dryRun) await reinstallCodexPlugin();
  if (!dryRun) {
    await applyVersionPlan(root, plan, current.rawFiles);
  }
  if (reinstall && !dryRun) await reinstallCodexPlugin();

  process.stdout.write(
    [
      dryRun ? "Version bump dry run:" : "Version bump completed:",
      `  previous: ${current.baseVersion}`,
      `  next: ${nextVersion}`,
      `  Codex: ${codexVersion}`,
      "  changed files:",
      ...VERSION_FILES.map((file) => `    - ${file}`),
      ...(dryRun
        ? []
        : [
            "  next steps:",
            "    - mise run version-check",
            "    - mise run version-check-installed",
            "    - mise run check",
            `    - codex plugin add ${CODEX_PLUGIN_ID}`,
          ]),
    ].join("\n") + "\n",
  );
}

function parseArguments(args) {
  const [command, ...commandArgs] = args;
  if (command === "check") {
    const installed = commandArgs.filter((arg) => arg === "--installed").length;
    if (commandArgs.length === installed && installed <= 1) {
      return { command, dryRun: false, installed: installed === 1, reinstall: false };
    }
  }
  if (command === "bump") {
    const targets = commandArgs.filter((arg) => !arg.startsWith("--"));
    const target = targets[0];
    const dryRun = commandArgs.filter((arg) => arg === "--dry-run").length;
    const reinstall = commandArgs.filter((arg) => arg === "--reinstall").length;
    if (
      target &&
      targets.length === 1 &&
      commandArgs.length === targets.length + dryRun + reinstall &&
      dryRun <= 1 &&
      reinstall <= 1
    ) {
      return {
        command,
        target,
        dryRun: dryRun === 1,
        installed: false,
        reinstall: reinstall === 1,
      };
    }
  }
  throw usage(
    "Expected `check [--installed]` or `bump <patch|minor|major|X.Y.Z> [--dry-run] [--reinstall]`.",
  );
}

function usage(message) {
  return new Error(
    `${message}\nUsage:\n  mise run version-check\n  mise run version-check-installed\n  mise run version-bump -- <patch|minor|major|X.Y.Z> [--dry-run] [--reinstall]`,
  );
}

async function readVersionState(cwd) {
  const rawFiles = new Map();
  const documents = new Map();
  for (const relativePath of VERSION_FILES) {
    const absolutePath = path.join(cwd, relativePath);
    let raw;
    try {
      raw = await readFile(absolutePath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read ${relativePath}: ${errorMessage(error)}`);
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid JSON in ${relativePath}: ${errorMessage(error)}`);
    }
    rawFiles.set(relativePath, raw);
    documents.set(relativePath, document);
  }
  return { rawFiles, documents };
}

function validateVersionState(state, expectedVersion) {
  const rootPackage = requireRecord(state.documents.get("package.json"), "package.json");
  const baseVersion = requireStableVersion(rootPackage.version, "package.json version");
  if (expectedVersion && baseVersion !== expectedVersion) {
    throw new Error(
      `Post-write version mismatch: expected ${expectedVersion}, found ${baseVersion}.`,
    );
  }

  const rootLock = requireRecord(state.documents.get("package-lock.json"), "package-lock.json");
  const pluginPackage = requireRecord(
    state.documents.get("plugins/swarm-pi-code-plugin/package.json"),
    "plugin package.json",
  );
  const pluginLock = requireRecord(
    state.documents.get("plugins/swarm-pi-code-plugin/package-lock.json"),
    "plugin package-lock.json",
  );
  const claudeManifest = requireRecord(
    state.documents.get("plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json"),
    "Claude plugin manifest",
  );
  const codexManifest = requireRecord(
    state.documents.get("plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json"),
    "Codex plugin manifest",
  );
  const marketplace = requireRecord(
    state.documents.get(".claude-plugin/marketplace.json"),
    "Claude marketplace",
  );
  const rootLockPackages = requireRecord(rootLock.packages, "package-lock.json packages");
  const pluginLockPackages = requireRecord(
    pluginLock.packages,
    "plugin package-lock.json packages",
  );
  const rootLockPackage = requireRecord(rootLockPackages[""], 'package-lock.json packages[""]');
  const pluginLockPackage = requireRecord(
    pluginLockPackages[""],
    'plugin package-lock.json packages[""]',
  );
  const metadata = requireRecord(marketplace.metadata, "Claude marketplace metadata");
  const pluginEntries = requireArray(marketplace.plugins, "Claude marketplace plugins").filter(
    (entry) => requireRecord(entry, "Claude marketplace plugin entry").name === PLUGIN_NAME,
  );
  if (pluginEntries.length !== 1) {
    throw new Error(
      `Claude marketplace must contain exactly one ${PLUGIN_NAME} entry; found ${pluginEntries.length}.`,
    );
  }
  const marketplacePlugin = requireRecord(pluginEntries[0], "Claude marketplace plugin entry");

  const comparisons = [
    ["package-lock.json version", rootLock.version],
    ['package-lock.json packages[""].version', rootLockPackage.version],
    ["plugin package.json version", pluginPackage.version],
    ["plugin package-lock.json version", pluginLock.version],
    ['plugin package-lock.json packages[""].version', pluginLockPackage.version],
    ["Claude plugin manifest version", claudeManifest.version],
    ["Claude marketplace metadata.version", metadata.version],
    [`Claude marketplace ${PLUGIN_NAME} version`, marketplacePlugin.version],
  ];
  for (const [label, value] of comparisons) {
    if (value !== baseVersion) {
      throw new Error(
        `Version drift: ${label} is ${JSON.stringify(value)}; expected ${baseVersion}.`,
      );
    }
  }

  if (typeof codexManifest.version !== "string") {
    throw new Error("Codex plugin manifest version must be a string.");
  }
  const codexMatch = CODEX_VERSION_PATTERN.exec(codexManifest.version);
  if (!codexMatch) {
    throw new Error("Codex plugin manifest version must be <X.Y.Z>+codex.<UTC YYYYMMDDHHMMSS>.");
  }
  const codexBase = `${codexMatch[1]}.${codexMatch[2]}.${codexMatch[3]}`;
  if (codexBase !== baseVersion) {
    throw new Error(
      `Version drift: Codex plugin base version is ${codexBase}; expected ${baseVersion}.`,
    );
  }

  validateHookManifest("Claude", claudeManifest);
  validateHookManifest("Codex", codexManifest);

  return {
    baseVersion,
    codexVersion: codexManifest.version,
    rawFiles: state.rawFiles,
  };
}

function validateHookManifest(host, manifest) {
  if (Object.hasOwn(manifest, "hooks")) {
    throw new Error(
      `${host} plugin manifest must not declare hooks; hooks/hooks.json is loaded automatically by Claude Code.`,
    );
  }
}

async function checkInstalledPlugins(current, cwd) {
  const claudePlugins = runJsonCommand("claude", ["plugin", "list", "--json"], "Claude Code");
  const claude = claudePlugins.find((entry) => entry?.id === CLAUDE_PLUGIN_ID);
  if (!claude) {
    throw new Error(
      `Claude Code plugin ${CLAUDE_PLUGIN_ID} is not installed. Run: claude plugin install ${CLAUDE_PLUGIN_ID}`,
    );
  }
  if (claude.version !== current.baseVersion) {
    throw new Error(
      `Claude Code plugin is stale: installed ${JSON.stringify(claude.version)}, expected ${current.baseVersion}. Run: claude plugin update ${CLAUDE_PLUGIN_ID}`,
    );
  }
  if (claude.enabled !== true) {
    throw new Error(`Claude Code plugin ${CLAUDE_PLUGIN_ID} is installed but disabled.`);
  }
  await validateInstalledClaudePlugin(claude.installPath, current.baseVersion);

  const codexPayload = runJsonCommand(
    "codex",
    ["plugin", "list", "--marketplace", CODEX_MARKETPLACE, "--json"],
    "Codex",
  );
  const codexPlugins = Array.isArray(codexPayload) ? codexPayload : codexPayload.installed;
  if (!Array.isArray(codexPlugins)) {
    throw new Error("Codex plugin list JSON did not contain an installed array.");
  }
  const codex = codexPlugins.find((entry) => entry?.pluginId === CODEX_PLUGIN_ID);
  if (!codex) {
    throw new Error(
      `Codex plugin ${CODEX_PLUGIN_ID} is not installed. Run: codex plugin add ${CODEX_PLUGIN_ID}`,
    );
  }
  if (codex.version !== current.codexVersion) {
    throw new Error(
      `Codex plugin is stale: installed ${JSON.stringify(codex.version)}, expected ${current.codexVersion}. Run: codex plugin remove ${CODEX_PLUGIN_ID} && codex plugin add ${CODEX_PLUGIN_ID}`,
    );
  }
  if (codex.enabled !== true) {
    throw new Error(`Codex plugin ${CODEX_PLUGIN_ID} is installed but disabled.`);
  }
  const expectedSource = path.resolve(cwd, "plugins/swarm-pi-code-plugin");
  const installedSource = path.resolve(codex.source?.path ?? "");
  const [expectedRealSource, installedRealSource] = await Promise.all([
    realpath(expectedSource),
    realpath(installedSource),
  ]);
  if (installedRealSource !== expectedRealSource) {
    throw new Error(
      `Codex plugin source drift: installed ${JSON.stringify(codex.source?.path)}, expected ${expectedSource}.`,
    );
  }
}

async function validateInstalledClaudePlugin(installPath, expectedVersion) {
  if (typeof installPath !== "string" || !installPath) {
    throw new Error("Claude Code plugin install path is missing from the plugin registry.");
  }
  const manifestPath = path.join(installPath, ".claude-plugin/plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read installed Claude manifest ${manifestPath}: ${errorMessage(error)}`,
    );
  }
  if (manifest.name !== PLUGIN_NAME || manifest.version !== expectedVersion) {
    throw new Error(
      `Installed Claude manifest identity/version drift: expected ${PLUGIN_NAME}@${expectedVersion}.`,
    );
  }
  validateHookManifest("Installed Claude", manifest);
  const hooksPath = path.join(installPath, "hooks/hooks.json");
  try {
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    if (!hooks || typeof hooks.hooks !== "object" || Array.isArray(hooks.hooks)) {
      throw new Error("hooks/hooks.json must contain a hooks object.");
    }
  } catch (error) {
    throw new Error(
      `Unable to validate installed Claude hooks ${hooksPath}: ${errorMessage(error)}`,
    );
  }
}

function runJsonCommand(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) {
    throw new Error(`${label} command failed to start: ${errorMessage(result.error)}.`);
  }
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${label} command failed (${result.status}): ${details}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed;
  } catch (error) {
    throw new Error(`${label} command returned invalid JSON: ${errorMessage(error)}`);
  }
}

async function reinstallCodexPlugin() {
  const remove = spawnSync("codex", ["plugin", "remove", CODEX_PLUGIN_ID], {
    cwd: root,
    encoding: "utf8",
  });
  if (remove.error) {
    throw new Error(`Codex reinstall failed to start: ${errorMessage(remove.error)}.`);
  }
  if (remove.status !== 0) {
    const details = [remove.stdout, remove.stderr].filter(Boolean).join("\n").trim();
    if (!/not installed|not found|does not exist/i.test(details)) {
      throw new Error(`Codex plugin removal failed (${remove.status}): ${details}`);
    }
  }
  const add = spawnSync("codex", ["plugin", "add", CODEX_PLUGIN_ID], {
    cwd: root,
    encoding: "utf8",
  });
  if (add.error) {
    throw new Error(`Codex reinstall failed to start: ${errorMessage(add.error)}.`);
  }
  if (add.status !== 0) {
    const details = [add.stdout, add.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`Codex plugin installation failed (${add.status}): ${details}`);
  }
}

function resolveNextVersion(current, target) {
  const currentParts = parseVersion(current);
  let nextParts;
  if (target === "patch") nextParts = [currentParts[0], currentParts[1], currentParts[2] + 1n];
  else if (target === "minor") nextParts = [currentParts[0], currentParts[1] + 1n, 0n];
  else if (target === "major") nextParts = [currentParts[0] + 1n, 0n, 0n];
  else nextParts = parseVersion(target);

  if (compareVersions(nextParts, currentParts) <= 0) {
    throw new Error(`Next version must be greater than ${current}; received ${target}.`);
  }
  return nextParts.join(".");
}

function parseVersion(value) {
  const version = requireStableVersion(value, "version target");
  return version.split(".").map(BigInt);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function createVersionPlan(state, nextVersion, codexVersion) {
  const documents = state.documents;
  documents.get("package.json").version = nextVersion;
  documents.get("package-lock.json").version = nextVersion;
  documents.get("package-lock.json").packages[""].version = nextVersion;
  documents.get("plugins/swarm-pi-code-plugin/package.json").version = nextVersion;
  documents.get("plugins/swarm-pi-code-plugin/package-lock.json").version = nextVersion;
  documents.get("plugins/swarm-pi-code-plugin/package-lock.json").packages[""].version =
    nextVersion;
  documents.get("plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json").version = nextVersion;
  documents.get("plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json").version = codexVersion;
  documents.get(".claude-plugin/marketplace.json").metadata.version = nextVersion;
  const marketplacePlugin = documents
    .get(".claude-plugin/marketplace.json")
    .plugins.find((entry) => entry.name === PLUGIN_NAME);
  marketplacePlugin.version = nextVersion;
  return new Map(
    VERSION_FILES.map((relativePath) => [
      relativePath,
      `${JSON.stringify(documents.get(relativePath), null, 2)}\n`,
    ]),
  );
}

async function applyVersionPlan(cwd, plan, originals) {
  const staged = new Map();
  try {
    for (const [relativePath, contents] of plan) {
      const destination = path.join(cwd, relativePath);
      const temporary = `${destination}.version-${process.pid}-${randomUUID()}.tmp`;
      const mode = (await stat(destination)).mode;
      await writeFile(temporary, contents, "utf8");
      await chmod(temporary, mode);
      staged.set(relativePath, temporary);
    }
    for (const relativePath of VERSION_FILES) {
      await rename(staged.get(relativePath), path.join(cwd, relativePath));
      staged.delete(relativePath);
    }
    if (process.env.SWARM_PI_VERSION_TEST_FAIL_POSTWRITE === "1") {
      throw new Error("Injected post-write validation failure.");
    }
    const written = await readVersionState(cwd);
    const expected = JSON.parse(plan.get("package.json")).version;
    validateVersionState(written, expected);
  } catch (error) {
    const rollbackErrors = [];
    for (const relativePath of VERSION_FILES) {
      try {
        await restoreFile(path.join(cwd, relativePath), originals.get(relativePath));
      } catch (rollbackError) {
        rollbackErrors.push(`${relativePath}: ${errorMessage(rollbackError)}`);
      }
    }
    const suffix = rollbackErrors.length
      ? ` Rollback also failed for ${rollbackErrors.join("; ")}.`
      : " All version files were restored.";
    throw new Error(`Version bump failed: ${errorMessage(error)}${suffix}`);
  } finally {
    await Promise.all(
      [...staged.values()].map((temporary) => unlink(temporary).catch(() => undefined)),
    );
  }
}

async function restoreFile(destination, contents) {
  const temporary = `${destination}.rollback-${process.pid}-${randomUUID()}.tmp`;
  const mode = (await stat(destination)).mode;
  try {
    await writeFile(temporary, contents, "utf8");
    await chmod(temporary, mode);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function utcTimestamp(date) {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

function requireStableVersion(value, label) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} must be a stable X.Y.Z version; received ${JSON.stringify(value)}.`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
