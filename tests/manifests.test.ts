import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
const repoRoot = process.cwd();

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

test("Claude and Codex manifests use the swarm-pi-code identity", () => {
  const claude = readJson("plugins/swarm-pi-code/.claude-plugin/plugin.json");
  const codex = readJson("plugins/swarm-pi-code/.codex-plugin/plugin.json");

  assert.equal(claude.name, "swarm-pi-code");
  assert.equal(codex.name, "swarm-pi-code");
  assert.equal(claude.version, "0.1.0");
  assert.equal(codex.version, "0.1.0");
});

test("repo marketplaces point at the shared plugin root", () => {
  const claude = readJson(".claude-plugin/marketplace.json") as { plugins: Array<{ source: string }> };
  const codex = readJson(".agents/plugins/marketplace.json") as {
    plugins: Array<{ source: { path: string } }>;
  };

  assert.equal(claude.plugins[0]?.source, "./plugins/swarm-pi-code");
  assert.equal(codex.plugins[0]?.source.path, "./plugins/swarm-pi-code");
});
