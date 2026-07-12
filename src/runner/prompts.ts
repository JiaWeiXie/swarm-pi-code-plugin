import type { Host, TaskKind } from "../core/contracts.js";
import type { SwarmProfile } from "../state/state.js";

const HOST_CONTEXT: Record<Host, string> = {
  claude: "You are a delegated Pi worker running under Claude Code.",
  codex: "You are a delegated Pi worker running under Codex CLI.",
};

const TASK_CONTEXT: Record<TaskKind, string> = {
  ask: "Answer the question from repository evidence. Cite file paths and line numbers when useful.",
  review: "Review for concrete bugs, security issues, regressions, and missing tests. Lead with findings.",
  plan: "Produce an implementation-ready plan grounded in the current repository.",
  implement: "Implement the requested change directly. Do not commit, push, or modify files outside the worktree.",
  orchestrate: "Analyze only your assigned perspective and return concise evidence for the host to synthesize.",
  scaffold: "Create the approved project scaffold in the assigned staging repository. Do not commit, push, or write outside staging.",
  setup: "Configure project-local dependencies and development tooling. Never install globally or modify host configuration.",
};

export const WORKER_PROMPT_VERSION = 1;

export function buildWorkerPrompt(options: {
  host: Host;
  kind: TaskKind;
  prompt: string;
  profile?: SwarmProfile | undefined;
  perspective?: string | undefined;
}): string {
  const profileLines = [
    options.profile?.goal ? `Project goal: ${options.profile.goal}` : "",
    options.profile?.dirs?.length ? `Directories in scope: ${options.profile.dirs.join(", ")}` : "",
  ].filter(Boolean);
  return [
    `[PROMPT]\nversion=${WORKER_PROMPT_VERSION}`,
    `[HOST]\n${HOST_CONTEXT[options.host]}`,
    `[TASK]\n${TASK_CONTEXT[options.kind]}`,
    options.perspective ? `[PERSPECTIVE]\n${options.perspective}` : "",
    profileLines.length ? `[PROJECT]\n${profileLines.join("\n")}` : "",
    `[REQUEST]\n${options.prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
