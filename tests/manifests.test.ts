import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const repoRoot = process.cwd();

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("Claude and Codex manifests use the swarm-pi-code-plugin identity", () => {
  const packageManifest = readJson("package.json");
  const claude = readJson("plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json");
  const codex = readJson("plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json");
  const version = packageManifest.version as string;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  assert.equal(claude.name, "swarm-pi-code-plugin");
  assert.equal(codex.name, "swarm-pi-code-plugin");
  assert.equal(claude.version, version);
  assert.match(codex.version as string, new RegExp(`^${escapedVersion}\\+codex\\.\\d{14}$`));
  assert.equal(codex.skills, "./skills/");
});

test("plugin package contains both host adapters and a self-contained runner", () => {
  const pluginRoot = path.join(repoRoot, "plugins/swarm-pi-code-plugin");
  const skills = ["configure", "project", "ask", "review", "plan", "implement", "orchestrate", "scaffold", "setup"];
  for (const skill of skills) {
    const file = path.join(
      pluginRoot,
      "skills",
      `swarm-pi-code-plugin-${skill}`,
      "SKILL.md",
    );
    assert.equal(fs.existsSync(file), true, `missing Codex skill: ${skill}`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /cross-host control protocol/i);
    assert.equal(fs.existsSync(path.join(path.dirname(file), "agents/openai.yaml")), true, `missing Codex metadata: ${skill}`);
    const metadata = fs.readFileSync(path.join(path.dirname(file), "agents/openai.yaml"), "utf8");
    assert.match(metadata, /display_name:/);
    assert.match(metadata, new RegExp(`\\$swarm-pi-code-plugin-${skill}`));
  }

  for (const relative of [
    "agents/pi-worker.md",
    "agents/pi-builder.md",
    "scripts/bootstrap.mjs",
    "scripts/pi-runner.mjs",
    "runtime/cli.js",
    "runtime/web/configuration-server.js",
    "runtime/onboarding/readiness.js",
    "runtime/onboarding/continuations.js",
    "runtime/git/scaffold.js",
    "package.json",
    "package-lock.json",
  ]) {
    assert.equal(fs.existsSync(path.join(pluginRoot, relative)), true, `missing plugin file: ${relative}`);
  }

  const implementation = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-code-plugin-implement/SKILL.md"),
    "utf8",
  );
  assert.match(implementation, /explicit mutation intent/i);
  assert.match(implementation, /safe-dirty/i);
  assert.match(implementation, /isolated-snapshot/i);
  assert.match(implementation, /host-owned verification/i);
  assert.match(implementation, /--execution-mode supervised/);
  assert.match(implementation, /background only.*mechanical-executor/i);
  assert.match(implementation, /mechanical-executor/);
  assert.match(implementation, /deliverable: false/);
  assert.match(implementation, /workspace-unborn-head/);
  assert.match(implementation, /jobs materialize/);

  const orchestration = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-code-plugin-orchestrate/SKILL.md"),
    "utf8",
  );
  assert.match(orchestration, /EvidencePack/);
  assert.match(orchestration, /source job ID/i);

  for (const skill of ["ask", "review", "plan", "implement", "orchestrate"]) {
    const source = fs.readFileSync(
      path.join(pluginRoot, "skills", `swarm-pi-code-plugin-${skill}`, "SKILL.md"),
      "utf8",
    );
    assert.match(source, /cross-host control protocol/i);
    assert.match(source, /--execution-mode/);
  }
  for (const skill of ["scaffold", "setup"]) {
    const source = fs.readFileSync(path.join(pluginRoot, "skills", `swarm-pi-code-plugin-${skill}`, "SKILL.md"), "utf8");
    assert.match(source, /cross-host control protocol/i);
    assert.match(source, /--execution-mode/);
  }
  for (const command of ["init", "project", "ask", "review", "plan", "implement", "orchestrate", "scaffold", "setup"]) {
    const commandPath = path.join(pluginRoot, "commands", `${command}.md`);
    assert.equal(fs.existsSync(commandPath), true, `missing Claude command: ${command}`);
    assert.match(fs.readFileSync(commandPath, "utf8"), /swarm-pi-code-plugin-/);
  }
  const protocolPath = path.join(pluginRoot, "skills/references/host-protocol.md");
  assert.equal(fs.existsSync(protocolPath), true);
  const protocol = fs.readFileSync(protocolPath, "utf8");
  assert.match(protocol, /capabilities\.mutation/);
  assert.match(protocol, /EvidencePack/);
  assert.match(protocol, /wait-timeout-ms 15000/);

  const workerAgent = fs.readFileSync(path.join(pluginRoot, "agents/pi-worker.md"), "utf8");
  assert.match(workerAgent, /swarm-pi-code-plugin-orchestrate/);
  assert.match(workerAgent, /host-protocol/);

  const configure = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-code-plugin-configure/SKILL.md"),
    "utf8",
  );
  assert.match(configure, /\$RUNNER configure --host "\$HOST"/);
  assert.match(configure, /model\.json/);
  assert.match(configure, /Never request an API key/i);
  assert.doesNotMatch(configure, /Ask for a replacement project goal/i);

  const project = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-code-plugin-project/SKILL.md"),
    "utf8",
  );
  assert.match(project, /\$RUNNER configure --host "\$HOST" --section project/);
  assert.match(project, /workflow is repeatable/i);
  const initCommand = fs.readFileSync(path.join(pluginRoot, "commands/init.md"), "utf8");
  assert.doesNotMatch(initCommand, /Ask for replacement project goal/i);

  const pluginPackage = readJson("plugins/swarm-pi-code-plugin/package.json") as {
    dependencies: Record<string, string>;
  };
  assert.equal(pluginPackage.dependencies["@earendil-works/pi-coding-agent"], "0.80.6");
  assert.equal(pluginPackage.dependencies["@carderne/sandbox-runtime"], "0.0.49");

  execFileSync(process.execPath, ["--check", path.join(pluginRoot, "scripts/bootstrap.mjs")]);
  execFileSync(process.execPath, ["--check", path.join(pluginRoot, "scripts/pi-runner.mjs")]);
});

test("repo marketplaces point at the shared plugin root", () => {
  const claude = readJson(".claude-plugin/marketplace.json") as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };
  const codex = readJson(".agents/plugins/marketplace.json") as {
    name: string;
    plugins: Array<{ name: string; source: { path: string } }>;
  };

  assert.equal(claude.name, "swarm-pi-code-plugin");
  assert.equal(claude.plugins[0]?.name, "swarm-pi-code-plugin");
  assert.equal(claude.plugins[0]?.source, "./plugins/swarm-pi-code-plugin");
  assert.equal(codex.name, "swarm-pi-code-plugin-local");
  assert.equal(codex.plugins[0]?.name, "swarm-pi-code-plugin");
  assert.equal(codex.plugins[0]?.source.path, "./plugins/swarm-pi-code-plugin");
});
