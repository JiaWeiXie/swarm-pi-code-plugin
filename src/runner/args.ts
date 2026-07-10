import type { Host, TaskKind } from "../core/contracts.js";

export type RunnerCommand = "models" | TaskKind;

export interface RunnerArguments {
  command: RunnerCommand;
  host?: Host;
  promptFile?: string;
  model?: string;
  json: boolean;
}

const COMMANDS = new Set<RunnerCommand>([
  "models",
  "ask",
  "review",
  "plan",
  "implement",
  "orchestrate",
]);

export function parseArguments(argv: string[]): RunnerArguments {
  const command = argv[0] as RunnerCommand | undefined;
  if (!command || !COMMANDS.has(command)) {
    throw new Error(`Unknown or missing command: ${command ?? "<none>"}`);
  }

  const parsed: RunnerArguments = { command, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--json":
        parsed.json = true;
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
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (command !== "models" && !parsed.host) {
    throw new Error(`--host is required for ${command}`);
  }
  if (
    (command === "ask" || command === "plan" || command === "implement" || command === "orchestrate") &&
    !parsed.promptFile
  ) {
    throw new Error(`--prompt-file is required for ${command}`);
  }

  return parsed;
}

function parseHost(value: string): Host {
  if (value !== "claude" && value !== "codex") {
    throw new Error(`Invalid host: ${value}`);
  }
  return value;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
