import type { Host, TaskKind } from "../core/contracts.js";

const HOST_CONTEXT: Record<Host, string> = {
  claude: "You are a delegated Pi worker running under Claude Code.",
  codex: "You are a delegated Pi worker running under Codex CLI.",
};

const TASK_CONTEXT: Record<TaskKind, string> = {
  ask: "Answer the question from repository evidence. Cite file paths and line numbers when useful.",
  review:
    "Follow the selected review profile in the request. Standard reviews find concrete bugs, security issues, regressions, and missing tests; lean reviews are read-only, behavior-preserving simplification audits. Lead with findings.",
  plan: "Produce an implementation-ready plan grounded in the current repository.",
  implement:
    "Implement the requested change directly. Do not commit, push, or modify files outside the worktree.",
  orchestrate:
    "Analyze only your assigned perspective and return concise evidence for the host to synthesize.",
  scaffold:
    "Create the approved project scaffold in the assigned staging repository. Do not commit, push, or write outside staging.",
  setup:
    "Configure project-local dependencies and development tooling. Never install globally or modify host configuration.",
  discover:
    "Coordinate schema-gated research, an isolated reproducible experiment child, and evidence-backed convergence; keep experiment artifacts non-materializing and require both Human Decision gates.",
};

export const WORKER_PROMPT_VERSION = 2;

export function buildWorkerPrompt(options: {
  host: Host;
  kind: TaskKind;
  prompt: string;
  projectGoal?: string | undefined;
  renderedProjectPolicy?: string | undefined;
  perspective?: string | undefined;
  decisionMode?: "cost" | "balance" | "power";
  advisorEnabled?: boolean;
}): string {
  const projectLines = [
    options.projectGoal ? `Project goal: ${options.projectGoal}` : "",
    options.renderedProjectPolicy ? options.renderedProjectPolicy : "",
  ].filter(Boolean);
  return [
    `[PROMPT]\nversion=${WORKER_PROMPT_VERSION}`,
    `[HOST]\n${HOST_CONTEXT[options.host]}`,
    `[TASK]\n${TASK_CONTEXT[options.kind]}`,
    options.perspective ? `[PERSPECTIVE]\n${options.perspective}` : "",
    options.decisionMode ? `[DECISION_MODE]\n${options.decisionMode}` : "",
    options.advisorEnabled
      ? "[ADVISOR]\nUse bounded consultation only; do not execute actions or recurse."
      : "",
    projectLines.length ? `[PROJECT]\n${projectLines.join("\n")}` : "",
    `[REQUEST]\n${options.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
