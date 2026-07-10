import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("plugin bootstrap retries a partial install until a success marker exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-pi-bootstrap-"));
  const scripts = path.join(root, "scripts");
  const dependency = path.join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  const sandboxDependency = path.join(
    root,
    "node_modules",
    "@carderne",
    "sandbox-runtime",
    "package.json",
  );
  const bin = path.join(root, "bin");
  const countFile = path.join(root, "npm-count.txt");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.mkdirSync(path.dirname(sandboxDependency), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(
    path.join(process.cwd(), "plugins/swarm-pi-code-plugin/scripts/bootstrap.mjs"),
    path.join(scripts, "bootstrap.mjs"),
  );
  fs.writeFileSync(dependency, '{"name":"@earendil-works/pi-coding-agent"}\n');
  fs.writeFileSync(sandboxDependency, '{"name":"@carderne/sandbox-runtime"}\n');
  const fakeNpm = path.join(bin, "npm");
  fs.writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const countFile = process.env.SWARM_TEST_NPM_COUNT;
const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8") : "0") + 1;
fs.writeFileSync(countFile, String(count));
process.exit(process.env.SWARM_TEST_NPM_FAIL === "1" ? 1 : 0);
`,
  );
  fs.chmodSync(fakeNpm, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    SWARM_TEST_NPM_COUNT: countFile,
  };
  const bootstrapExpression = `import(${JSON.stringify(pathToFileURL(path.join(scripts, "bootstrap.mjs")).href)}).then((module) => module.ensureRuntime())`;

  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "--eval", bootstrapExpression], {
      env: { ...env, SWARM_TEST_NPM_FAIL: "1" },
      stdio: "pipe",
    }),
    (error: unknown) => (error as { status?: number }).status === 1,
  );
  assert.equal(fs.existsSync(path.join(root, "node_modules", ".swarm-pi-runtime-ready")), false);
  assert.equal(fs.readFileSync(countFile, "utf8"), "1");

  execFileSync(process.execPath, ["--input-type=module", "--eval", bootstrapExpression], {
    env,
    stdio: "pipe",
  });
  assert.equal(fs.readFileSync(countFile, "utf8"), "2");
  assert.equal(fs.readFileSync(path.join(root, "node_modules", ".swarm-pi-runtime-ready"), "utf8"), "ready\n");
});
