import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export const SEALED_EVIDENCE_CUSTOM_TYPE = "swarm-pi-code-plugin/sealed-evidence-v1";
export const SEALED_EVIDENCE_VERSION = 1;
export const SEALED_EVIDENCE_MIN_ENTRIES = 1;
export const SEALED_EVIDENCE_MAX_ENTRIES = 8;
export const SEALED_EVIDENCE_SUMMARY_MAX_LENGTH = 512;
export const SEALED_EVIDENCE_FAILURE = "Shared reconnaissance failed its sealed-evidence boundary.";
// Schema validation happens before a custom tool's execute callback. Keep this
// outer shape deliberately permissive so every invocation reaches the
// controller, which can count it before returning the same sanitized error.
// The closed, bounded schema remains enforced synchronously by
// parseSealEvidenceInput().
const sealEvidenceParameters = Type.Object({
    entries: Type.Optional(Type.Any()),
}, { additionalProperties: true });
const authenticatedControllers = new WeakSet();
const controllerStates = new WeakMap();
export function createSealEvidenceController() {
    const controller = Object.freeze({
        kind: "review-coordinator",
        profile: "shared-recon",
    });
    authenticatedControllers.add(controller);
    controllerStates.set(controller, { calls: 0 });
    return controller;
}
export function isAuthenticatedSealEvidenceController(value) {
    return (value !== null &&
        typeof value === "object" &&
        authenticatedControllers.has(value) &&
        controllerStates.has(value));
}
function controllerState(value) {
    if (!isAuthenticatedSealEvidenceController(value)) {
        throw new Error("Shared reconnaissance controller authentication failed.");
    }
    return controllerStates.get(value);
}
export function getSealEvidenceAttempt(value) {
    const state = controllerState(value);
    return Object.freeze({ calls: state.calls, ...(state.seal ? { seal: state.seal } : {}) });
}
function recordSealEvidenceCall(controller, input) {
    const state = controllerState(controller);
    state.calls += 1;
    if (state.calls !== 1)
        throw new Error("seal_evidence may be called exactly once.");
    const seal = parseSealEvidenceInput(input);
    state.seal = seal;
    return seal;
}
/**
 * Lexical privacy boundary for summaries. This is deliberately best-effort:
 * it rejects recognizable controls and common machine-identifying forms, but
 * cannot prove that a natural-language claim contains no sensitive material.
 * A slash is not rejected on its own; ordinary relative names such as
 * `src/module.ts` remain usable.
 */
export function rejectedSealedEvidenceSummaryControl(summary) {
    for (const character of summary) {
        const codePoint = character.codePointAt(0);
        if ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
            return "control character";
        }
    }
    if (/`/u.test(summary))
        return "backtick";
    if (/(?:\b(?:https?|ftp|file):\/\/|(?:^|[^A-Za-z0-9._~-])www\.)[^\s]+/iu.test(summary)) {
        return "URL";
    }
    if (/(?:^|[^A-Za-z0-9._~-])\/(?:[^\s/]+\/)*[^\s/]+\/?/u.test(summary)) {
        return "Unix absolute path";
    }
    if (/(?:^|[^A-Za-z0-9._~-])[A-Za-z]:[\\/][^\s]+/u.test(summary)) {
        return "Windows drive path";
    }
    if (/(?:^|[^A-Za-z0-9._~-])\\\\[^\s\\]+(?:\\[^\s\\]+)+/u.test(summary)) {
        return "Windows UNC path";
    }
    if (/\b(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128})\b/iu.test(summary)) {
        return "hex digest";
    }
    return undefined;
}
function exactObject(value, allowed, where) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${where} must be an object`);
    }
    const object = value;
    const allowedKeys = new Set(allowed);
    for (const key of Object.keys(object)) {
        if (!allowedKeys.has(key))
            throw new Error(`${where} contains an unsupported field`);
    }
    return object;
}
function parseEntry(value, index) {
    const entry = exactObject(value, ["kind", "summary", "basis"], `Evidence entry ${index + 1}`);
    if (entry.kind !== "evidence" && entry.kind !== "unknown") {
        throw new Error("Evidence entry kind is invalid");
    }
    if (typeof entry.summary !== "string" ||
        entry.summary.length > SEALED_EVIDENCE_SUMMARY_MAX_LENGTH) {
        throw new Error("Evidence entry summary is invalid");
    }
    const rejected = rejectedSealedEvidenceSummaryControl(entry.summary);
    const summary = entry.summary.trim();
    if (!summary)
        throw new Error("Evidence entry summary is out of bounds");
    if (rejected)
        throw new Error("Evidence entry summary is not privacy-safe");
    if (!isSealedEvidenceBasis(entry.basis))
        throw new Error("Evidence entry basis is invalid");
    return Object.freeze({ kind: entry.kind, summary, basis: entry.basis });
}
function parseEntries(value) {
    if (!Array.isArray(value))
        throw new Error("Evidence entries must be an array");
    if (value.length < SEALED_EVIDENCE_MIN_ENTRIES || value.length > SEALED_EVIDENCE_MAX_ENTRIES) {
        throw new Error("Evidence entries are out of bounds");
    }
    return Object.freeze(value.map((entry, index) => parseEntry(entry, index)));
}
export function parseSealEvidenceInput(value) {
    const input = exactObject(value, ["entries"], "seal_evidence input");
    return Object.freeze({ version: SEALED_EVIDENCE_VERSION, entries: parseEntries(input.entries) });
}
/** Validate and defensively clone a seed at the perspective runtime boundary. */
export function validateSealedEvidenceSeed(value) {
    const input = exactObject(value, ["version", "entries"], "sealed evidence seed");
    if (input.version !== SEALED_EVIDENCE_VERSION)
        throw new Error("Sealed evidence version is invalid");
    return Object.freeze({ version: SEALED_EVIDENCE_VERSION, entries: parseEntries(input.entries) });
}
export function serializeSealedEvidence(value) {
    const seal = validateSealedEvidenceSeed(value);
    return JSON.stringify({ version: seal.version, entries: seal.entries });
}
export function createSealEvidenceTool(controller) {
    controllerState(controller);
    return defineTool({
        name: "seal_evidence",
        label: "Seal Evidence",
        description: "Seal one bounded set of coordinator evidence or unknown claims for shared-recon perspectives.",
        promptSnippet: "Seal the coordinator's bounded evidence exactly once before perspectives begin.",
        promptGuidelines: [
            "Call seal_evidence exactly once, with 1-8 entries, before completing reconnaissance.",
            "Each entry must contain only kind, summary, and basis; summaries are bounded and privacy-safe.",
            "The seal is evidence for later perspectives, not a way to send instructions or tool history.",
        ],
        parameters: sealEvidenceParameters,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
            try {
                recordSealEvidenceCall(controller, params);
            }
            catch {
                throw new Error("Evidence seal rejected.");
            }
            return sealedEvidenceToolResult();
        },
    });
}
function sealedEvidenceToolResult() {
    return {
        content: [{ type: "text", text: JSON.stringify({ status: "sealed" }) }],
        details: undefined,
    };
}
function isSealedEvidenceBasis(value) {
    return (value === "workspace" ||
        value === "request" ||
        value === "policy" ||
        value === "sdk" ||
        value === "inference");
}
