import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { captureWorktreeChanges, inspectWorktree } from "./worktree.js";
import type { ReviewProfile, ReviewScope } from "../runner/args.js";

const execFileAsync = promisify(execFile);

export async function buildReviewRequest(
  cwd: string,
  options: {
    base?: string | undefined;
    scope?: ReviewScope | undefined;
    reviewProfile?: ReviewProfile | undefined;
    allowedPath?: ((relativePath: string) => Promise<boolean>) | undefined;
  },
): Promise<string> {
  const scope = options.scope ?? "auto";
  const profile = options.reviewProfile ?? "standard";
  const inspection = await inspectWorktree(cwd);
  const useWorkingTree = scope === "working-tree" || (scope === "auto" && !inspection.clean);
  if (useWorkingTree) {
    const changes = await captureWorktreeChanges(cwd);
    if (
      options.allowedPath &&
      !(await everyPathAllowed(
        changes.entries.map((entry) => entry.path),
        options.allowedPath,
      ))
    ) {
      throw new Error("Review includes changed paths outside the effective project read roots");
    }
    return `${reviewProfilePreamble(profile)}\n\nReview the current working tree changes.\n\nStatus:\n${formatStatus(changes.entries)}\n\nDiff:\n${changes.diff || "(no textual diff)"}`;
  }

  const base = options.base ?? "HEAD^";
  if (options.allowedPath) {
    const changedPaths = await branchChangedPaths(cwd, base);
    if (!(await everyPathAllowed(changedPaths, options.allowedPath))) {
      throw new Error("Review includes changed paths outside the effective project read roots");
    }
  }
  const diff = await branchDiff(cwd, base);
  return `${reviewProfilePreamble(profile)}\n\nReview branch changes relative to ${base}.\n\nDiff:\n${diff || "(no changes)"}`;
}

function reviewProfilePreamble(profile: ReviewProfile): string {
  if (profile === "standard") return "[REVIEW_PROFILE]\nstandard";
  return [
    "[REVIEW_PROFILE]",
    "lean",
    "This review uses the validated lean panel. It is read-only and reports only behavior-preserving simplification opportunities.",
  ].join("\n");
}

async function everyPathAllowed(
  paths: string[],
  allowedPath: (relativePath: string) => Promise<boolean>,
): Promise<boolean> {
  for (const relativePath of paths) {
    if (!(await allowedPath(relativePath))) return false;
  }
  return true;
}

async function branchChangedPaths(cwd: string, base: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...HEAD`, "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch (error) {
    if (base !== "HEAD^") throw error;
    const { stdout } = await execFileAsync(
      "git",
      ["show", "--format=", "--name-only", "HEAD", "--"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  }
}

async function branchDiff(cwd: string, base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", `${base}...HEAD`, "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (base !== "HEAD^") throw error;
    const { stdout } = await execFileAsync("git", ["show", "--format=", "--patch", "HEAD", "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }
}

function formatStatus(entries: Array<{ status: string; path: string }>): string {
  return entries.length
    ? entries.map((entry) => `${entry.status} ${entry.path}`).join("\n")
    : "(clean)";
}
