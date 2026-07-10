import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
export async function createWorkerSession(options) {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
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
