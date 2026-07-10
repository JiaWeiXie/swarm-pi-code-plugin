import { parseArguments } from "./runner/args.js";
import { runCommand } from "./runner/run.js";
import { startConfigurationServer } from "./web/configuration-server.js";
export async function main(argv = process.argv.slice(2)) {
    try {
        const args = parseArguments(argv);
        if (args.command === "configure") {
            const session = await startConfigurationServer(process.cwd(), {
                host: args.host,
                port: args.port,
                openBrowser: !args.noOpen,
                mode: args.configurationSection === "project" ? "project" : "full",
            });
            process.stdout.write(args.json
                ? `${JSON.stringify({ event: "ready", url: session.url })}\n`
                : `Swarm Pi setup is available at:\n${session.url}\n\nWaiting for the browser configuration to finish...\n`);
            const completion = await session.completion;
            process.stdout.write(`${JSON.stringify(completion, null, args.json ? 2 : 0)}\n`);
            return completion.status === "timed-out" ? 1 : 0;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        const delegated = args.command === "ask" || args.command === "review" ||
            args.command === "plan" || args.command === "implement" || args.command === "orchestrate";
        if (delegated) {
            process.once("SIGINT", abort);
            process.once("SIGTERM", abort);
        }
        const result = await runCommand(args, process.cwd(), undefined, { signal: controller.signal }).finally(() => {
            process.removeListener("SIGINT", abort);
            process.removeListener("SIGTERM", abort);
        });
        const serialized = JSON.stringify(result, null, args.json ? 2 : 0);
        process.stdout.write(`${serialized}\n`);
        if ("event" in result && result.event === "wait-timed-out")
            return 3;
        return "success" in result && !result.success ? 1 : 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        return 2;
    }
}
