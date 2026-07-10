import { parseArguments } from "./runner/args.js";
import { runCommand } from "./runner/run.js";
import { startConfigurationServer } from "./web/configuration-server.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args.command === "configure") {
      const session = await startConfigurationServer(process.cwd(), {
        host: args.host,
        port: args.port,
        openBrowser: !args.noOpen,
      });
      process.stdout.write(
        args.json
          ? `${JSON.stringify({ event: "ready", url: session.url })}\n`
          : `Swarm Pi model setup is available at:\n${session.url}\n\nWaiting for the browser configuration to finish...\n`,
      );
      const completion = await session.completion;
      process.stdout.write(`${JSON.stringify(completion, null, args.json ? 2 : 0)}\n`);
      return completion.status === "timed-out" ? 1 : 0;
    }
    const result = await runCommand(args, process.cwd());
    const serialized = JSON.stringify(result, null, args.json ? 2 : 0);
    process.stdout.write(`${serialized}\n`);

    return "success" in result && !result.success ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}
