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
  const claude = readJson("plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json");
  const codex = readJson("plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json");

  assert.equal(claude.name, "swarm-pi-code-plugin");
  assert.equal(codex.name, "swarm-pi-code-plugin");
  assert.equal(claude.version, "0.1.0");
  assert.match(codex.version as string, /^0\.1\.0\+codex\.\d{14}$/);
  assert.equal(codex.skills, "./skills/");
});

test("plugin package contains both host adapters and a self-contained runner", () => {
  const pluginRoot = path.join(repoRoot, "plugins/swarm-pi-code-plugin");
  const skills = ["configure", "project", "ask", "review", "plan", "implement", "orchestrate"];
  for (const skill of skills) {
    const file = path.join(
      pluginRoot,
      "skills",
      `swarm-pi-code-plugin-${skill}`,
      "SKILL.md",
    );
    assert.equal(fs.existsSync(file), true, `missing Codex skill: ${skill}`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /pi-runner\.mjs/);
    assert.match(source, /--host "\$HOST"/);
  }

  for (const relative of [
    "commands/init.md",
    "agents/pi-worker.md",
    "agents/pi-builder.md",
    "scripts/bootstrap.mjs",
    "scripts/pi-runner.mjs",
    "runtime/cli.js",
    "runtime/web/configuration-server.js",
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
  assert.match(implementation, /clean worktree/i);
  assert.match(implementation, /verification from the host/i);
  assert.match(implementation, /--execution-mode supervised/);
  assert.match(implementation, /background implementation is prohibited/i);

  for (const skill of ["ask", "review", "plan", "implement", "orchestrate"]) {
    const source = fs.readFileSync(
      path.join(pluginRoot, "skills", `swarm-pi-code-plugin-${skill}`, "SKILL.md"),
      "utf8",
    );
    assert.match(source, /jobs list --pending-notifications --json/);
    assert.match(source, /jobs acknowledge --job/);
    assert.match(source, /--execution-mode/);
  }

  const workerAgent = fs.readFileSync(path.join(pluginRoot, "agents/pi-worker.md"), "utf8");
  assert.match(workerAgent, /jobs wait --job/);
  assert.match(workerAgent, /jobs acknowledge --job/);

  const configure = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-code-plugin-configure/SKILL.md"),
    "utf8",
  );
  assert.match(configure, /pi-runner\.mjs" configure --host "\$HOST"/);
  assert.match(configure, /model\.json/);
  assert.match(configure, /Never ask the user to paste an API key/i);
  assert.doesNotMatch(configure, /Ask for a replacement project goal/i);

  const project = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-code-plugin-project/SKILL.md"),
    "utf8",
  );
  assert.match(project, /configure --host "\$HOST" --section project/);
  assert.match(project, /safe to run repeatedly/i);
  assert.equal(fs.existsSync(path.join(pluginRoot, "commands/project.md")), true);
  const initCommand = fs.readFileSync(path.join(pluginRoot, "commands/init.md"), "utf8");
  assert.doesNotMatch(initCommand, /Ask for replacement project goal/i);

  const pluginPackage = readJson("plugins/swarm-pi-code-plugin/package.json") as {
    dependencies: Record<string, string>;
  };
  assert.equal(pluginPackage.dependencies["@earendil-works/pi-coding-agent"], "0.80.6");

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
