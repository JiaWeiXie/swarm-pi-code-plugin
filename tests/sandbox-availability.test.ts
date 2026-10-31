import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

import { detectSandboxAvailability } from "../src/sandbox/availability.js";

const missingUnixFilter = "seccomp not available - unix socket access not restricted";

function sandboxDependencies(
  t: TestContext,
  platform: NodeJS.Platform,
  errors: string[] = [],
  warnings: string[] = [],
): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  t.mock.method(SandboxManager, "isSupportedPlatform", () => true);
  t.mock.method(SandboxManager, "checkDependencies", () => ({ errors, warnings }));
}

test("Linux sandbox is unavailable when its required Unix-socket filter helper is missing", (t) => {
  sandboxDependencies(t, "linux", [], [missingUnixFilter]);

  const availability = detectSandboxAvailability();

  assert.equal(availability.available, false);
  assert.equal(availability.backend, "linux-bubblewrap");
  assert.match(availability.reason!, /Unix-socket filter helper is unavailable/);
  assert.deepEqual(availability.warnings, [missingUnixFilter]);
});

test("missing Unix-socket filter and ordinary dependency errors are both reported", (t) => {
  const errors = ["socat not installed"];
  const warnings = [missingUnixFilter];
  sandboxDependencies(t, "linux", errors, warnings);

  const availability = detectSandboxAvailability();

  assert.equal(availability.available, false);
  assert.match(availability.reason!, /socat not installed/);
  assert.match(availability.reason!, /Unix-socket filter helper is unavailable/);
  assert.deepEqual(errors, ["socat not installed"], "runtime error input must not be changed");
  assert.deepEqual(warnings, [missingUnixFilter]);
});

test("Linux sandbox remains available with all required dependencies", (t) => {
  sandboxDependencies(t, "linux");

  const availability = detectSandboxAvailability();

  assert.equal(availability.available, true);
  assert.equal(availability.reason, null);
});

test("unrelated runtime warnings do not make the sandbox unavailable", (t) => {
  sandboxDependencies(t, "linux", [], ["unrelated runtime advisory"]);

  const availability = detectSandboxAvailability();

  assert.equal(availability.available, true);
  assert.equal(availability.reason, null);
  assert.deepEqual(availability.warnings, ["unrelated runtime advisory"]);
});

test("ordinary dependency errors still make the sandbox unavailable", (t) => {
  sandboxDependencies(t, "linux", ["bubblewrap (bwrap) not installed"]);

  const availability = detectSandboxAvailability();

  assert.equal(availability.available, false);
  assert.match(availability.reason!, /bubblewrap \(bwrap\) not installed/);
});

test("macOS sandbox availability does not require the Linux helper", (t) => {
  sandboxDependencies(t, "darwin");

  const availability = detectSandboxAvailability();

  assert.equal(availability.available, true);
  assert.equal(availability.backend, "macos-seatbelt");
});

test("unsupported platforms still refuse sandbox availability before dependency checks", (t) => {
  sandboxDependencies(t, "win32");
  t.mock.method(SandboxManager, "isSupportedPlatform", () => false);
  const check = t.mock.method(SandboxManager, "checkDependencies", () => {
    throw new Error("unsupported platforms must not check dependencies");
  });

  assert.equal(detectSandboxAvailability().available, false);
  assert.equal(check.mock.callCount(), 0);
});
