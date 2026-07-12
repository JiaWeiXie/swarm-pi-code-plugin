export function parseDiscoveryStageOutput(stage, output) {
    const value = parseObject(output);
    if (stage === "research") {
        const evidencePlan = parseEvidencePlan(value.evidencePlan);
        const evidencePack = parseEvidencePack(value.evidencePack);
        return {
            artifact: { stage, evidencePlan, evidencePack },
            verification: ["evidence-plan-valid", "evidence-pack-valid", "research-provenance-present"],
        };
    }
    if (stage === "experiment") {
        const experimentSpec = parseExperimentSpec(value.experimentSpec);
        const execution = parseExperimentExecution(value.execution);
        const conclusion = experimentConclusion(value.conclusion);
        return {
            artifact: { stage, experimentSpec, execution, conclusion },
            verification: [
                "experiment-spec-complete",
                "commands-recorded",
                "tests-recorded",
                "explicit-evidence-present",
                "clean-replay-passed",
            ],
        };
    }
    const featureDefinition = parseFeatureDefinition(value.featureDefinition);
    const decisionLedger = parseDecisionLedger(value.decisionLedger);
    return {
        artifact: { stage, featureDefinition, decisionLedger },
        verification: ["feature-definition-valid", "acceptance-criteria-present", "decision-ledger-present"],
    };
}
function parseObject(output) {
    const trimmed = output.trim();
    const candidate = trimmed.startsWith("```")
        ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
        : trimmed;
    let parsed;
    try {
        parsed = JSON.parse(candidate);
    }
    catch {
        throw new Error("Discovery stage output must be one JSON object");
    }
    return record(parsed, "Discovery stage output");
}
function parseEvidencePlan(input) {
    const value = record(input, "evidencePlan");
    const sources = strings(value.sources, "evidencePlan.sources", true).map((source) => {
        if (!["workspace", "web", "docs", "paper", "connector", "skill"].includes(source)) {
            throw new Error(`Unsupported evidence source: ${source}`);
        }
        return source;
    });
    const budget = integer(value.budget, "evidencePlan.budget", 0, 64);
    return {
        unknowns: strings(value.unknowns, "evidencePlan.unknowns", true),
        sources,
        acceptanceCriteria: strings(value.acceptanceCriteria, "evidencePlan.acceptanceCriteria", true),
        budget,
    };
}
function parseEvidencePack(input) {
    const value = record(input, "evidencePack");
    const claims = array(value.claims, "evidencePack.claims", true).map((item, index) => {
        const claim = record(item, `evidencePack.claims[${index}]`);
        const confidence = claim.confidence;
        if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
            throw new Error(`evidencePack.claims[${index}].confidence is invalid`);
        }
        return {
            claim: text(claim.claim, `evidencePack.claims[${index}].claim`),
            evidenceIds: strings(claim.evidenceIds, `evidencePack.claims[${index}].evidenceIds`, true),
            confidence: confidence,
        };
    });
    const citations = array(value.citations, "evidencePack.citations", true).map((item, index) => {
        const citation = record(item, `evidencePack.citations[${index}]`);
        const retrievedAt = text(citation.retrievedAt, `evidencePack.citations[${index}].retrievedAt`);
        if (!Number.isFinite(Date.parse(retrievedAt)))
            throw new Error(`evidencePack.citations[${index}].retrievedAt is invalid`);
        return {
            id: text(citation.id, `evidencePack.citations[${index}].id`),
            title: text(citation.title, `evidencePack.citations[${index}].title`),
            ...(optionalText(citation.url) ? { url: optionalText(citation.url) } : {}),
            ...(optionalText(citation.version) ? { version: optionalText(citation.version) } : {}),
            retrievedAt,
        };
    });
    return {
        claims,
        citations,
        conflicts: strings(value.conflicts, "evidencePack.conflicts"),
        unknowns: strings(value.unknowns, "evidencePack.unknowns"),
    };
}
function parseExperimentSpec(input) {
    const value = record(input, "experimentSpec");
    return {
        hypothesis: text(value.hypothesis, "experimentSpec.hypothesis"),
        baseline: text(value.baseline, "experimentSpec.baseline"),
        dependencies: strings(value.dependencies, "experimentSpec.dependencies"),
        fixture: text(value.fixture, "experimentSpec.fixture"),
        seedOrDataHash: text(value.seedOrDataHash, "experimentSpec.seedOrDataHash"),
        setupCommand: text(value.setupCommand, "experimentSpec.setupCommand"),
        runCommand: text(value.runCommand, "experimentSpec.runCommand"),
        testCommand: text(value.testCommand, "experimentSpec.testCommand"),
        verifyCommand: text(value.verifyCommand, "experimentSpec.verifyCommand"),
        cleanupCommand: text(value.cleanupCommand, "experimentSpec.cleanupCommand"),
        metrics: strings(value.metrics, "experimentSpec.metrics", true),
        tolerance: text(value.tolerance, "experimentSpec.tolerance"),
        cleanReplayCommand: text(value.cleanReplayCommand, "experimentSpec.cleanReplayCommand"),
    };
}
function parseExperimentExecution(input) {
    const value = record(input, "execution");
    if (value.cleanReplayPassed !== true)
        throw new Error("execution.cleanReplayPassed must be true");
    return {
        commandsRun: strings(value.commandsRun, "execution.commandsRun", true),
        testsRun: strings(value.testsRun, "execution.testsRun", true),
        evidence: strings(value.evidence, "execution.evidence", true),
        cleanReplayPassed: true,
    };
}
function experimentConclusion(value) {
    if (value === "supported" || value === "refuted" || value === "inconclusive")
        return value;
    throw new Error("Experiment conclusion must be supported, refuted, or inconclusive");
}
function parseFeatureDefinition(input) {
    const value = record(input, "featureDefinition");
    return {
        summary: text(value.summary, "featureDefinition.summary"),
        acceptanceCriteria: strings(value.acceptanceCriteria, "featureDefinition.acceptanceCriteria", true),
        nonGoals: strings(value.nonGoals, "featureDefinition.nonGoals"),
    };
}
function parseDecisionLedger(input) {
    return array(input, "decisionLedger", true).map((item, index) => {
        const value = record(item, `decisionLedger[${index}]`);
        return {
            decision: text(value.decision, `decisionLedger[${index}].decision`),
            rationale: text(value.rationale, `decisionLedger[${index}].rationale`),
            evidenceIds: strings(value.evidenceIds, `decisionLedger[${index}].evidenceIds`, true),
        };
    });
}
function record(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${field} must be an object`);
    return value;
}
function array(value, field, nonEmpty = false) {
    if (!Array.isArray(value) || (nonEmpty && value.length === 0))
        throw new Error(`${field} must be ${nonEmpty ? "a non-empty" : "an"} array`);
    return value;
}
function strings(value, field, nonEmpty = false) {
    const values = array(value, field, nonEmpty);
    if (!values.every((item) => typeof item === "string" && Boolean(item.trim())))
        throw new Error(`${field} must contain only non-empty strings`);
    return values;
}
function text(value, field) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${field} must be a non-empty string`);
    return value;
}
function optionalText(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function integer(value, field, min, max) {
    if (!Number.isInteger(value) || value < min || value > max)
        throw new Error(`${field} must be an integer from ${min} to ${max}`);
    return value;
}
