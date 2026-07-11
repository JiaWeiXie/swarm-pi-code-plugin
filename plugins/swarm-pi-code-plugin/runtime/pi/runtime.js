import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTrustedResourceLoader } from "../policy/extension.js";
import { createPiEnvironment } from "./environment.js";
import { createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
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
        tools: toolsForMode(options.mode),
        customTools: [
            ...(options.mode === "implement" ? createScopedMutationTools(options.cwd) : []),
            ...(options.sandboxRunner ? [options.sandboxRunner.createBashTool()] : []),
        ],
        ...(options.model ? { model: options.model } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
}
