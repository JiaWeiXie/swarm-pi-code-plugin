import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiEnvironment } from "./environment.js";
import { createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
export async function createWorkerSession(options) {
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
