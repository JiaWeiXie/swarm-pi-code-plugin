import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import {
  createBashToolDefinition,
  type BashOperations,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import type { SandboxMode, WorkerMode } from "../core/contracts.js";
import type { BoundProjectPolicy } from "../core/contracts.js";
import { resolveStateDir, resolveWorkspaceRoot } from "../state/state.js";
import { detectSandboxAvailability } from "./availability.js";

export interface SandboxRunner {
  readonly cwd: string;
  readonly mode: WorkerMode;
  createBashTool(): NonNullable<CreateAgentSessionOptions["customTools"]>[number];
  dispose(): Promise<void>;
}

let activeRunner = false;
const execFileAsync = promisify(execFile);

export async function createSandboxRunner(options: {
  cwd: string;
  mode: WorkerMode;
  sandboxMode?: Extract<SandboxMode, "adaptive" | "lenient">;
  trustedDomains?: string[];
  boundProjectPolicy?: BoundProjectPolicy;
  authorizeNetwork?: (host: string, port?: number) => Promise<boolean>;
  allowGitMetadataRead?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<SandboxRunner> {
  const availability = detectSandboxAvailability();
  if (!availability.available) {
    throw new Error(availability.reason ?? "Lenient sandboxing is unavailable");
  }
  if (activeRunner) throw new Error("A sandbox runner is already active in this process");

  const cwd = await fs.realpath(await resolveWorkspaceRoot(options.cwd));
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pi-sandbox-"));
  const env = options.env ?? process.env;
  let config: SandboxRuntimeConfig;
  try {
    config = await sandboxConfiguration(
      cwd,
      tempRoot,
      options.mode,
      env,
      options.sandboxMode ?? "lenient",
      options.trustedDomains ?? [],
      options.boundProjectPolicy,
      options.allowGitMetadataRead ?? false,
    );
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const previousClaudeTmpdir = process.env.CLAUDE_TMPDIR;
  process.env.CLAUDE_TMPDIR = tempRoot;

  activeRunner = true;
  try {
    await SandboxManager.initialize(config, async ({ host, port }) => {
      if ((options.sandboxMode ?? "lenient") === "lenient") return true;
      return options.authorizeNetwork ? options.authorizeNetwork(host, port) : false;
    });
  } catch (error) {
    activeRunner = false;
    restoreEnvironment("CLAUDE_TMPDIR", previousClaudeTmpdir);
    await SandboxManager.reset().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }

  const operations = sandboxedBashOperations(tempRoot, env);
  let disposed = false;
  return {
    cwd,
    mode: options.mode,
    createBashTool() {
      return createBashToolDefinition(cwd, { operations }) as NonNullable<
        CreateAgentSessionOptions["customTools"]
      >[number];
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await SandboxManager.reset();
      } finally {
        activeRunner = false;
        restoreEnvironment("CLAUDE_TMPDIR", previousClaudeTmpdir);
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
}

export async function sandboxConfiguration(
  cwd: string,
  tempRoot: string,
  mode: WorkerMode,
  env: NodeJS.ProcessEnv = process.env,
  sandboxMode: Extract<SandboxMode, "adaptive" | "lenient"> = "lenient",
  trustedDomains: string[] = [],
  boundProjectPolicy?: BoundProjectPolicy,
  allowGitMetadataRead = false,
): Promise<SandboxRuntimeConfig> {
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
      deniedDomains:
        sandboxMode === "adaptive"
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
      allowWrite: uniquePaths(
        mode === "implement"
          ? boundProjectPolicy
            ? [...boundProjectPolicy.roots.shell, tempRoot]
            : [cwd, tempRoot]
          : [tempRoot],
      ),
      denyWrite: uniquePaths(denyWrite),
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  };
}

export function sanitizedSandboxEnvironment(
  cwd: string,
  tempRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {
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
    if (env[name]) safe[name] = env[name];
  }
  return safe;
}

function sandboxedBashOperations(tempRoot: string, env: NodeJS.ProcessEnv): BashOperations {
  let queue: Promise<void> = Promise.resolve();
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await executeSandboxed(command, cwd, tempRoot, env, onData, signal, timeout);
      } finally {
        release();
      }
    },
  };
}

async function executeSandboxed(
  command: string,
  cwd: string,
  tempRoot: string,
  env: NodeJS.ProcessEnv,
  onData: (data: Buffer) => void,
  signal: AbortSignal | undefined,
  timeout: number | undefined,
) {
  if (signal?.aborted) throw new Error("aborted");
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
  let timeoutHandle: NodeJS.Timeout | undefined;
  const stop = () => killProcessTree(child.pid);
  if (timeout !== undefined && timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout * 1000);
  }
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  }

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${timeout}`);
    return { exitCode };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", stop);
    SandboxManager.cleanupAfterCommand();
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

async function hostReadDenyPaths(cwd: string): Promise<string[]> {
  const home = await fs.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  if (!isInside(home, cwd)) return [home];

  const denied: string[] = [];
  let current = home;
  const relative = path.relative(home, cwd);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name !== segment) denied.push(path.join(current, entry.name));
    }
    current = path.join(current, segment);
  }
  return denied;
}

async function resolveGitMetadataPaths(cwd: string): Promise<string[]> {
  const paths = [path.join(cwd, ".git")];
  for (const args of [
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  ]) {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
      paths.push(path.resolve(stdout.trim()));
    } catch {
      // Non-Git workspaces still receive the lexical .git deny path.
    }
  }
  return uniquePaths(paths);
}

function credentialPaths(env: NodeJS.ProcessEnv): string[] {
  return [
    env.SWARM_PI_CODE_PLUGIN_AUTH_FILE,
    env.AWS_SHARED_CREDENTIALS_FILE,
    env.KUBECONFIG,
    path.join(os.homedir(), ".pi", "agent", "auth.json"),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
}

function executableReadPaths(cwd: string): string[] {
  return uniquePaths([
    path.dirname(process.execPath),
    path.join(cwd, "node_modules", ".bin"),
    ...directDeveloperToolPaths(),
  ]);
}

function sandboxPath(cwd: string): string {
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

function directDeveloperToolPaths(): string[] {
  const commandLineTools = "/Library/Developer/CommandLineTools/usr/bin";
  return process.platform === "darwin" && existsSync(commandLineTools) ? [commandLineTools] : [];
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
