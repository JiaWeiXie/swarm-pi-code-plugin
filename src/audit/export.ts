import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ApprovalRequest,
  AuditApproval,
  AuditJobSummary,
  AuditLease,
  AuditPolicyEvent,
  AuditRequestSummary,
  AuditResultSummary,
  JobAuditExportV1,
  JobStatus,
  PolicySnapshot,
  WorkerResult,
} from "../core/contracts.js";
import { policySnapshotHash } from "../orchestration/roles.js";
import {
  getJob,
  jobDirectory,
  listJobHostRequests,
  modelConfigurationSnapshotHash,
  readJobRequest,
} from "../state/jobs.js";
import type { JobRequest } from "../state/jobs.js";
import { resolveStateDir } from "../state/state.js";
import type { JobRecord } from "../state/state.js";

const MAX_AUDIT_SOURCE_BYTES = 32 * 1024 * 1024;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_KEY =
  /^(?:worker|access|refresh|id)?_?(?:token|secret|secretref|password|api.?key|authorization|cookie|credential|private.?key)$/i;
const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+/gi,
  /\bBasic\s+[A-Za-z0-9+/=]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{20,}|ya29\.[A-Za-z0-9._-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,}|lin_[A-Za-z0-9]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /(?:access|refresh|id)_?token\s*[:=]\s*\S+/gi,
];
const URL_USERINFO_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[redacted\]@)[^\s/@:]+(?::[^\s/@]*)?@/gi;

interface RedactionRoots {
  workspace: string[];
  state: string[];
  home: string[];
  temp: string[];
}

interface RedactionCounter {
  secrets: number;
  paths: number;
}

interface AuditSources {
  request: string;
  result: string;
  prompt: string;
  policyEvents: string | null;
  patch: string | null;
}

export async function exportJobAudit(cwd: string, jobId: string): Promise<JobAuditExportV1> {
  assertSafeJobId(jobId);
  const snapshot = await getJob(cwd, jobId);
  if (!isTerminalStatus(snapshot.job.status)) {
    throw new Error(`Job is not terminal: ${jobId}`);
  }
  if (!snapshot.result) throw new Error(`Job has no result artifact: ${jobId}`);

  const directory = await jobDirectory(cwd, jobId);
  const stateDirectory = await resolveStateDir(cwd);
  const roots = await redactionRoots(cwd, stateDirectory);
  const sources = await readSources(directory);
  const counter: RedactionCounter = { secrets: 0, paths: 0 };
  const request = await readJobRequest(cwd, jobId);
  const providerVerified = verifyProviderSnapshot(request);
  const policyVerified = verifyPolicySnapshot(request.policySnapshot);
  const events = parsePolicyEvents(sources.policyEvents, roots, counter);
  const hostAssistance = await listJobHostRequests(cwd, jobId);
  if (
    policyVerified &&
    events.some((event) => event.policyHash && event.policyHash !== policyVerified.hash)
  ) {
    throw new Error("Audit export failed policy event integrity validation.");
  }

  const exported: JobAuditExportV1 = {
    schema: "swarm-pi-code-plugin/job-audit",
    version: 1,
    exportedAt: new Date().toISOString(),
    job: summarizeJob(snapshot.job, roots, counter),
    request: summarizeRequest(request, roots, counter),
    policy: {
      snapshot: request.policySnapshot
        ? (redactValue(request.policySnapshot, roots, counter) as PolicySnapshot)
        : null,
      events,
    },
    approvals: (snapshot.job.approvals ?? []).map((approval) =>
      summarizeApproval(approval, roots, counter),
    ),
    leases: (snapshot.job.leases ?? []).map(
      (lease) => redactValue(lease, roots, counter) as AuditLease,
    ),
    hostAssistance: hostAssistance.map(
      (record) => redactValue(record, roots, counter) as (typeof hostAssistance)[number],
    ),
    result: summarizeResult(snapshot.result, roots, counter),
    changes: {
      patch: sources.patch === null ? null : redactString(sources.patch, roots, counter),
      sourceSha256: sources.patch === null ? null : sha256(sources.patch),
    },
    integrity: {
      policySnapshot: policyVerified,
      providerSnapshot: providerVerified,
      sourceSha256: {
        request: sha256(sources.request),
        result: sha256(sources.result),
        prompt: sha256(sources.prompt),
        policyEvents: sources.policyEvents === null ? null : sha256(sources.policyEvents),
      },
    },
    redactions: counter,
  };

  assertSafeExport(JSON.stringify(exported), request, roots);
  return exported;
}

function assertSafeJobId(jobId: string): void {
  if (!SAFE_JOB_ID.test(jobId) || jobId.includes(".."))
    throw new Error("Invalid job id for audit export.");
}

function isTerminalStatus(status: JobStatus | string): boolean {
  return ["succeeded", "failed", "cancelled", "timed-out", "orphaned", "not-implemented"].includes(
    status,
  );
}

async function readSources(directory: string): Promise<AuditSources> {
  let total = 0;
  const readRequired = async (name: string): Promise<string> => {
    const file = path.join(directory, name);
    const value = await readLimited(file, false);
    if (value === null) throw new Error(`Missing audit source: ${name}`);
    total += Buffer.byteLength(value);
    if (total > MAX_AUDIT_SOURCE_BYTES)
      throw new Error("Audit export exceeds the source size limit.");
    return value;
  };
  const readOptional = async (name: string): Promise<string | null> => {
    const file = path.join(directory, name);
    const value = await readLimited(file, true);
    if (value !== null) {
      total += Buffer.byteLength(value);
      if (total > MAX_AUDIT_SOURCE_BYTES)
        throw new Error("Audit export exceeds the source size limit.");
    }
    return value;
  };
  return {
    request: await readRequired("request.json"),
    result: await readRequired("result.json"),
    prompt: await readRequired("prompt.md"),
    policyEvents: await readOptional("policy-events.jsonl"),
    patch: await readOptional("changes.patch"),
  };
}

async function readLimited(file: string, optional: boolean): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_AUDIT_SOURCE_BYTES) throw new Error("Audit source exceeds the size limit.");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function redactionRoots(cwd: string, state: string): Promise<RedactionRoots> {
  return {
    workspace: await pathAliases(cwd),
    state: await pathAliases(state),
    home: await pathAliases(process.env.HOME ?? "~"),
    temp: await pathAliases(requireTempRoot()),
  };
}

function requireTempRoot(): string {
  return process.env.TMPDIR ?? "/tmp";
}

async function pathAliases(value: string): Promise<string[]> {
  const resolved = path.resolve(value);
  const canonical = await fs.realpath(value).catch(() => resolved);
  return [...new Set([resolved, canonical])];
}

function summarizeJob(
  job: JobRecord,
  roots: RedactionRoots,
  counter: RedactionCounter,
): AuditJobSummary {
  const value: AuditJobSummary = {
    id: job.id,
    status: job.status,
    ...(job.host ? { host: job.host } : {}),
    ...(job.kind ? { kind: job.kind } : {}),
    ...(job.executionMode ? { executionMode: job.executionMode } : {}),
    ...(job.sandboxMode ? { sandboxMode: job.sandboxMode } : {}),
    ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
    ...(job.model ? { model: job.model } : {}),
    ...(job.role ? { role: job.role } : {}),
    ...(job.generation !== undefined ? { generation: job.generation } : {}),
    ...(job.phase ? { phase: job.phase } : {}),
    ...(job.createdAt ? { createdAt: job.createdAt } : {}),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.updatedAt ? { updatedAt: job.updatedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.lastProgressAt ? { lastProgressAt: job.lastProgressAt } : {}),
  };
  return redactValue(value, roots, counter) as AuditJobSummary;
}

function summarizeRequest(
  request: JobRequest,
  roots: RedactionRoots,
  counter: RedactionCounter,
): AuditRequestSummary {
  const value: AuditRequestSummary = {
    ...(request.requestVersion ? { requestVersion: request.requestVersion } : {}),
    id: request.id,
    host: request.host,
    kind: request.kind,
    executionMode: request.executionMode,
    ...(request.sandboxMode ? { sandboxMode: request.sandboxMode } : {}),
    timeoutMs: request.timeoutMs,
    ...(request.model ? { model: request.model } : {}),
    ...(request.role ? { role: request.role } : {}),
    ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
    ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}),
    ...(request.workspaceStrategy ? { workspaceStrategy: request.workspaceStrategy } : {}),
    ...(request.target ? { target: request.target } : {}),
    ...(request.adoptExisting ? { adoptExisting: true } : {}),
    ...(request.providerSnapshotHash ? { providerSnapshotHash: request.providerSnapshotHash } : {}),
    createdAt: request.createdAt,
  };
  return redactValue(value, roots, counter) as AuditRequestSummary;
}

function summarizeApproval(
  approval: ApprovalRequest,
  roots: RedactionRoots,
  counter: RedactionCounter,
): AuditApproval {
  const value = {
    id: approval.id,
    jobId: approval.jobId,
    generation: approval.generation,
    actionFingerprint: approval.actionFingerprint,
    ...(approval.scopeHash ? { scopeHash: approval.scopeHash } : {}),
    toolName: approval.toolName,
    actionSummary: approval.actionSummary,
    ...(approval.trustedReadOnly ? { trustedReadOnly: true } : {}),
    ...(approval.effectAssessment ? { effectAssessment: approval.effectAssessment } : {}),
    decision: approval.decision,
    status: approval.status,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {}),
    ...(approval.scope ? { scope: approval.scope } : {}),
    ...(approval.workerAssessment ? { workerAssessment: approval.workerAssessment } : {}),
    ...(approval.adjudication ? { adjudication: approval.adjudication } : {}),
  };
  return redactValue(value, roots, counter) as AuditApproval;
}

function summarizeResult(
  result: WorkerResult,
  roots: RedactionRoots,
  counter: RedactionCounter,
): AuditResultSummary {
  const value: AuditResultSummary = {
    kind: result.kind,
    status: result.status,
    success: result.success,
    model: result.model,
    changedFiles: result.changedFiles,
    diffStat: result.diffStat,
    ...(result.runtimeSideEffects ? { runtimeSideEffects: result.runtimeSideEffects } : {}),
    verification: result.verification,
    ...(result.host ? { host: result.host } : {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(result.attempts !== undefined ? { attempts: result.attempts } : {}),
    ...(result.fallbackUsed !== undefined ? { fallbackUsed: result.fallbackUsed } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.role ? { role: result.role } : {}),
    ...(result.requestedThinkingLevel
      ? { requestedThinkingLevel: result.requestedThinkingLevel }
      : {}),
    ...(result.effectiveThinkingLevel
      ? { effectiveThinkingLevel: result.effectiveThinkingLevel }
      : {}),
    ...(result.orchestrationTrace ? { orchestrationTrace: result.orchestrationTrace } : {}),
    ...(result.policySummary ? { policySummary: result.policySummary } : {}),
    ...(result.agentVerification
      ? {
          agentVerification: {
            status: result.agentVerification.status,
            output: result.agentVerification.output.slice(0, 16_384),
            model: result.agentVerification.model,
          },
        }
      : {}),
    ...(result.artifact ? { artifact: result.artifact } : {}),
    ...(result.hostAdjudications ? { hostAdjudications: result.hostAdjudications } : {}),
  };
  return redactValue(value, roots, counter) as AuditResultSummary;
}

function parsePolicyEvents(
  raw: string | null,
  roots: RedactionRoots,
  counter: RedactionCounter,
): AuditPolicyEvent[] {
  if (raw === null || raw.trim() === "") return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error("Audit policy events contain malformed JSON.");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Audit policy events contain an invalid record.");
      }
      const record = value as Record<string, unknown>;
      const allowed = Object.fromEntries(
        [
          "timestamp",
          "tool",
          "fingerprint",
          "decision",
          "risk",
          "reason",
          "action",
          "classifierCache",
          "classifierEvidence",
          "model",
          "policyHash",
        ]
          .filter((key) => key in record)
          .map((key) => [key, record[key]]),
      );
      return redactValue(allowed, roots, counter) as AuditPolicyEvent;
    });
}

function verifyProviderSnapshot(request: JobRequest): { hash: string; verified: true } | null {
  if (!request.providerSnapshotHash || !request.modelConfiguration) return null;
  if (modelConfigurationSnapshotHash(request.modelConfiguration) !== request.providerSnapshotHash) {
    throw new Error("Audit export failed provider snapshot integrity validation.");
  }
  return { hash: request.providerSnapshotHash, verified: true };
}

function verifyPolicySnapshot(
  snapshot: PolicySnapshot | undefined,
): { hash: string; verified: true } | null {
  if (!snapshot) return null;
  if (policySnapshotHash(snapshot) !== snapshot.hash) {
    throw new Error("Audit export failed policy snapshot integrity validation.");
  }
  return { hash: snapshot.hash, verified: true };
}

function redactValue(
  value: unknown,
  roots: RedactionRoots,
  counter: RedactionCounter,
  key?: string,
): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    counter.secrets += 1;
    return "[redacted]";
  }
  if (typeof value === "string") return redactString(value, roots, counter);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, roots, counter));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, roots, counter, entryKey),
    ]),
  );
}

function redactString(value: string, roots: RedactionRoots, counter: RedactionCounter): string {
  let output = value;
  for (const [root, replacement] of [
    ...roots.workspace.map((value) => [value, "$WORKSPACE"] as const),
    ...roots.state.map((value) => [value, "$STATE"] as const),
    ...roots.home.map((value) => [value, "$HOME"] as const),
    ...roots.temp.map((value) => [value, "$TMP"] as const),
  ].sort(([left], [right]) => right.length - left.length)) {
    if (!root || root === "/") continue;
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[\\s:'"=])${escaped}(?=($|[/\\\\\\s:'"]))`, "g");
    output = output.replace(pattern, (_match, prefix: string) => {
      counter.paths += 1;
      return `${prefix}${replacement}`;
    });
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, () => {
      counter.secrets += 1;
      return "[redacted]";
    });
  }
  output = output.replace(URL_USERINFO_PATTERN, (_match, protocol: string) => {
    counter.secrets += 1;
    return `${protocol}[redacted]@`;
  });
  return output;
}

function assertSafeExport(serialized: string, request: JobRequest, roots: RedactionRoots): void {
  if (serialized.includes(request.workerToken))
    throw new Error("Audit export failed secret redaction validation.");
  for (const root of Object.values(roots).flat()) {
    if (root !== "/" && serialized.includes(root))
      throw new Error("Audit export failed path redaction validation.");
  }
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(serialized))
      throw new Error("Audit export failed secret redaction validation.");
  }
  URL_USERINFO_PATTERN.lastIndex = 0;
  if (URL_USERINFO_PATTERN.test(serialized))
    throw new Error("Audit export failed secret redaction validation.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
