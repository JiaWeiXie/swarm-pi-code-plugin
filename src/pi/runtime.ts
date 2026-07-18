import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  BoundProjectPolicy,
  HostAssistanceRequest,
  HostAssistanceResult,
  PolicyDecision,
  ThinkingLevel,
  WorkerMode,
} from "../core/contracts.js";
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
  requestHostAssistance?: (
    request: HostAssistanceRequest,
    signal?: AbortSignal,
  ) => Promise<HostAssistanceResult>;
  modelRuntime?: ModelRuntime;
}

export async function createWorkerSession(options: CreateWorkerSessionOptions) {
  const environment = options.modelRuntime
    ? { modelRuntime: options.modelRuntime }
    : await createPiEnvironment(options.modelConfiguration);
  const { modelRuntime } = environment;
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = await createTrustedResourceLoader({
    cwd: options.cwd,
    settingsManager,
    ...(options.policyEngine ? { engine: options.policyEngine } : {}),
    ...(options.onApproval ? { onApproval: options.onApproval } : {}),
    ...(options.requestHostAssistance
      ? { bypassToolNames: new Set(["request_host_assistance"]) }
      : {}),
  });

  const customTools = [
    ...(options.boundProjectPolicy
      ? createScopedFilesystemTools({
          cwd: options.cwd,
          mode: options.mode,
          boundProjectPolicy: options.boundProjectPolicy,
          ...(options.onPolicyViolation ? { onPolicyViolation: options.onPolicyViolation } : {}),
        })
      : options.mode === "implement"
        ? createScopedMutationTools(options.cwd)
        : []),
    ...(options.sandboxRunner ? [options.sandboxRunner.createBashTool()] : []),
    ...(options.requestHostAssistance
      ? [createHostAssistanceTool(options.requestHostAssistance)]
      : []),
  ];

  // `tools` is the SDK's allow-list of tool names, not a set of built-in
  // definitions to register (core/sdk.js: allowedToolNames = options.tools).
  // An empty array is truthy, so passing [] means "allow nothing" and filters
  // out our own custom tools too, leaving the worker with no tools at all.
  // Allow the mode's base tool names plus every custom tool we register: the
  // policy-scoped custom tools override the built-ins by name, so no unscoped
  // built-in is ever exposed while the scoped tools stay active.
  const allowedToolNames = workerToolAllowlist(options.mode, customTools);

  return createAgentSession({
    cwd: options.cwd,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    resourceLoader,
    tools: allowedToolNames,
    customTools,
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel as never } : {}),
  });
}

export function workerToolAllowlist(
  mode: WorkerMode,
  customTools: ReadonlyArray<{ name?: unknown }>,
): string[] {
  const customToolNames = customTools
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
  return Array.from(new Set([...toolsForMode(mode), ...customToolNames]));
}
