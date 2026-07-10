import { parseArguments } from "./runner/args.js";
import { runCommand } from "./runner/run.js";
export async function main(argv = process.argv.slice(2)) {
    try {
        const args = parseArguments(argv);
        const result = await runCommand(args, process.cwd());
        const serialized = JSON.stringify(result, null, args.json ? 2 : 0);
        process.stdout.write(`${serialized}\n`);
        return "success" in result && !result.success ? 1 : 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        return 2;
    }
}
