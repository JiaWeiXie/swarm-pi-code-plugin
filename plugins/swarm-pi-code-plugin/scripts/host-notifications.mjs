#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENT_SCHEMA = "swarm-pi-code-plugin/job-event";
const EVENT_VERSION = 1;
const WATCH_TIMEOUT_MS = 8_000;
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_CONTEXT_LENGTH = 12_000;

const pluginRoot = resolvePluginRoot();
const runnerPath = path.join(pluginRoot, "scripts", "pi-runner.mjs");

const hookInput = await readHookInput();
const cwd = resolveCwd(hookInput.cwd);

try {
  const result = await runWatch({ cwd, pluginRoot, runnerPath });
  if (result.code !== 0) {
    emitFailure();
  } else {
    const events = parseEvents(result.stdout);
    const additionalContext = renderContext(events, cwd);
    if (additionalContext) emitContext(additionalContext);
  }
} catch {
  // SessionStart is a recovery aid. A broken or unavailable local state store
  // must never prevent the host from starting a session.
  emitFailure();
}

function resolvePluginRoot() {
  const configured = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT;
  if (configured) return path.resolve(configured);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function readHookInput() {
  try {
    const raw = await readFile(0, "utf8");
    if (!raw.trim()) return {};
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function resolveCwd(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return process.cwd();
  return candidate;
}

function runWatch({ cwd: workingDirectory, pluginRoot: root, runnerPath: runner }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, "jobs", "watch", "--emit", "ndjson", "--once"], {
      cwd: workingDirectory,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        PLUGIN_ROOT: root,
      },
      stdio: ["ignore", "pipe", "ignore"],
    });

    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
      finish({ code: null, stdout: "" });
    }, WATCH_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish({ code: null, stdout: "" });
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString();
    });
    child.once("error", () => finish({ code: null, stdout: "" }));
    child.once("close", (code) => finish({ code, stdout }));

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
  });
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (isJobEvent(event)) events.push(event);
    } catch {
      // Ignore non-NDJSON output. The stream is an allowlisted source and the
      // hook must remain safe even if an older runner emits diagnostics.
    }
  }
  return events;
}

function isJobEvent(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.schema === EVENT_SCHEMA &&
      value.version === EVENT_VERSION &&
      typeof value.event === "string",
  );
}

function renderContext(events, cwd) {
  const lines = [];
  const seen = new Set();
  for (const event of events) {
    const line = renderEvent(event, cwd);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length === 0) return "";

  const context = [
    "[Swarm Pi Code Plugin] Job notification recovery:",
    ...lines.map((line) => `- ${line}`),
    "No approval, denial, response, receipt, lease, or acknowledgement was performed by this hook. The active Host must inspect the full durable request before Host-first review or user fallback.",
  ].join("\n");
  const redacted = redactText(context, cwd).slice(0, MAX_CONTEXT_LENGTH);
  const serialized = JSON.stringify(redacted);
  return containsSensitive(serialized, cwd) ? "" : redacted;
}

function renderEvent(event, cwd) {
  const jobId = safeIdentifier(event.jobId);
  switch (event.event) {
    case "approval-required": {
      const approvalId = safeIdentifier(event.approvalId);
      const tool = safeText(event.toolName, cwd);
      const action = safeText(event.actionSummary, cwd);
      const risk = safeText(event.risk, cwd);
      const capabilities = safeList(event.capabilities, cwd);
      const reason = safeText(event.reason, cwd);
      const expiresAt = safeText(event.expiresAt, cwd);
      return `approval-required job=${jobId} approval=${approvalId} tool=${tool} action=${action} risk=${risk} capabilities=${capabilities} reason=${reason} expiresAt=${expiresAt}; inspect jobs approvals in the active Host`;
    }
    case "approval-resolved": {
      const approvalId = safeIdentifier(event.approvalId);
      const status = safeText(event.status, cwd);
      const resolvedAt = safeText(event.resolvedAt, cwd);
      const principal = safeText(event.principal, cwd);
      const autoResolved = safeText(event.autoResolved, cwd);
      const assessedRisk = safeText(event.assessedRisk, cwd);
      return `approval-resolved job=${jobId} approval=${approvalId} status=${status} principal=${principal} autoResolved=${autoResolved} assessedRisk=${assessedRisk} resolvedAt=${resolvedAt}; notification still requires host acknowledgement if pending`;
    }
    case "host-assistance-required": {
      const requestId = safeIdentifier(event.requestId);
      const contextClass = safeText(event.contextClass, cwd);
      const summary = safeText(event.safeSummary, cwd);
      const expiresAt = safeText(event.expiresAt, cwd);
      return `host-assistance-required job=${jobId} request=${requestId} class=${contextClass} summary=${summary} expiresAt=${expiresAt}; inspect jobs host-requests in the active Host`;
    }
    case "human-decision-required": {
      const requestId = safeIdentifier(event.requestId);
      const summary = safeText(event.safeSummary, cwd);
      const expiresAt = safeText(event.expiresAt, cwd);
      return `human-decision-required job=${jobId} request=${requestId} summary=${summary} expiresAt=${expiresAt}; inspect jobs decisions in the active Host`;
    }
    case "host-assistance-resolved":
    case "human-decision-resolved": {
      const requestId = safeIdentifier(event.requestId);
      const status = safeText(event.status, cwd);
      const resolvedAt = safeText(event.resolvedAt, cwd);
      const principal = safeText(event.principal, cwd);
      const autoResolved = safeText(event.autoResolved, cwd);
      const assessedRisk = safeText(event.assessedRisk, cwd);
      return `${event.event} job=${jobId} request=${requestId} status=${status} principal=${principal} autoResolved=${autoResolved} assessedRisk=${assessedRisk} resolvedAt=${resolvedAt}`;
    }
    case "job-progress": {
      const status = safeText(event.status, cwd);
      const phase = safeText(event.phase, cwd);
      const progress = safeText(event.progressMessage, cwd);
      const updatedAt = safeText(event.updatedAt || event.lastProgressAt, cwd);
      return `job-progress job=${jobId} status=${status} phase=${phase} progress=${progress} updatedAt=${updatedAt}`;
    }
    case "job-terminal": {
      const status = safeText(event.status, cwd);
      const finishedAt = safeText(event.finishedAt, cwd);
      return `job-terminal job=${jobId} status=${status} finishedAt=${finishedAt}`;
    }
    default:
      return "";
  }
}

function safeIdentifier(value) {
  if (typeof value !== "string") return "[unknown]";
  const trimmed = value.trim().slice(0, 128);
  return /^[A-Za-z0-9._:-]+$/u.test(trimmed) ? trimmed : "[unknown]";
}

function safeText(value, cwd) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "[unknown]";
  }
  const text = redactText(String(value), cwd).replace(/[\r\n\t]+/gu, " ").trim();
  return text ? text.slice(0, 500) : "[unknown]";
}

function safeList(value, cwd) {
  if (!Array.isArray(value)) return "[unknown]";
  const values = value
    .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    .slice(0, 16)
    .map((item) => safeText(item, cwd));
  return values.length ? values.join(",") : "[unknown]";
}

function redactText(input, cwd) {
  let value = String(input);
  const home = os.homedir();
  const tmp = os.tmpdir();
  const workspace = path.resolve(cwd);
  for (const [candidate, replacement] of [
    [workspace, "$WORKSPACE"],
    [home, "$HOME"],
    [tmp, "$TMP"],
    ["/private/tmp", "$TMP"],
    ["/tmp", "$TMP"],
  ]) {
    if (!candidate || candidate === "/") continue;
    value = value.split(candidate).join(replacement);
  }

  value = value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, "https://[REDACTED]@")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\-/]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/giu, "[REDACTED_TOKEN]")
    .replace(/\b(?:ghp_|gho_|github_pat_|xox[abprs]-|AIza|ya29\.)[A-Za-z0-9._-]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/gu, "[REDACTED_JWT]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|worker[_-]?token|password|secret|authorization|cookie|credential|private[_-]?key)\s*[:=]\s*)(["']?)[^\s,;'"`}]+/giu, "$1$2[REDACTED]")
    .replace(/\/(?:Users|home)\/[^\s"'`]+/gu, "$PATH")
    .replace(/\/private\/var\/[^\s"'`]+/gu, "$PATH")
    .replace(/\/(?:var\/folders|tmp)\/[^\s"'`]+/gu, "$PATH")
    .replace(/(^|[\s("'`=])\/(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~+\- ]*/gu, "$1$PATH");
  return value;
}

function containsSensitive(value, cwd) {
  const text = String(value);
  const workspace = path.resolve(cwd);
  const home = os.homedir();
  const tmp = os.tmpdir();
  return (
    (workspace !== "/" && text.includes(workspace)) ||
    (home !== "/" && text.includes(home)) ||
    (tmp !== "/" && text.includes(tmp)) ||
    /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/iu.test(text) ||
    /\b(?:Bearer\s+|ghp_|gho_|github_pat_|xox[abprs]-|AIza|ya29\.)[A-Za-z0-9._~+\-/]{12,}/iu.test(text) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/u.test(text) ||
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----/u.test(text) ||
    /(^|[\s("'`=])\/(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~+\- ]*/u.test(text)
  );
}

function emitContext(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    })}\n`,
  );
}

function emitFailure() {
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: "Swarm Pi Code Plugin could not refresh Job notifications; run jobs watch manually.",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Job notification recovery was unavailable. No approval or acknowledgement was performed.",
      },
    })}\n`,
  );
}
