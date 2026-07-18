import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { createBashToolDefinition, } from "@earendil-works/pi-coding-agent";
import { resolveStateDir, resolveWorkspaceRoot } from "../state/state.js";
import { detectSandboxAvailability } from "./availability.js";
let activeRunner = false;
const execFileAsync = promisify(execFile);
export async function createSandboxRunner(options) {
    const availability = detectSandboxAvailability();
    if (!availability.available) {
        throw new Error(availability.reason ?? "Lenient sandboxing is unavailable");
    }
    if (activeRunner)
        throw new Error("A sandbox runner is already active in this process");
    const cwd = await fs.realpath(await resolveWorkspaceRoot(options.cwd));
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-sandbox-"));
    const env = options.env ?? process.env;
    let config;
    try {
        config = await sandboxConfiguration(cwd, tempRoot, options.mode, env, options.sandboxMode ?? "lenient", options.trustedDomains ?? [], options.boundProjectPolicy, options.allowGitMetadataRead ?? false);
    }
    catch (error) {
        await fs.rm(tempRoot, { recursive: true, force: true });
        throw error;
    }
    const previousClaudeTmpdir = process.env.CLAUDE_TMPDIR;
    process.env.CLAUDE_TMPDIR = tempRoot;
    activeRunner = true;
    try {
        await SandboxManager.initialize(config, async ({ host, port }) => {
            if ((options.sandboxMode ?? "lenient") === "lenient")
                return true;
            return options.authorizeNetwork ? options.authorizeNetwork(host, port) : false;
        });
    }
    catch (error) {
        activeRunner = false;
        restoreEnvironment("CLAUDE_TMPDIR", previousClaudeTmpdir);
        await SandboxManager.reset().catch(() => { });
        await fs.rm(tempRoot, { recursive: true, force: true });
        throw error;
    }
    const operations = sandboxedBashOperations(tempRoot, env);
    let disposed = false;
    return {
        cwd,
        mode: options.mode,
        createBashTool() {
            return createBashToolDefinition(cwd, { operations });
        },
        async dispose() {
            if (disposed)
                return;
            disposed = true;
            try {
                await SandboxManager.reset();
            }
            finally {
                activeRunner = false;
                restoreEnvironment("CLAUDE_TMPDIR", previousClaudeTmpdir);
                await fs.rm(tempRoot, { recursive: true, force: true });
            }
        },
    };
}
/**
 * Full-access runner: the same {@link SandboxRunner} interface, but the bash tool
 * runs commands directly with NO OS sandbox (no Seatbelt/Bubblewrap, no
 * SandboxManager). This deliberately removes the plugin's own confinement — any
 * remaining boundary comes only from the host process's own sandbox, if the host
 * applied one. It needs no sandbox backend, so (like strict) it never checks
 * availability and never participates in the wrapped-runner singleton.
 *
 * The worker's shell inherits the real environment (so ordinary tools behave
 * normally), minus the plugin's own injected secrets (`SWARM_PI_CODE_PLUGIN_*`:
 * provider API keys, auth-file path, worker token) which a shell never needs.
 */
export async function createUnsandboxedRunner(options) {
    const cwd = await fs.realpath(await resolveWorkspaceRoot(options.cwd));
    const env = options.env ?? process.env;
    const operations = unsandboxedBashOperations(env);
    let disposed = false;
    return {
        cwd,
        mode: options.mode,
        createBashTool() {
            return createBashToolDefinition(cwd, { operations });
        },
        async dispose() {
            disposed = true;
            void disposed;
        },
    };
}
export async function sandboxConfiguration(cwd, tempRoot, mode, env = process.env, sandboxMode = "lenient", trustedDomains = [], boundProjectPolicy, allowGitMetadataRead = false) {
    cwd = await fs.realpath(cwd);
    if (boundProjectPolicy && boundProjectPolicy.executionRoot !== cwd) {
        throw new Error("Bound project policy execution root does not match sandbox workspace");
    }
    const stateDir = await resolveStateDir(cwd, env);
    const gitPaths = await resolveGitMetadataPaths(cwd);
    const denyRead = [
        ...(await hostReadDenyPaths(cwd)),
        stateDir,
        ...(allowGitMetadataRead ? [] : gitPaths),
        ...credentialPaths(env),
    ];
    const denyWrite = [
        stateDir,
        ...gitPaths,
        path.join(cwd, ".env"),
        path.join(cwd, ".env.local"),
        path.join(cwd, ".swarm-pi-policy.json"),
        path.join(os.homedir(), ".npm", "_logs"),
        path.join(os.homedir(), ".claude", "debug"),
        "/tmp/claude",
        "/private/tmp/claude",
    ];
    const policyShellRoots = boundProjectPolicy ? [...boundProjectPolicy.roots.shell] : [];
    return {
        network: {
            allowedDomains: [],
            deniedDomains: sandboxMode === "adaptive"
                ? [
                    "localhost",
                    "127.0.0.0/8",
                    "10.0.0.0/8",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                    "169.254.0.0/16",
                ]
                : [],
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
        },
        filesystem: {
            denyRead: uniquePaths(denyRead),
            // Bash is a distinct capability: it may read only its shell roots, not
            // roots granted solely to the scoped read/search tools.
            allowRead: uniquePaths([
                ...executableReadPaths(cwd),
                ...policyShellRoots,
                ...(allowGitMetadataRead ? gitPaths : []),
            ]),
            allowWrite: uniquePaths(mode === "implement"
                ? boundProjectPolicy
                    ? [...boundProjectPolicy.roots.shell, tempRoot]
                    : [cwd, tempRoot]
                : [tempRoot]),
            denyWrite: uniquePaths(denyWrite),
            allowGitConfig: false,
        },
        enableWeakerNestedSandbox: false,
        enableWeakerNetworkIsolation: false,
    };
}
export function sanitizedSandboxEnvironment(cwd, tempRoot, env = process.env) {
    const safe = {
        HOME: tempRoot,
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
        XDG_CACHE_HOME: path.join(tempRoot, ".cache"),
        XDG_CONFIG_HOME: path.join(tempRoot, ".config"),
        XDG_DATA_HOME: path.join(tempRoot, ".local", "share"),
        PYTHONPYCACHEPREFIX: path.join(tempRoot, "python-cache"),
        PATH: sandboxPath(cwd),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        CI: env.CI ?? "1",
    };
    for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"]) {
        if (env[name])
            safe[name] = env[name];
    }
    return safe;
}
function sandboxedBashOperations(tempRoot, env) {
    let queue = Promise.resolve();
    return {
        async exec(command, cwd, { onData, signal, timeout }) {
            let release;
            const previous = queue;
            queue = new Promise((resolve) => {
                release = resolve;
            });
            await previous;
            try {
                return await executeSandboxed(command, cwd, tempRoot, env, onData, signal, timeout);
            }
            finally {
                release();
            }
        },
    };
}
async function executeSandboxed(command, cwd, tempRoot, env, onData, signal, timeout) {
    if (signal?.aborted)
        throw new Error("aborted");
    const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", undefined, signal);
    if (signal?.aborted) {
        SandboxManager.cleanupAfterCommand();
        throw new Error("aborted");
    }
    const child = spawn("/bin/bash", ["-c", wrapped], {
        cwd,
        detached: process.platform !== "win32",
        env: sanitizedSandboxEnvironment(cwd, tempRoot, env),
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    let timeoutHandle;
    const stop = () => killProcessTree(child.pid);
    if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            stop();
        }, timeout * 1000);
    }
    if (signal) {
        if (signal.aborted)
            stop();
        else
            signal.addEventListener("abort", stop, { once: true });
    }
    try {
        const exitCode = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        if (signal?.aborted)
            throw new Error("aborted");
        if (timedOut)
            throw new Error(`timeout:${timeout}`);
        return { exitCode };
    }
    finally {
        if (timeoutHandle)
            clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", stop);
        SandboxManager.cleanupAfterCommand();
    }
}
function unsandboxedBashOperations(env) {
    let queue = Promise.resolve();
    return {
        async exec(command, cwd, { onData, signal, timeout }) {
            let release;
            const previous = queue;
            queue = new Promise((resolve) => {
                release = resolve;
            });
            await previous;
            try {
                return await executeUnsandboxed(command, cwd, env, onData, signal, timeout);
            }
            finally {
                release();
            }
        },
    };
}
async function executeUnsandboxed(command, cwd, env, onData, signal, timeout) {
    if (signal?.aborted)
        throw new Error("aborted");
    const child = spawn("/bin/bash", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        env: fullAccessEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let timedOut = false;
    let timeoutHandle;
    const stop = () => killProcessTree(child.pid);
    if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            stop();
        }, timeout * 1000);
    }
    if (signal) {
        if (signal.aborted)
            stop();
        else
            signal.addEventListener("abort", stop, { once: true });
    }
    try {
        const exitCode = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        if (signal?.aborted)
            throw new Error("aborted");
        if (timedOut)
            throw new Error(`timeout:${timeout}`);
        return { exitCode };
    }
    finally {
        if (timeoutHandle)
            clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", stop);
    }
}
/**
 * Environment for full-access shells: the real environment (so ordinary tools
 * work), minus the plugin's own injected secrets. The `SWARM_PI_CODE_PLUGIN_*`
 * prefix covers provider API keys, the auth-file path, and the worker token; a
 * shell never needs them. The user's own credentials (AWS, kube, etc.) are kept
 * because full-access work may legitimately require them.
 */
function fullAccessEnvironment(env) {
    const safe = {};
    for (const [name, value] of Object.entries(env)) {
        if (name.startsWith("SWARM_PI_CODE_PLUGIN_"))
            continue;
        safe[name] = value;
    }
    // Keep automation from hanging on an interactive git credential prompt.
    safe.GIT_TERMINAL_PROMPT = "0";
    return safe;
}
function killProcessTree(pid) {
    if (!pid)
        return;
    try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    }
    catch {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            // The process already exited.
        }
    }
}
async function hostReadDenyPaths(cwd) {
    const home = await fs.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
    if (!isInside(home, cwd))
        return [home];
    const denied = [];
    let current = home;
    const relative = path.relative(home, cwd);
    for (const segment of relative.split(path.sep).filter(Boolean)) {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name !== segment)
                denied.push(path.join(current, entry.name));
        }
        current = path.join(current, segment);
    }
    return denied;
}
async function resolveGitMetadataPaths(cwd) {
    const paths = [path.join(cwd, ".git")];
    for (const args of [
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]) {
        try {
            const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
            paths.push(path.resolve(stdout.trim()));
        }
        catch {
            // Non-Git workspaces still receive the lexical .git deny path.
        }
    }
    return uniquePaths(paths);
}
function credentialPaths(env) {
    return [
        env.SWARM_PI_CODE_PLUGIN_AUTH_FILE,
        env.AWS_SHARED_CREDENTIALS_FILE,
        env.KUBECONFIG,
        path.join(os.homedir(), ".pi", "agent", "auth.json"),
    ]
        .filter((value) => Boolean(value))
        .map((value) => path.resolve(value));
}
function executableReadPaths(cwd) {
    return uniquePaths([
        path.dirname(process.execPath),
        path.join(cwd, "node_modules", ".bin"),
        ...directDeveloperToolPaths(),
    ]);
}
function sandboxPath(cwd) {
    return uniquePaths([
        path.join(cwd, "node_modules", ".bin"),
        path.dirname(process.execPath),
        ...directDeveloperToolPaths(),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]).join(path.delimiter);
}
function directDeveloperToolPaths() {
    const commandLineTools = "/Library/Developer/CommandLineTools/usr/bin";
    return process.platform === "darwin" && existsSync(commandLineTools) ? [commandLineTools] : [];
}
function uniquePaths(values) {
    return [...new Set(values.map((value) => path.resolve(value)))];
}
function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)));
}
function restoreEnvironment(name, value) {
    if (value === undefined)
        delete process.env[name];
    else
        process.env[name] = value;
}
