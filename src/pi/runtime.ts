import { createAgentSession, SessionManager, SettingsManager, type AuthStorage, type ModelRegistry, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type { BoundProjectPolicy, HostAssistanceRequest, HostAssistanceResult, PolicyDecision, ThinkingLevel, WorkerMode } from "../core/contracts.js";
import type { PolicyAction, PolicyEngine } from "../policy/engine.js";
import type { ProjectPolicyError } from "../policy/project-policy.js";
import { createTrustedResourceLoader } from "../policy/extension.js";
import type { SandboxRunner } from "../sandbox/runner.js";
import type { ModelConfiguration } from "../state/model-config.js";
import { createPiEnvironment } from "./environment.js";
import { createScopedFilesystemTools, createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
import { createHostAssistanceTool } from "./host-assistance-tool.js";

export interface CreateWorkerSessionOptions {
  cwd: string;
  mode: WorkerMode;
  boundProjectPolicy?: BoundProjectPolicy;
  onPolicyViolation?: (error: ProjectPolicyError) => void | Promise<void>;
  model?: CreateAgentSessionOptions["model"];
  modelConfiguration: ModelConfiguration;
  sandboxRunner?: SandboxRunner;
  thinkingLevel?: ThinkingLevel;
  policyEngine?: PolicyEngine;
  onApproval?: (
    action: PolicyAction,
    decision: PolicyDecision,
    fingerprint: string,
    signal?: AbortSignal,
  ) => Promise<"approved" | "denied" | "expired">;
  requestHostAssistance?: (request: HostAssistanceRequest, signal?: AbortSignal) => Promise<HostAssistanceResult>;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
}

export async function createWorkerSession(options: CreateWorkerSessionOptions) {
  const environment = options.authStorage && options.modelRegistry
    ? { authStorage: options.authStorage, modelRegistry: options.modelRegistry }
    : createPiEnvironment(options.modelConfiguration);
  const { authStorage, modelRegistry } = environment;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = await createTrustedResourceLoader({
    cwd: options.cwd,
    settingsManager,
    ...(options.policyEngine ? { engine: options.policyEngine } : {}),
    ...(options.onApproval ? { onApproval: options.onApproval } : {}),
  });

  return createAgentSession({
    cwd: options.cwd,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
    // When a project policy is bound, expose only the policy-aware custom
    // filesystem tools; do not register duplicate unscoped SDK built-ins.
    tools: options.boundProjectPolicy ? [] : toolsForMode(options.mode),
    customTools: [
      ...(options.boundProjectPolicy
        ? createScopedFilesystemTools({
          cwd: options.cwd,
          mode: options.mode,
          boundProjectPolicy: options.boundProjectPolicy,
          ...(options.onPolicyViolation ? { onPolicyViolation: options.onPolicyViolation } : {}),
        })
        : options.mode === "implement" ? createScopedMutationTools(options.cwd) : []),
      ...(options.sandboxRunner ? [options.sandboxRunner.createBashTool()] : []),
      ...(options.requestHostAssistance ? [createHostAssistanceTool(options.requestHostAssistance)] : []),
    ],
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as never } : {}),
  });
}
