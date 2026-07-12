import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTrustedResourceLoader } from "../policy/extension.js";
import { createPiEnvironment } from "./environment.js";
import { createScopedFilesystemTools, createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
import { createHostAssistanceTool } from "./host-assistance-tool.js";
export async function createWorkerSession(options) {
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
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
}
