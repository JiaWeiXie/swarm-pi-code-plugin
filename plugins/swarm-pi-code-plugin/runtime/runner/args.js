import { isThinkingLevel, isWorkerRole } from "../orchestration/roles.js";
const COMMANDS = new Set([
    "init",
    "status",
    "doctor",
    "resume",
    "models",
    "providers",
    "configure",
    "roles",
    "jobs",
    "__worker",
    "ask",
    "review",
    "plan",
    "implement",
    "orchestrate",
    "scaffold",
    "setup",
    "discover",
]);
export function parseArguments(argv) {
    const command = argv[0];
    if (!command || !COMMANDS.has(command)) {
        throw new Error(`Unknown or missing command: ${command ?? "<none>"}`);
    }
    const jobsAction = command === "jobs" ? parseJobsAction(argv[1]) : undefined;
    const rolesAction = command === "roles" ? parseRolesAction(argv[1]) : undefined;
    const parsed = {
        command,
        ...(jobsAction ? { jobsAction } : {}),
        ...(rolesAction ? { rolesAction } : {}),
        json: false,
        reconfigure: false,
        reset: false,
    };
    for (let index = command === "jobs" || command === "roles" ? 2 : 1; index < argv.length; index += 1) {
        const argument = argv[index];
        switch (argument) {
            case "--json":
                parsed.json = true;
                break;
            case "--reconfigure":
                parsed.reconfigure = true;
                break;
            case "--reset":
                parsed.reset = true;
                break;
            case "--all":
                parsed.allModels = true;
                break;
            case "--no-open":
                parsed.noOpen = true;
                break;
            case "--smoke-test":
                parsed.smokeTest = true;
                break;
            case "--host":
                parsed.host = parseHost(readValue(argv, ++index, argument));
                break;
            case "--prompt-file":
                parsed.promptFile = readValue(argv, ++index, argument);
                break;
            case "--spec-file":
                parsed.specFile = readValue(argv, ++index, argument);
                break;
            case "--target":
                parsed.target = readValue(argv, ++index, argument);
                break;
            case "--continuation":
                parsed.continuationId = readValue(argv, ++index, argument);
                break;
            case "--workspace-strategy":
                parsed.workspaceStrategy = parseWorkspaceStrategy(readValue(argv, ++index, argument));
                break;
            case "--adopt-existing":
                parsed.adoptExisting = true;
                break;
            case "--decision-mode":
                parsed.decisionMode = parseDecisionMode(readValue(argv, ++index, argument));
                break;
            case "--host-assistance":
                parsed.hostAssistance = parseHostAssistanceMode(readValue(argv, ++index, argument));
                break;
            case "--host-context-file":
                parsed.hostContextFile = readValue(argv, ++index, argument);
                break;
            case "--discovery-from":
                parsed.discoveryFrom = readValue(argv, ++index, argument);
                break;
            case "--model":
                parsed.model = readValue(argv, ++index, argument);
                break;
            case "--provider":
                parsed.provider = readValue(argv, ++index, argument);
                break;
            case "--port":
                parsed.port = parsePort(readValue(argv, ++index, argument));
                break;
            case "--section":
                parsed.configurationSection = parseConfigurationSection(readValue(argv, ++index, argument));
                break;
            case "--execution-mode":
                parsed.executionMode = parseExecutionMode(readValue(argv, ++index, argument));
                break;
            case "--role":
                parsed.role = parseRole(readValue(argv, ++index, argument));
                break;
            case "--thinking-level":
                parsed.thinkingLevel = parseThinking(readValue(argv, ++index, argument));
                break;
            case "--approval-mode":
                parsed.approvalMode = parseApprovalMode(readValue(argv, ++index, argument));
                break;
            case "--timeout-ms":
                parsed.timeoutMs = parseDuration(readValue(argv, ++index, argument), argument);
                break;
            case "--job":
                parsed.jobId = readValue(argv, ++index, argument);
                break;
            case "--worker-token":
                parsed.workerToken = readValue(argv, ++index, argument);
                break;
            case "--wait-timeout-ms":
                parsed.waitTimeoutMs = parseDuration(readValue(argv, ++index, argument), argument);
                break;
            case "--pending-notifications":
                parsed.pendingNotifications = true;
                break;
            case "--approval":
                parsed.approvalId = readValue(argv, ++index, argument);
                break;
            case "--approval-scope":
                parsed.approvalScope = parseApprovalScope(readValue(argv, ++index, argument));
                break;
            case "--request":
                parsed.hostRequestId = readValue(argv, ++index, argument);
                break;
            case "--response-file":
                parsed.responseFile = readValue(argv, ++index, argument);
                break;
            case "--adjudication-file":
                parsed.adjudicationFile = readValue(argv, ++index, argument);
                break;
            case "--reason":
                parsed.declineReason = readValue(argv, ++index, argument);
                break;
            case "--notification":
                parsed.notificationId = readValue(argv, ++index, argument);
                break;
            case "--discard":
                parsed.discard = true;
                break;
            case "--audit":
                parsed.audit = true;
                break;
            case "--emit": {
                const emit = readValue(argv, ++index, argument);
                if (emit !== "ndjson")
                    throw new Error(`Invalid event format: ${emit}`);
                parsed.emit = emit;
                break;
            }
            case "--once":
                parsed.once = true;
                break;
            case "--base":
                parsed.base = readValue(argv, ++index, argument);
                break;
            case "--scope":
                parsed.scope = parseScope(readValue(argv, ++index, argument));
                break;
            case "--set-model-priority":
                parsed.modelPriority = parseStringArray(readValue(argv, ++index, argument), argument);
                break;
            case "--set-model-priority-file":
                parsed.modelPriorityFile = readValue(argv, ++index, argument);
                break;
            case "--save-profile":
                parsed.profile = parseObject(readValue(argv, ++index, argument), argument);
                break;
            case "--save-profile-file":
                parsed.profileFile = readValue(argv, ++index, argument);
                break;
            default:
                throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (command !== "models" &&
        command !== "providers" &&
        command !== "configure" &&
        command !== "roles" &&
        command !== "init" &&
        command !== "status" &&
        command !== "doctor" &&
        command !== "resume" &&
        command !== "jobs" &&
        command !== "__worker" &&
        !parsed.host) {
        throw new Error(`--host is required for ${command}`);
    }
    if (parsed.configurationSection && command !== "configure") {
        throw new Error("--section is only supported by configure");
    }
    if ((command === "ask" ||
        command === "plan" ||
        command === "implement" ||
        command === "orchestrate" ||
        command === "setup" ||
        command === "discover") &&
        !parsed.promptFile) {
        throw new Error(`--prompt-file is required for ${command}`);
    }
    if (command === "scaffold" && (!parsed.specFile || !parsed.target)) {
        throw new Error("scaffold requires --spec-file and --target");
    }
    if (command === "resume" && !parsed.continuationId)
        throw new Error("resume requires --continuation");
    if (parsed.audit && command !== "jobs")
        throw new Error("--audit is only supported by jobs export");
    if (parsed.adoptExisting && command !== "scaffold")
        throw new Error("--adopt-existing is only supported by scaffold");
    if (parsed.discoveryFrom && command !== "plan")
        throw new Error("--discovery-from is only supported by plan");
    if (parsed.smokeTest && command !== "doctor")
        throw new Error("--smoke-test is only supported by doctor");
    if ((parsed.executionMode ||
        parsed.timeoutMs ||
        parsed.role ||
        parsed.thinkingLevel ||
        parsed.approvalMode ||
        parsed.specFile ||
        parsed.decisionMode ||
        parsed.hostAssistance ||
        parsed.hostContextFile) &&
        !isTaskCommand(command)) {
        throw new Error("Delegation options are only supported by delegated task commands");
    }
    if (command === "jobs")
        validateJobsArguments(parsed);
    if (command === "__worker" && (!parsed.jobId || !parsed.workerToken)) {
        throw new Error("__worker requires --job and --worker-token");
    }
    return parsed;
}
function isTaskCommand(command) {
    return (command === "ask" ||
        command === "review" ||
        command === "plan" ||
        command === "implement" ||
        command === "orchestrate" ||
        command === "scaffold" ||
        command === "setup" ||
        command === "discover");
}
function parseDecisionMode(value) {
    if (value === "cost" || value === "balance" || value === "power")
        return value;
    throw new Error(`Invalid decision mode: ${value}`);
}
function parseHostAssistanceMode(value) {
    if (value === "inherit" || value === "on" || value === "off")
        return value;
    throw new Error(`Invalid host assistance mode: ${value}`);
}
function parseJobsAction(value) {
    if (value === "list" ||
        value === "status" ||
        value === "wait" ||
        value === "watch" ||
        value === "cancel" ||
        value === "acknowledge" ||
        value === "approvals" ||
        value === "approve" ||
        value === "deny" ||
        value === "host-requests" ||
        value === "host-respond" ||
        value === "host-decline" ||
        value === "decisions" ||
        value === "decide" ||
        value === "action-start" ||
        value === "cleanup" ||
        value === "export")
        return value;
    if (value === "materialize")
        return value;
    throw new Error(`Unknown or missing jobs action: ${value ?? "<none>"}`);
}
function parseWorkspaceStrategy(value) {
    if (value === "auto" || value === "isolated-head" || value === "isolated-snapshot")
        return value;
    throw new Error(`Invalid workspace strategy: ${value}`);
}
function parseRolesAction(value) {
    if (value === "list")
        return value;
    throw new Error(`Unknown or missing roles action: ${value ?? "<none>"}`);
}
function validateJobsArguments(args) {
    if (args.audit && args.jobsAction !== "export") {
        throw new Error("--audit is only supported by jobs export");
    }
    if (args.jobsAction === "export" && !args.audit) {
        throw new Error("jobs export requires --audit");
    }
    if (args.jobsAction !== "list" && args.jobsAction !== "watch" && !args.jobId) {
        throw new Error(`jobs ${args.jobsAction} requires --job`);
    }
    if (args.pendingNotifications && args.jobsAction !== "list") {
        throw new Error("--pending-notifications is only supported by jobs list");
    }
    if (args.waitTimeoutMs && args.jobsAction !== "wait") {
        throw new Error("--wait-timeout-ms is only supported by jobs wait");
    }
    if (args.emit && args.jobsAction !== "watch") {
        throw new Error("--emit is only supported by jobs watch");
    }
    if (args.jobsAction === "watch" && args.emit !== "ndjson") {
        throw new Error("jobs watch requires --emit ndjson");
    }
    if (args.once && args.jobsAction !== "watch") {
        throw new Error("--once is only supported by jobs watch");
    }
    if ((args.jobsAction === "approve" || args.jobsAction === "deny") && !args.approvalId) {
        throw new Error(`jobs ${args.jobsAction} requires --approval`);
    }
    if ((args.jobsAction === "host-respond" ||
        args.jobsAction === "host-decline" ||
        args.jobsAction === "decide" ||
        args.jobsAction === "action-start") &&
        !args.hostRequestId) {
        throw new Error(`jobs ${args.jobsAction} requires --request`);
    }
    if ((args.jobsAction === "host-respond" || args.jobsAction === "decide") && !args.responseFile) {
        throw new Error(`jobs ${args.jobsAction} requires --response-file`);
    }
    if (args.responseFile && args.jobsAction !== "host-respond" && args.jobsAction !== "decide") {
        throw new Error("--response-file is only supported by jobs host-respond or jobs decide");
    }
    if (args.adjudicationFile &&
        args.jobsAction !== "approve" &&
        args.jobsAction !== "host-respond" &&
        args.jobsAction !== "decide") {
        throw new Error("--adjudication-file is only supported by jobs approve, host-respond, or decide");
    }
    if (args.declineReason && args.jobsAction !== "host-decline") {
        throw new Error("--reason is only supported by jobs host-decline");
    }
    if (args.approvalScope && args.jobsAction !== "approve") {
        throw new Error("--approval-scope is only supported by jobs approve");
    }
    if (args.notificationId && args.jobsAction !== "acknowledge") {
        throw new Error("--notification is only supported by jobs acknowledge");
    }
    if (args.discard && args.jobsAction !== "cleanup") {
        throw new Error("--discard is only supported by jobs cleanup");
    }
}
function parseExecutionMode(value) {
    if (value === "supervised" || value === "background")
        return value;
    throw new Error(`Invalid execution mode: ${value}`);
}
function parseRole(value) {
    if (isWorkerRole(value))
        return value;
    throw new Error(`Invalid worker role: ${value}`);
}
function parseThinking(value) {
    if (isThinkingLevel(value))
        return value;
    throw new Error(`Invalid thinking level: ${value}`);
}
function parseApprovalMode(value) {
    if (value === "deny" || value === "wait")
        return value;
    throw new Error(`Invalid approval mode: ${value}`);
}
function parseApprovalScope(value) {
    if (value === "once" || value === "job")
        return value;
    throw new Error(`Invalid approval scope: ${value}`);
}
function parseDuration(value, flag) {
    const duration = Number(value);
    if (!Number.isInteger(duration) || duration < 1_000 || duration > 86_400_000) {
        throw new Error(`${flag} must be an integer from 1000 to 86400000`);
    }
    return duration;
}
function parseConfigurationSection(value) {
    if (value === "project")
        return value;
    throw new Error(`Invalid configuration section: ${value}`);
}
function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${value}`);
    }
    return port;
}
function parseScope(value) {
    if (value === "auto" || value === "working-tree" || value === "branch")
        return value;
    throw new Error(`Invalid review scope: ${value}`);
}
function parseStringArray(value, flag) {
    const parsed = parseJson(value, flag);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error(`${flag} requires a JSON string array`);
    }
    return parsed;
}
function parseObject(value, flag) {
    const parsed = parseJson(value, flag);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${flag} requires a JSON object`);
    }
    return parsed;
}
function parseJson(value, flag) {
    try {
        return JSON.parse(value);
    }
    catch {
        throw new Error(`${flag} requires valid JSON`);
    }
}
function parseHost(value) {
    if (value !== "claude" && value !== "codex") {
        throw new Error(`Invalid host: ${value}`);
    }
    return value;
}
function readValue(argv, index, flag) {
    const value = argv[index];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
