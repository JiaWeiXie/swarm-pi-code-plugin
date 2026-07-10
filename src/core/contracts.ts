export type Host = "claude" | "codex";

export type TaskKind = "ask" | "review" | "plan" | "implement" | "orchestrate";

export type WorkerMode = "readonly" | "implement";

export type ExecutionMode = "supervised" | "background";

export type SandboxMode = "strict" | "lenient";

export type WorkerStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "orphaned"
  | "not-implemented";

export type JobStatus = "queued" | "running" | WorkerStatus;

export type NotificationStatus = "pending" | "acknowledged";

export interface WorkerRequest {
  host: Host;
  kind: TaskKind;
  cwd: string;
  prompt: string;
  mode: WorkerMode;
  executionMode: ExecutionMode;
  sandboxMode: SandboxMode;
  timeoutMs: number;
  model?: string;
}

export interface WorkerResult {
  kind: TaskKind;
  status: WorkerStatus;
  success: boolean;
  output: string;
  model: string | null;
  changedFiles: string[];
  diffStat: string;
  runtimeSideEffects?: string[];
  verification: {
    status: "not-run" | "passed" | "failed";
    commands: string[];
  };
  host?: Host;
  jobId?: string;
  attempts?: number;
  fallbackUsed?: boolean;
  error?: string | null;
}

export interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  name: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  ready: boolean;
  modelCount: number;
  availableModelCount: number;
  auth: {
    source: string | null;
    label: string | null;
  };
  selection: "primary" | "fallback" | null;
  custom: boolean;
}
