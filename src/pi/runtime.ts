import { createAgentSession, SessionManager, SettingsManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type { WorkerMode } from "../core/contracts.js";
import type { ModelConfiguration } from "../state/model-config.js";
import { createPiEnvironment } from "./environment.js";
import { createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";

export interface CreateWorkerSessionOptions {
  cwd: string;
  mode: WorkerMode;
  model?: CreateAgentSessionOptions["model"];
  modelConfiguration: ModelConfiguration;
}

export async function createWorkerSession(options: CreateWorkerSessionOptions) {
  const { authStorage, modelRegistry } = createPiEnvironment(options.modelConfiguration);

  return createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    tools: toolsForMode(options.mode),
    customTools: options.mode === "implement" ? createScopedMutationTools(options.cwd) : [],
    ...(options.model ? { model: options.model } : {}),
  });
}
