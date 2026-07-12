import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import type { BoundProjectPolicy } from "../core/contracts.js";
import { isProtectedWorkspacePath } from "../git/worktree.js";
import { assertPathAllowed, ProjectPolicyError } from "../policy/project-policy.js";

export async function assertMutationPath(cwd: string, candidate: string): Promise<string> {
  const lexicalRoot = path.resolve(cwd);
  const root = await fs.realpath(cwd);
  const absolute = path.resolve(cwd, candidate);
  assertInside(lexicalRoot, absolute);
  assertUnprotected(lexicalRoot, absolute);

  const existingAncestor = await closestExistingPath(absolute);
  const realAncestor = await fs.realpath(existingAncestor);
  assertInside(root, realAncestor);
  return absolute;
}

function assertUnprotected(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (isProtectedWorkspacePath(relative)) {
    throw new Error(`Mutation path is protected by the delegated worker boundary: ${candidate}`);
  }
}

export interface CreateScopedFilesystemToolsOptions {
  cwd: string;
  mode: "readonly" | "implement";
  boundProjectPolicy: BoundProjectPolicy;
  onPolicyViolation?: (error: ProjectPolicyError) => void;
}

/**
 * Creates filesystem tools whose operations are constrained by the bound
 * project policy.  The SDK implementations remain responsible for tool
 * rendering, truncation, images, and search semantics.
 */
export function createScopedFilesystemTools(
  options: CreateScopedFilesystemToolsOptions,
): NonNullable<CreateAgentSessionOptions["customTools"]> {
  const assertAllowed = async (
    operation: "read" | "search" | "write",
    candidate: string,
  ): Promise<string> => {
    try {
      return await assertPathAllowed(options.boundProjectPolicy, operation, candidate);
    } catch (error) {
      if (error instanceof ProjectPolicyError) options.onPolicyViolation?.(error);
      throw error;
    }
  };

  const read = createReadToolDefinition(options.cwd, {
    operations: {
      async access(file) {
        await fs.access(await assertAllowed("read", file), constants.R_OK);
      },
      async readFile(file) {
        return fs.readFile(await assertAllowed("read", file));
      },
    },
  });
  const grep = withSearchPolicy(createGrepToolDefinition(options.cwd), assertAllowed);
  const find = withSearchPolicy(createFindToolDefinition(options.cwd), assertAllowed);
  const ls = withSearchPolicy(createLsToolDefinition(options.cwd), assertAllowed);

  if (options.mode === "readonly") {
    return [read, grep, find, ls] as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>;
  }

  const write = createWriteToolDefinition(options.cwd, {
    operations: {
      async mkdir(directory) {
        const scoped = await assertMutationPath(options.cwd, directory);
        await assertAllowed("write", scoped);
        await fs.mkdir(scoped, { recursive: true });
      },
      async writeFile(file, content) {
        const scoped = await assertMutationPath(options.cwd, file);
        await assertAllowed("write", scoped);
        await fs.writeFile(scoped, content);
      },
    },
  });
  const edit = createEditToolDefinition(options.cwd, {
    operations: {
      async access(file) {
        const scoped = await assertMutationPath(options.cwd, file);
        await assertAllowed("write", scoped);
        await assertAllowed("read", scoped);
        await fs.access(scoped, constants.R_OK | constants.W_OK);
      },
      async readFile(file) {
        const scoped = await assertMutationPath(options.cwd, file);
        await assertAllowed("read", scoped);
        return fs.readFile(scoped);
      },
      async writeFile(file, content) {
        const scoped = await assertMutationPath(options.cwd, file);
        await assertAllowed("write", scoped);
        await fs.writeFile(scoped, content);
      },
    },
  });
  return [read, grep, find, ls, write, edit] as unknown as NonNullable<
    CreateAgentSessionOptions["customTools"]
  >;
}

type PolicyAssertion = (operation: "read" | "search" | "write", candidate: string) => Promise<string>;
type ExecutableTool = { execute: (...args: unknown[]) => unknown };

function withSearchPolicy(definition: unknown, assertAllowed: PolicyAssertion): unknown {
  const tool = definition as ExecutableTool;
  return {
    ...tool,
    async execute(...args: unknown[]) {
      // SDK tool executions receive a call id before their parameter object.
      // Locate the parameter object defensively so this remains transparent to
      // SDK context arguments added after signal/onUpdate.
      const params = args.find((value): value is { path?: unknown } => (
        typeof value === "object" && value !== null && !Array.isArray(value)
      ));
      await assertAllowed("search", typeof params?.path === "string" ? params.path : ".");
      return tool.execute(...args);
    },
  };
}

export function createScopedMutationTools(
  cwd: string,
): NonNullable<CreateAgentSessionOptions["customTools"]> {
  const write = createWriteToolDefinition(cwd, {
    operations: {
      async mkdir(directory) {
        await fs.mkdir(await assertMutationPath(cwd, directory), { recursive: true });
      },
      async writeFile(file, content) {
        await fs.writeFile(await assertMutationPath(cwd, file), content);
      },
    },
  });
  const edit = createEditToolDefinition(cwd, {
    operations: {
      async access(file) {
        await fs.access(await assertMutationPath(cwd, file), constants.R_OK | constants.W_OK);
      },
      async readFile(file) {
        return fs.readFile(await assertMutationPath(cwd, file));
      },
      async writeFile(file, content) {
        await fs.writeFile(await assertMutationPath(cwd, file), content);
      },
    },
  });
  return [write, edit] as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`Mutation path is outside the assigned worktree: ${candidate}`);
}

async function closestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
