import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureWorktreeChanges, inspectWorktree } from "./worktree.js";
const execFileAsync = promisify(execFile);
export async function buildReviewRequest(cwd, options) {
    const scope = options.scope ?? "auto";
    const inspection = await inspectWorktree(cwd);
    const useWorkingTree = scope === "working-tree" || (scope === "auto" && !inspection.clean);
    if (useWorkingTree) {
        const changes = await captureWorktreeChanges(cwd);
        return `Review the current working tree changes.\n\nStatus:\n${formatStatus(changes.entries)}\n\nDiff:\n${changes.diff || "(no textual diff)"}`;
    }
    const base = options.base ?? "HEAD^";
    const diff = await branchDiff(cwd, base);
    return `Review branch changes relative to ${base}.\n\nDiff:\n${diff || "(no changes)"}`;
}
async function branchDiff(cwd, base) {
    try {
        const { stdout } = await execFileAsync("git", ["diff", `${base}...HEAD`, "--"], {
            cwd,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
    catch (error) {
        if (base !== "HEAD^")
            throw error;
        const { stdout } = await execFileAsync("git", ["show", "--format=", "--patch", "HEAD", "--"], {
            cwd,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    }
}
function formatStatus(entries) {
    return entries.length ? entries.map((entry) => `${entry.status} ${entry.path}`).join("\n") : "(clean)";
}
