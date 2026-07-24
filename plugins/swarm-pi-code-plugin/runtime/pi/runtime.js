import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createTrustedResourceLoader } from "../policy/extension.js";
import { createPiEnvironment } from "./environment.js";
import { createScopedFilesystemTools, createScopedMutationTools } from "./scoped-tools.js";
import { toolsForMode } from "./tool-profiles.js";
import { createHostAssistanceTool } from "./host-assistance-tool.js";
import { createPrewalkController, withPrewalkBashGate } from "./prewalk.js";
import { createSealEvidenceTool, isAuthenticatedSealEvidenceController, serializeSealedEvidence, SEALED_EVIDENCE_CUSTOM_TYPE, validateSealedEvidenceSeed, } from "../orchestration/sealed-evidence.js";
export async function createWorkerSession(options) {
    if (options.sealEvidenceController !== undefined && options.sealedEvidenceSeed !== undefined) {
        throw new Error("Shared-recon controller and evidence seed options are incompatible.");
    }
    if (options.sealEvidenceController !== undefined &&
        (!isAuthenticatedSealEvidenceController(options.sealEvidenceController) ||
            options.mode !== "readonly")) {
        throw new Error("Shared-recon coordinator authentication failed.");
    }
    const sealedEvidenceSeed = options.sealedEvidenceSeed === undefined
        ? undefined
        : validateSealedEvidenceSeed(options.sealedEvidenceSeed);
    if (sealedEvidenceSeed !== undefined && options.mode !== "readonly") {
        throw new Error("Shared-recon evidence seeds require a readonly perspective.");
    }
    const prewalk = options.prewalk ? createPrewalkController(options.prewalk) : undefined;
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
        ...(options.requestHostAssistance || options.sealEvidenceController
            ? {
                bypassToolNames: new Set([
                    ...(options.requestHostAssistance ? ["request_host_assistance"] : []),
                    ...(options.sealEvidenceController ? ["seal_evidence"] : []),
                ]),
            }
            : {}),
    });
    const customTools = [
        ...(options.boundProjectPolicy
            ? createScopedFilesystemTools({
                cwd: options.cwd,
                mode: options.mode,
                boundProjectPolicy: options.boundProjectPolicy,
                ...(options.onPolicyViolation ? { onPolicyViolation: options.onPolicyViolation } : {}),
                ...(prewalk
                    ? {
                        beforeWorkspaceMutation: () => prewalk.beforeWorkspaceMutation(),
                        onWorkspaceMutation: () => prewalk.onWorkspaceMutation(),
                    }
                    : {}),
            })
            : options.mode === "implement"
                ? createScopedMutationTools(options.cwd, prewalk ? () => prewalk.onWorkspaceMutation() : undefined, prewalk ? () => prewalk.beforeWorkspaceMutation() : undefined)
                : []),
        ...(prewalk ? [prewalk.tool] : []),
        ...(options.sandboxRunner
            ? [
                (prewalk
                    ? withPrewalkBashGate(options.sandboxRunner.createBashTool(), prewalk)
                    : options.sandboxRunner.createBashTool()),
            ]
            : []),
        ...(options.requestHostAssistance
            ? [createHostAssistanceTool(options.requestHostAssistance)]
            : []),
        ...(options.sealEvidenceController
            ? [createSealEvidenceTool(options.sealEvidenceController)]
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
    const sessionResult = await createAgentSession({
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
    const session = sessionResult.session;
    if (sealedEvidenceSeed !== undefined) {
        try {
            if (typeof session.sendCustomMessage !== "function") {
                throw new Error("Shared-recon custom-message seeding is unavailable.");
            }
            await session.sendCustomMessage({
                customType: SEALED_EVIDENCE_CUSTOM_TYPE,
                content: serializeSealedEvidence(sealedEvidenceSeed),
                display: false,
            }, { triggerTurn: false });
        }
        catch {
            session.dispose();
            throw new Error("Shared-recon custom-message seeding failed.");
        }
    }
    if (prewalk) {
        prewalk.attach(session);
        Object.assign(session, { prewalk });
    }
    return Object.assign(sessionResult, prewalk ? { prewalk } : {});
}
export function workerToolAllowlist(mode, customTools) {
    const customToolNames = customTools
        .map((tool) => tool.name)
        .filter((name) => typeof name === "string");
    return Array.from(new Set([...toolsForMode(mode), ...customToolNames]));
}
