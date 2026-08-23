import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const repoRoot = process.cwd();

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("performance workflows stay additive and defer heavyweight CLI modules", () => {
  const packageManifest = readJson("package.json");
  const scripts = packageManifest.scripts as Record<string, string>;
  assert.match(scripts["test:state"] ?? "", /state-observer\.test\.js/);
  assert.match(scripts["test:state"] ?? "", /process-queue\.test\.js/);
  assert.match(scripts.check ?? "", /npm test/);

  const cli = fs.readFileSync(path.join(repoRoot, "src/cli.ts"), "utf8");
  assert.doesNotMatch(cli, /^import .*\.\/runner\/run\.js/m);
  assert.doesNotMatch(cli, /^import .*\.\/web\/configuration-server\.js/m);
  assert.match(cli, /await import\("\.\/runner\/run\.js"\)/);
  assert.match(cli, /await import\("\.\/web\/configuration-server\.js"\)/);
});

test("Claude and Codex manifests use the swarm-pi-code-plugin identity", () => {
  const packageManifest = readJson("package.json");
  const claude = readJson("plugins/swarm-pi-code-plugin/.claude-plugin/plugin.json");
  const codex = readJson("plugins/swarm-pi-code-plugin/.codex-plugin/plugin.json");
  const version = packageManifest.version as string;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  assert.equal(claude.name, "swarm-pi-code-plugin");
  assert.equal(codex.name, "swarm-pi-code-plugin");
  assert.equal(claude.version, version);
  assert.equal("hooks" in claude, false);
  assert.match(codex.version as string, new RegExp(`^${escapedVersion}\\+codex\\.\\d{14}$`));
  assert.equal("hooks" in codex, false);
  assert.equal(codex.skills, "./skills/");
});

test("plugin package contains both host adapters and a self-contained runner", () => {
  const pluginRoot = path.join(repoRoot, "plugins/swarm-pi-code-plugin");
  const skills = [
    "configure",
    "project",
    "ask",
    "review",
    "plan",
    "implement",
    "orchestrate",
    "discover",
    "scaffold",
    "setup",
  ];
  for (const skill of skills) {
    const file = path.join(pluginRoot, "skills", `swarm-pi-${skill}`, "SKILL.md");
    assert.equal(fs.existsSync(file), true, `missing Codex skill: ${skill}`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /Follow the \[Skill Control Loop\]/);
    assert.match(source, /Complete only when/i, `missing completion criterion: ${skill}`);
    assert.ok(source.split("\n").length <= 50, `public Skill should stay compact: ${skill}`);
    assert.equal(
      fs.existsSync(path.join(path.dirname(file), "agents/openai.yaml")),
      true,
      `missing Codex metadata: ${skill}`,
    );
    const metadata = fs.readFileSync(path.join(path.dirname(file), "agents/openai.yaml"), "utf8");
    assert.match(metadata, /display_name:/);
    assert.match(metadata, new RegExp(`\\$swarm-pi-${skill}`));
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
    assert.equal(
      fs.existsSync(path.join(pluginRoot, relative)),
      true,
      `missing plugin file: ${relative}`,
    );
  }

  const implementation = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-implement/SKILL.md"),
    "utf8",
  );
  assert.match(implementation, /explicit mutation intent/i);
  assert.match(implementation, /safe-dirty/i);
  assert.match(implementation, /isolated-snapshot/i);
  assert.match(implementation, /Host-owned\s+verification/i);
  assert.match(implementation, /--execution-mode supervised/);
  assert.match(implementation, /Background is\s+reserved[\s\S]*mechanical-executor/i);
  assert.match(implementation, /mechanical-executor/);
  assert.match(implementation, /deliverable: false/);
  assert.match(implementation, /workspace-unborn-head/);
  assert.match(implementation, /jobs materialize/);

  const orchestration = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-orchestrate/SKILL.md"),
    "utf8",
  );
  assert.match(orchestration, /EvidencePack/);
  assert.match(orchestration, /source\s+Job ID/i);
  assert.match(
    orchestration,
    /One Host-owned\s+bounded verification supplies any dynamic evidence/i,
  );
  assert.match(orchestration, /Resource-Aware Execution/i);

  for (const skill of ["implement", "setup", "scaffold", "discover"]) {
    const source = fs.readFileSync(
      path.join(pluginRoot, "skills", `swarm-pi-${skill}`, "SKILL.md"),
      "utf8",
    );
    assert.match(source, /Resource-Aware Execution/i, `missing resource pointer: ${skill}`);
  }

  for (const skill of [
    "ask",
    "configure",
    "discover",
    "implement",
    "orchestrate",
    "plan",
    "project",
    "review",
    "scaffold",
    "setup",
  ]) {
    const source = fs.readFileSync(
      path.join(pluginRoot, "skills", `swarm-pi-${skill}`, "SKILL.md"),
      "utf8",
    );
    assert.match(source, /Skill Control Loop/);
  }
  // The wrapper commands were removed: each capability is a single short-named
  // skill, invoked in Claude Code as /swarm-pi-code-plugin:swarm-pi-<name>.
  assert.equal(
    fs.existsSync(path.join(pluginRoot, "commands")),
    false,
    "commands/ should be removed",
  );
  const protocolPath = path.join(pluginRoot, "references/host-protocol.md");
  assert.equal(fs.existsSync(protocolPath), true);
  const protocol = fs.readFileSync(protocolPath, "utf8");
  assert.match(protocol, /standalone node and an internal Workflow node/i);
  assert.match(protocol, /wait-timed-out/);
  assert.match(protocol, /hard-run-limit-ms/);
  assert.match(protocol, /unresponsive-timeout/);
  assert.match(protocol, /hard-limit-exceeded/);
  assert.match(protocol, /Host Actions 0\.5 is removed/);
  assert.match(protocol, /host-actions-removed/);

  const controlLoop = fs.readFileSync(
    path.join(pluginRoot, "references/skill-control-loop.md"),
    "utf8",
  );
  assert.match(controlLoop, /one request,\s*one workflow,\s*one immutable policy snapshot/i);
  assert.match(controlLoop, /capability-specific/i);
  assert.match(controlLoop, /wait-timeout-ms 15000/);
  assert.match(controlLoop, /terminal result shown to the user/i);

  const resourceExecution = fs.readFileSync(
    path.join(pluginRoot, "references/resource-aware-execution.md"),
    "utf8",
  );
  assert.match(resourceExecution, /smallest relevant target/i);
  assert.match(resourceExecution, /Run expensive stages sequentially/i);
  assert.match(
    resourceExecution,
    /grants no capability, lease, approval, or\s+delivery authority/i,
  );

  for (const skill of ["implement", "setup", "scaffold"]) {
    const source = fs.readFileSync(
      path.join(pluginRoot, "skills", `swarm-pi-${skill}`, "SKILL.md"),
      "utf8",
    );
    assert.match(source, /reversible/i);
    assert.match(source, /Skill Control Loop/);
  }
  for (const skill of ["ask", "review", "plan", "orchestrate"]) {
    const source = fs.readFileSync(
      path.join(pluginRoot, "skills", `swarm-pi-${skill}`, "SKILL.md"),
      "utf8",
    );
    assert.match(source, /Skill Control Loop/);
    assert.match(source, /active Host/i);
  }
  const discover = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-discover/SKILL.md"),
    "utf8",
  );
  assert.match(discover, /immutable Job policy/i);
  assert.match(discover, /shared Adaptive network authorizer/i);
  assert.match(discover, /stage Sandboxes/i);

  const workerAgent = fs.readFileSync(path.join(pluginRoot, "agents/pi-worker.md"), "utf8");
  assert.match(workerAgent, /swarm-pi-orchestrate/);
  assert.match(workerAgent, /compact control loop/i);

  const configure = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-configure/SKILL.md"),
    "utf8",
  );
  assert.match(configure, /\$RUNNER configure --host "\$HOST"/);
  assert.match(configure, /model file/i);
  assert.match(configure, /Credentials stay inside the setup UI/i);
  assert.match(configure, /outer sandbox/i);
  assert.match(configure, /State storage write boundary/);
  assert.doesNotMatch(configure, /Ask for a replacement project goal/i);

  const project = fs.readFileSync(
    path.join(pluginRoot, "skills/swarm-pi-project/SKILL.md"),
    "utf8",
  );
  assert.match(project, /\$RUNNER configure --host "\$HOST" --section project/);
  assert.match(project, /repeatable workflow/i);
  // The init command's --reset/--json routing folded into the configure skill.
  assert.match(configure, /--reset/);
  assert.match(configure, /exactly `--json`/);

  const pluginPackage = readJson("plugins/swarm-pi-code-plugin/package.json") as {
    dependencies: Record<string, string>;
  };
  assert.equal(pluginPackage.dependencies["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.equal(pluginPackage.dependencies["@earendil-works/pi-ai"], "0.84.2");
  assert.equal(pluginPackage.dependencies["@carderne/sandbox-runtime"], "0.0.49");

  execFileSync(process.execPath, ["--check", path.join(pluginRoot, "scripts/bootstrap.mjs")]);
  execFileSync(process.execPath, ["--check", path.join(pluginRoot, "scripts/pi-runner.mjs")]);
});

test("repo marketplaces point at the shared plugin root", () => {
  const packageManifest = readJson("package.json");
  const version = packageManifest.version as string;
  const claude = readJson(".claude-plugin/marketplace.json") as {
    name: string;
    metadata: { version: string };
    plugins: Array<{ name: string; source: string; version: string }>;
  };
  const codex = readJson(".agents/plugins/marketplace.json") as {
    name: string;
    plugins: Array<{ name: string; source: { path: string } }>;
  };

  assert.equal(claude.name, "swarm-pi-code-plugin");
  assert.equal(claude.plugins[0]?.name, "swarm-pi-code-plugin");
  assert.equal(claude.plugins[0]?.source, "./plugins/swarm-pi-code-plugin");
  assert.equal(claude.metadata.version, version);
  assert.equal(claude.plugins[0]?.version, version);
  assert.equal(codex.name, "swarm-pi-code-plugin-local");
  assert.equal(codex.plugins[0]?.name, "swarm-pi-code-plugin");
  assert.equal(codex.plugins[0]?.source.path, "./plugins/swarm-pi-code-plugin");
});
