import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import type { WorkerMode } from "../core/contracts.js";
import { toolsForMode } from "./tool-profiles.js";

export interface CreateWorkerSessionOptions {
  cwd: string;
  mode: WorkerMode;
  model?: CreateAgentSessionOptions["model"];
}

export async function createWorkerSession(options: CreateWorkerSessionOptions) {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  return createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    tools: toolsForMode(options.mode),
    ...(options.model ? { model: options.model } : {}),
  });
}
