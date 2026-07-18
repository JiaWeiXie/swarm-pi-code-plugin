import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createTrustedResourceLoader } from "../policy/extension.js";
import { createPiEnvironment } from "./environment.js";
import { createScopedFilesystemTools, createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
import { createHostAssistanceTool } from "./host-assistance-tool.js";
export async function createWorkerSession(options) {
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
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    });
}
export function workerToolAllowlist(mode, customTools) {
    const customToolNames = customTools
        .map((tool) => tool.name)
        .filter((name) => typeof name === "string");
    return Array.from(new Set([...toolsForMode(mode), ...customToolNames]));
}
