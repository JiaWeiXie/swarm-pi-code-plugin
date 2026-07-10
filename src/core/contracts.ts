export type Host = "claude" | "codex";

export type TaskKind = "ask" | "review" | "plan" | "implement" | "orchestrate";

export type WorkerMode = "readonly" | "implement";

export type WorkerStatus = "succeeded" | "failed" | "not-implemented";

export interface WorkerRequest {
  host: Host;
  kind: TaskKind;
  cwd: string;
  prompt: string;
  mode: WorkerMode;
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
  verification: {
    status: "not-run" | "passed" | "failed";
    commands: string[];
  };
}

export interface AvailableModel {
  id: string;
  provider: string;
  model: string;
  name: string;
}
