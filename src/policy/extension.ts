import os from "node:os";
import path from "node:path";

import {
  DefaultResourceLoader,
  SettingsManager,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import type { PolicyDecision } from "../core/contracts.js";
import { actionFingerprint, type PolicyAction, type PolicyEngine } from "./engine.js";

export interface TrustedPolicyLoaderOptions {
  cwd: string;
  engine?: PolicyEngine;
  settingsManager?: SettingsManager;
  onApproval?: (
    action: PolicyAction,
    decision: PolicyDecision,
    fingerprint: string,
    signal?: AbortSignal,
  ) => Promise<"approved" | "denied" | "expired">;
}

export async function createTrustedResourceLoader(options: TrustedPolicyLoaderOptions): Promise<DefaultResourceLoader> {
  const settingsManager = options.settingsManager ?? SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: path.join(os.tmpdir(), "swarm-pi-worker-resources"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: options.engine ? [{
      name: "swarm-policy",
      factory: (pi) => {
        let consecutiveBlocks = 0;
        let totalBlocks = 0;
        pi.on("tool_call", async (event, ctx) => {
          const action = toolAction(event, options.cwd);
          let decision = await options.engine!.authorize(action, ctx.signal);
          if (decision.decision === "require-approval" && options.onApproval) {
            const resolution = await options.onApproval(action, decision, actionFingerprint(action), ctx.signal);
            if (resolution === "approved") decision = await options.engine!.authorize(action, ctx.signal);
          }
          if (decision.decision === "allow") {
            consecutiveBlocks = 0;
            return undefined;
          }
          consecutiveBlocks += 1;
          totalBlocks += 1;
          if (consecutiveBlocks >= 3 || totalBlocks >= 20) ctx.abort();
          return { block: true, reason: `[policy:${decision.decision}] ${decision.reason}` };
        });
      },
    }] : [],
  });
  await loader.reload();
  return loader;
}

function toolAction(event: ToolCallEvent, cwd: string): PolicyAction {
  const input = event.input as Record<string, unknown>;
  const candidate = typeof input.path === "string"
    ? input.path
    : typeof input.file_path === "string"
      ? input.file_path
      : undefined;
  return {
    toolName: event.toolName,
    input,
    cwd,
    ...(candidate ? { path: candidate } : {}),
  };
}
