import fs from "node:fs/promises";

import type { WorkerResult } from "../core/contracts.js";
import { captureWorktreeChanges, requireCleanWorktree } from "../git/worktree.js";
import { executeSession, type RunnableSession } from "../pi/execute.js";
import {
  createModelCatalog,
  describeModels,
  modelId,
  selectModel,
  type ModelCatalog,
  type PiModel,
} from "../pi/models.js";
import { createWorkerSession } from "../pi/runtime.js";
import type { RunnerArguments } from "./args.js";

export interface RunnerDependencies {
  catalog: ModelCatalog;
  readFile(path: string): Promise<string>;
  createSession(options: {
    cwd: string;
    mode: "readonly" | "implement";
    model: PiModel;
  }): Promise<RunnableSession>;
}

export function defaultDependencies(): RunnerDependencies {
  return {
    catalog: createModelCatalog(),
    readFile: (path) => fs.readFile(path, "utf8"),
    createSession: async (options) => {
      const { session } = await createWorkerSession(options);
      return session;
    },
  };
}

export async function runCommand(
  args: RunnerArguments,
  cwd: string,
  dependencies: RunnerDependencies = defaultDependencies(),
): Promise<{ models: ReturnType<typeof describeModels> } | WorkerResult> {
  const available = dependencies.catalog.available();
  if (args.command === "models") {
    return { models: describeModels(available) };
  }

  if (args.command === "review" || args.command === "orchestrate") {
    return failure(args.command, `${args.command} is not implemented yet.`);
  }

  const selected = selectModel(available, args.model);
  if (!selected) {
    const suffix = args.model ? `: ${args.model}` : "";
    return failure(args.command, `No available Pi model${suffix}.`);
  }

  if (args.command === "implement") {
    try {
      await requireCleanWorktree(cwd);
    } catch (error) {
      return failure(args.command, error instanceof Error ? error.message : String(error));
    }
  }

  const prompt = await dependencies.readFile(args.promptFile!);
  const session = await dependencies.createSession({
    cwd,
    mode: args.command === "implement" ? "implement" : "readonly",
    model: selected,
  });
  const result = await executeSession({
    kind: args.command,
    model: modelId(selected),
    prompt,
    session,
  });
  if (args.command !== "implement") return result;

  const changes = await captureWorktreeChanges(cwd);
  return { ...result, changedFiles: changes.changedFiles, diffStat: changes.diffStat };
}

function failure(kind: WorkerResult["kind"], output: string): WorkerResult {
  return {
    kind,
    status: "failed",
    success: false,
    model: null,
    output,
    changedFiles: [],
    diffStat: "",
    verification: { status: "not-run", commands: [] },
  };
}
