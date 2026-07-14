import path from "node:path";
const MAX_READ_ONLY_COMMAND_LENGTH = 4_000;
const COMPOSITION_OPERATORS = new Set(["&&", "||", "|", ";", "\n"]);
const CONTROL_WORDS = new Set([
    "if",
    "then",
    "elif",
    "else",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "select",
    "function",
    "time",
    "!",
]);
export function shellPathOperands(analysis) {
    return [
        ...analysis.redirectionTargets,
        ...analysis.commands.flatMap((invocation) => pathArguments(invocation)),
    ];
}
/**
 * Lex enough shell structure to distinguish executable positions and path
 * operands from quoted data. This is not a general shell parser: unsupported
 * constructs remain observable in the analysis and therefore fail closed in
 * the read-only recognizer.
 */
export function analyzeShellCommand(command) {
    const lexed = lexShell(command);
    const commands = [];
    const operators = [];
    const redirectionTargets = [];
    let current;
    let expectCommand = true;
    let expectRedirectionTarget = false;
    let hasControlFlow = false;
    let hasAssignments = false;
    const finishCommand = () => {
        if (current)
            commands.push(current);
        current = undefined;
    };
    for (const token of lexed.tokens) {
        if (token.kind === "operator") {
            operators.push(token.value);
            if (isRedirectionOperator(token.value)) {
                expectRedirectionTarget = true;
                continue;
            }
            finishCommand();
            expectCommand = true;
            continue;
        }
        if (expectRedirectionTarget) {
            redirectionTargets.push(token.value);
            expectRedirectionTarget = false;
            continue;
        }
        if (expectCommand) {
            if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token.value)) {
                hasAssignments = true;
                continue;
            }
            if (!token.quoted && CONTROL_WORDS.has(token.value)) {
                hasControlFlow = true;
                continue;
            }
            current = { executable: executableName(token.value), args: [] };
            expectCommand = false;
            continue;
        }
        current?.args.push(token.value);
    }
    finishCommand();
    return {
        commands,
        operators,
        redirectionTargets,
        hasExpansion: lexed.hasExpansion,
        hasCommandSubstitution: lexed.hasCommandSubstitution,
        hasBackticks: lexed.hasBackticks,
        hasHereDoc: lexed.hasHereDoc,
        hasControlFlow,
        hasAssignments,
        malformed: lexed.malformed || expectRedirectionTarget,
    };
}
/**
 * Recognize a bounded shell subset whose observable effect is confined to
 * stdout/stderr and process exit status. Every executable segment and
 * composition operator must be independently proven read-only.
 */
export function isReadOnlyShellCommand(command, cwd) {
    const value = command.trim();
    if (!value || value.length > MAX_READ_ONLY_COMMAND_LENGTH)
        return false;
    const analysis = analyzeShellCommand(value);
    if (analysis.malformed ||
        analysis.commands.length === 0 ||
        analysis.redirectionTargets.length > 0 ||
        analysis.hasExpansion ||
        analysis.hasCommandSubstitution ||
        analysis.hasBackticks ||
        analysis.hasHereDoc ||
        analysis.hasControlFlow ||
        analysis.hasAssignments ||
        analysis.operators.some((operator) => !COMPOSITION_OPERATORS.has(operator))) {
        return false;
    }
    return analysis.commands.every((invocation) => isReadOnlyShellInvocation(invocation) &&
        pathArguments(invocation).every((candidate) => safeWorkspacePath(candidate, cwd)));
}
export function isReadOnlyShellInvocation(invocation) {
    const { executable, args } = invocation;
    if (executable === "pwd")
        return args.length === 0 || (args.length === 1 && args[0] === "--");
    if (executable === "git")
        return isReadOnlyGit(args);
    if (["rustc", "cargo", "node", "npm", "pnpm", "yarn", "bun", "mise"].includes(executable)) {
        return (args.length > 0 && args.every((arg) => ["--version", "-V", "-Vv", "--verbose"].includes(arg)));
    }
    if (executable === "cmp") {
        const positional = positionalArguments(args);
        return positional.length === 2 && !hasAnyOption(args, ["--print-bytes", "-l"]);
    }
    if (executable === "diff") {
        const positional = positionalArguments(args);
        return (positional.length === 2 &&
            !hasOptionPrefix(args, ["-o", "--output", "--GTYPE-group-format", "--line-format"]));
    }
    if (executable === "find") {
        return !hasAnyOption(args, [
            "-delete",
            "-exec",
            "-execdir",
            "-ok",
            "-okdir",
            "-fls",
            "-fprint",
            "-fprint0",
            "-fprintf",
        ]);
    }
    if (["rg", "fd"].includes(executable)) {
        return !hasOptionPrefix(args, ["--pre", "--pre-glob", "--exec", "--exec-batch", "-x", "-X"]);
    }
    if (["sort", "tree"].includes(executable)) {
        return !hasOptionPrefix(args, ["-o", "--output"]);
    }
    if (executable === "file")
        return !hasAnyOption(args, ["-C", "--compile"]);
    if (executable === "sed")
        return isReadOnlySed(args);
    if (executable === "tail" && hasOptionPrefix(args, ["-f", "--follow", "-F"]))
        return false;
    if ([
        "ls",
        "cat",
        "head",
        "tail",
        "wc",
        "stat",
        "file",
        "du",
        "tree",
        "sort",
        "uniq",
        "cut",
        "tr",
        "jq",
        "grep",
        "sha256sum",
        "shasum",
        "realpath",
        "readlink",
        "which",
        "type",
        "echo",
        "printf",
        "test",
        "[",
        "true",
        "false",
    ].includes(executable)) {
        return true;
    }
    if (executable === "command")
        return args.length === 2 && args[0] === "-v";
    return false;
}
export function isVersionProbeInvocation(invocation) {
    return (["rustc", "cargo", "node", "npm", "pnpm", "yarn", "bun", "mise"].includes(invocation.executable) &&
        invocation.args.length > 0 &&
        invocation.args.every((arg) => ["--version", "-V", "-Vv", "--verbose"].includes(arg)));
}
function isReadOnlyGit(args) {
    const parsed = parseGitInvocation(args);
    if (!parsed || parsed.unsafeGlobalOption)
        return false;
    const { subcommand, args: commandArgs } = parsed;
    if ([
        "status",
        "ls-files",
        "rev-parse",
        "check-ignore",
        "check-attr",
        "describe",
        "name-rev",
        "for-each-ref",
        "shortlog",
    ].includes(subcommand)) {
        return true;
    }
    if (["diff", "log", "show"].includes(subcommand)) {
        return !hasOptionPrefix(commandArgs, ["--output", "--ext-diff", "--textconv"]);
    }
    if (subcommand === "grep") {
        return !hasOptionPrefix(commandArgs, ["--open-files-in-pager"]);
    }
    if (subcommand === "branch")
        return isReadOnlyGitBranch(commandArgs);
    if (subcommand === "tag")
        return isReadOnlyGitTag(commandArgs);
    if (subcommand === "worktree")
        return commandArgs[0] === "list";
    if (subcommand === "remote") {
        if (commandArgs.every((arg) => arg === "-v" || arg === "--verbose")) {
            return true;
        }
        if (commandArgs[0] === "get-url")
            return true;
        return commandArgs[0] === "show" && commandArgs.some((arg) => arg === "-n");
    }
    return false;
}
export function isReadOnlyGitBranch(args) {
    if (args.length === 0)
        return true;
    if (hasOptionPrefix(args, [
        "-d",
        "-D",
        "-m",
        "-M",
        "-c",
        "-C",
        "--delete",
        "--move",
        "--copy",
        "--edit-description",
        "--set-upstream-to",
        "--unset-upstream",
    ])) {
        return false;
    }
    return args.some((arg) => [
        "-a",
        "--all",
        "-r",
        "--remotes",
        "-l",
        "--list",
        "--show-current",
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--format",
        "--sort",
    ].some((option) => arg === option || arg.startsWith(`${option}=`)));
}
function isReadOnlyGitTag(args) {
    if (args.length === 0)
        return true;
    if (hasOptionPrefix(args, [
        "-d",
        "--delete",
        "-a",
        "--annotate",
        "-s",
        "--sign",
        "-u",
        "--local-user",
        "-f",
        "--force",
    ])) {
        return false;
    }
    return args.some((arg) => [
        "-l",
        "--list",
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--format",
        "--sort",
    ].some((option) => arg === option || arg.startsWith(`${option}=`)));
}
export function parseGitInvocation(args) {
    let index = 0;
    let unsafeGlobalOption = false;
    while (index < args.length && args[index]?.startsWith("-")) {
        const option = args[index];
        if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) {
            unsafeGlobalOption = true;
            index += 2;
            continue;
        }
        if (["--no-pager", "--literal-pathspecs", "--no-optional-locks"].includes(option)) {
            index += 1;
            continue;
        }
        unsafeGlobalOption = true;
        index += 1;
    }
    const subcommand = args[index];
    return subcommand ? { subcommand, args: args.slice(index + 1), unsafeGlobalOption } : null;
}
function isReadOnlySed(args) {
    if (args.length < 3 || args[0] !== "-n")
        return false;
    if (!/^\d+(?:,\d+)?p$/.test(args[1] ?? ""))
        return false;
    return args.slice(2).every((arg) => !arg.startsWith("-"));
}
function pathArguments(invocation) {
    const { executable, args } = invocation;
    if (["echo", "printf", "true", "false", "type", "command"].includes(executable)) {
        return [];
    }
    if (["grep", "rg"].includes(executable))
        return searchPathArguments(args);
    if (executable === "jq") {
        const positional = positionalArguments(args);
        return positional.slice(1);
    }
    if (executable === "sed")
        return args.slice(2);
    return args;
}
function searchPathArguments(args) {
    const paths = [];
    let sawPattern = false;
    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];
        if (["-e", "--regexp"].includes(value)) {
            index += 1;
            sawPattern = true;
            continue;
        }
        if (["-f", "--file"].includes(value)) {
            if (args[index + 1])
                paths.push(args[index + 1]);
            index += 1;
            continue;
        }
        if (value.startsWith("-"))
            continue;
        if (!sawPattern) {
            sawPattern = true;
            continue;
        }
        paths.push(value);
    }
    return paths;
}
function safeWorkspacePath(value, cwd) {
    const normalized = value.replaceAll("\\", "/");
    if (normalized.split("/").includes(".."))
        return false;
    if (!path.isAbsolute(value))
        return true;
    if (!cwd)
        return false;
    const relative = path.relative(path.resolve(cwd), path.resolve(value));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function positionalArguments(args) {
    return args.filter((arg) => !arg.startsWith("-"));
}
function hasAnyOption(args, options) {
    return args.some((arg) => options.includes(arg));
}
function hasOptionPrefix(args, options) {
    return args.some((arg) => options.some((option) => arg === option ||
        arg.startsWith(`${option}=`) ||
        (option.length === 2 &&
            option.startsWith("-") &&
            !option.startsWith("--") &&
            arg.startsWith(option))));
}
function executableName(value) {
    return path.posix.basename(value.replaceAll("\\", "/"));
}
function isRedirectionOperator(value) {
    return /[<>]/.test(value);
}
function lexShell(command) {
    const tokens = [];
    let word = { value: "", quoted: false };
    let quote = null;
    let escaped = false;
    let hasExpansion = false;
    let hasCommandSubstitution = false;
    let hasBackticks = false;
    let hasHereDoc = false;
    let malformed = false;
    let expectHereDocDelimiter = false;
    const hereDocDelimiters = [];
    let pendingHereDocStripTabs = false;
    const pushWord = () => {
        if (!word.value && !word.quoted)
            return;
        tokens.push({ kind: "word", value: word.value, quoted: word.quoted });
        if (expectHereDocDelimiter) {
            hereDocDelimiters.push({ value: word.value, stripTabs: pendingHereDocStripTabs });
            expectHereDocDelimiter = false;
        }
        word = { value: "", quoted: false };
    };
    const pushOperator = (value) => {
        pushWord();
        tokens.push({ kind: "operator", value });
        if (value === "<<" || value === "<<-") {
            hasHereDoc = true;
            expectHereDocDelimiter = true;
            pendingHereDocStripTabs = value === "<<-";
        }
    };
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (escaped) {
            word.value += char;
            word.quoted = true;
            escaped = false;
            continue;
        }
        if (quote === "single") {
            if (char === "'")
                quote = null;
            else
                word.value += char;
            word.quoted = true;
            continue;
        }
        if (quote === "double") {
            if (char === '"') {
                quote = null;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else {
                if (char === "$") {
                    hasExpansion = true;
                    if (command[index + 1] === "(")
                        hasCommandSubstitution = true;
                }
                if (char === "`")
                    hasBackticks = true;
                word.value += char;
            }
            word.quoted = true;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === "'") {
            quote = "single";
            word.quoted = true;
            continue;
        }
        if (char === '"') {
            quote = "double";
            word.quoted = true;
            continue;
        }
        if (char === "$" || char === "`") {
            if (char === "$") {
                hasExpansion = true;
                if (command[index + 1] === "(")
                    hasCommandSubstitution = true;
            }
            else {
                hasBackticks = true;
            }
            word.value += char;
            continue;
        }
        if (char === " " || char === "\t") {
            pushWord();
            continue;
        }
        if (char === "\r" || char === "\n") {
            pushOperator("\n");
            if (hereDocDelimiters.length > 0) {
                for (const delimiter of hereDocDelimiters.splice(0)) {
                    let found = false;
                    while (index + 1 < command.length) {
                        const start = index + 1;
                        const end = command.indexOf("\n", start);
                        const final = end < 0 ? command.length : end;
                        const line = command.slice(start, final);
                        const comparable = delimiter.stripTabs ? line.replace(/^\t+/, "") : line;
                        index = end < 0 ? command.length - 1 : end;
                        if (comparable === delimiter.value) {
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                        malformed = true;
                }
            }
            continue;
        }
        if (";&|()<>".includes(char)) {
            const next = command[index + 1] ?? "";
            const third = command[index + 2] ?? "";
            let operator = char;
            if ((char === "&" && next === "&") ||
                (char === "|" && next === "|") ||
                (char === ">" && next === ">") ||
                (char === "<" && next === ">")) {
                operator += next;
                index += 1;
            }
            else if (char === "<" && next === "<") {
                operator = third === "-" ? "<<-" : third === "<" ? "<<<" : "<<";
                index += operator.length - 1;
            }
            pushOperator(operator);
            continue;
        }
        word.value += char;
    }
    pushWord();
    if (quote || escaped || expectHereDocDelimiter)
        malformed = true;
    return {
        tokens,
        hasExpansion,
        hasCommandSubstitution,
        hasBackticks,
        hasHereDoc,
        malformed,
    };
}
