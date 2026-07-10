const COMMANDS = new Set([
    "init",
    "models",
    "providers",
    "configure",
    "ask",
    "review",
    "plan",
    "implement",
    "orchestrate",
]);
export function parseArguments(argv) {
    const command = argv[0];
    if (!command || !COMMANDS.has(command)) {
        throw new Error(`Unknown or missing command: ${command ?? "<none>"}`);
    }
    const parsed = {
        command,
        json: false,
        reconfigure: false,
        reset: false,
    };
    for (let index = 1; index < argv.length; index += 1) {
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
            case "--host":
                parsed.host = parseHost(readValue(argv, ++index, argument));
                break;
            case "--prompt-file":
                parsed.promptFile = readValue(argv, ++index, argument);
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
        command !== "init" &&
        !parsed.host) {
        throw new Error(`--host is required for ${command}`);
    }
    if (parsed.configurationSection && command !== "configure") {
        throw new Error("--section is only supported by configure");
    }
    if ((command === "ask" || command === "plan" || command === "implement" || command === "orchestrate") &&
        !parsed.promptFile) {
        throw new Error(`--prompt-file is required for ${command}`);
    }
    return parsed;
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
