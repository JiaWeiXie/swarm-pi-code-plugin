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
    "git branch --show-current",
    "git tag --list 'v*'",
    "git worktree list --porcelain",
    "git remote -v",
    "git check-ignore -v generated.log || true",
    "git diff -- README.md | grep -E 'sudo|rm -rf|git push'",
    "git log -n 5; git status --short",
    "git status --short || printf '%s\\n' 'status unavailable'",
    "git status --short\ngit branch --show-current",
    "printf '%s\\n' 'literal; separator' '$HOME'",
    "test -d node_modules && node --version && npm --version",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
});

test("read-only shell classification fails closed on mutation, expansion, egress, or escape", () => {
  for (const command of [
    "git status && rm -rf .",
    "git status > /tmp/status",
    "git status $(touch owned)",
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
    "git branch new-branch",
    "git diff --output=patch README.md",
    "printf '%s\\n' \"$(touch owned)\"",
    "printf '%s\\n' `touch owned`",
    "python3 <<'PY'\nprint('.env')\nPY",
    'for file in README.md; do cat "$file"; done',
  ]) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});
