import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const hookPath = path.join(repoRoot, "plugins/swarm-pi-code-plugin/scripts/host-notifications.mjs");

test("plugin hooks configure only synchronous SessionStart recovery", () => {
  const hooksPath = path.join(repoRoot, "plugins/swarm-pi-code-plugin/hooks/hooks.json");
  const config = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.deepEqual(Object.keys(config.hooks), ["SessionStart"]);
  const hook = config.hooks.SessionStart[0].hooks[0];
  assert.equal(hook.type, "command");
  assert.match(hook.command, /host-notifications\.mjs/);
  assert.equal(hook.timeout, 10);
});

function runHook(events: string[], options: { exitCode?: number; hookInput?: object } = {}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "swarm-pi-hook-"));
  try {
    mkdirSync(path.join(tempRoot, "scripts"));
    writeFileSync(
      path.join(tempRoot, "scripts", "pi-runner.mjs"),
      `
const events = ${JSON.stringify(events)};
for (const event of events) process.stdout.write(event + "\\n");
process.exit(${options.exitCode ?? 0});
`,
      "utf8",
    );
    writeFileSync(path.join(tempRoot, "package.json"), '{"type":"module"}\n', "utf8");
    const output = execFileSync(
      process.execPath,
      [hookPath],
      {
        cwd: tempRoot,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: tempRoot,
          PLUGIN_ROOT: tempRoot,
        },
        input: JSON.stringify(options.hookInput ?? { cwd: tempRoot, hook_event_name: "SessionStart" }),
        encoding: "utf8",
      },
    );
    return { output, tempRoot };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function event(event: Record<string, unknown>) {
  return JSON.stringify({ schema: "swarm-pi-code-plugin/job-event", version: 1, eventId: "event-1", emittedAt: "2026-07-12T00:00:00.000Z", ...event });
}

test("SessionStart hook renders allowlisted Job events as host context without deciding", () => {
  const { output } = runHook([
    JSON.stringify({ event: "diagnostic", secret: "should-not-appear" }),
    event({
      event: "approval-required",
      jobId: "job-123",
      approvalId: "approval-456",
      toolName: "shell",
      actionSummary: "run tests in /Users/alice/project and /opt/private/build token=sk-super-secret-value-123456789",
      risk: "high",
      capabilities: ["mutation", "shell"],
      reason: "Host must decide",
      expiresAt: "2026-07-12T01:00:00.000Z",
    }),
    event({
      event: "host-assistance-required",
      jobId: "job-123",
      requestId: "request-789",
      contextClass: "docs",
      safeSummary: "docs context requested (public)",
      expiresAt: "2026-07-12T01:00:00.000Z",
    }),
    event({
      event: "job-terminal",
      jobId: "job-123",
      status: "failed",
      finishedAt: "2026-07-12T00:01:00.000Z",
    }),
  ]);

  const parsed = JSON.parse(output);
  const context = parsed.hookSpecificOutput.additionalContext as string;
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context, /approval-required job=job-123 approval=approval-456/);
  assert.match(context, /job-terminal job=job-123 status=failed/);
  assert.match(context, /host-assistance-required job=job-123 request=request-789/);
  assert.match(context, /No approval or acknowledgement was performed/);
  assert.doesNotMatch(context, /sk-super-secret-value/);
  assert.doesNotMatch(context, /\/Users\/alice\/project/);
  assert.doesNotMatch(context, /\/opt\/private\/build/);
});

test("SessionStart hook emits no context for a clean watch replay", () => {
  const { output } = runHook([event({ event: "watch-ready", replayCount: 0 })]);
  assert.equal(output, "");
});

test("SessionStart hook fails safe with a generic, non-sensitive message", () => {
  const { output, tempRoot } = runHook([], { exitCode: 2 });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.systemMessage, /could not refresh Job notifications/i);
  assert.doesNotMatch(output, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
});
