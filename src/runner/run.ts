import fs from "node:fs/promises";

import type { WorkerResult } from "../core/contracts.js";
import { executeSession, notImplementedResult, type RunnableSession } from "../pi/execute.js";
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
    mode: "readonly";
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

  if (args.command !== "ask" && args.command !== "plan") {
    return notImplementedResult(args.command);
  }

  const selected = selectModel(available, args.model);
  if (!selected) {
    const suffix = args.model ? `: ${args.model}` : "";
    return failure(args.command, `No available Pi model${suffix}.`);
  }

  const prompt = await dependencies.readFile(args.promptFile!);
  const session = await dependencies.createSession({ cwd, mode: "readonly", model: selected });
  return executeSession({
    kind: args.command,
    model: modelId(selected),
    prompt,
    session,
  });
}

function failure(kind: "ask" | "plan", output: string): WorkerResult {
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
