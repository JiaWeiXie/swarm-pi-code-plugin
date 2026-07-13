import assert from "node:assert/strict";
import test from "node:test";

import { isReadOnlyShellCommand } from "../src/policy/read-only-shell.js";

test("read-only shell classification accepts a narrow composable inspection grammar", () => {
  for (const command of [
    "git status --short --branch && git ls-files",
    "pwd",
    "find . -maxdepth 3 -type f | head -80",
    "rg -n Host-first README.md | head -20",
    "sed -n '1,80p' docs/SPEC.md",
    "sha256sum Cargo.lock crates/evobox-publisherd/config.example.toml",
    "shasum -a 256 Cargo.lock",
    "rustc --version",
    "cargo -Vv",
    "cmp -s generated.json contract.json",
    "diff -u contract.json generated.json",
    "/bin/ls -la .",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
});

test("read-only shell classification fails closed on mutation, expansion, egress, or escape", () => {
  for (const command of [
    "git status && rm -rf .",
    "git status > /tmp/status",
    "git status $(touch owned)",
    "git status || echo fallback",
    "git status &",
    "git status\nrm -rf .",
    "find . -delete",
    "find . -exec rm {} +",
    "sed -i '' docs/SPEC.md",
    "sed -n '1w /tmp/copied' docs/SPEC.md",
    "rg --pre 'rm -rf .' pattern .",
    "fd -x rm {}",
    "sort -o sorted.txt input.txt",
    "tree -o tree.txt .",
    "file --compile custom.magic",
    "sha256sum ../private.txt",
    "shasum -a 256 /etc/passwd",
    "cargo test",
    "rustc source.rs",
    "cmp -s ../private.txt generated.json",
    "diff --output=patch contract.json generated.json",
    "diff contract.json /etc/passwd",
    "cat ../private.txt",
    "cat /etc/passwd",
    "curl https://example.com",
    "git -c alias.status='!rm -rf .' status",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});
