import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createEditToolDefinition, createWriteToolDefinition, } from "@earendil-works/pi-coding-agent";
import { isProtectedWorkspacePath } from "../git/worktree.js";
export async function assertMutationPath(cwd, candidate) {
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
function assertUnprotected(root, candidate) {
    const relative = path.relative(root, candidate);
    if (isProtectedWorkspacePath(relative)) {
        throw new Error(`Mutation path is protected by the delegated worker boundary: ${candidate}`);
    }
}
export function createScopedMutationTools(cwd) {
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
    return [write, edit];
}
function assertInside(root, candidate) {
    const relative = path.relative(root, candidate);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        return;
    }
    throw new Error(`Mutation path is outside the assigned worktree: ${candidate}`);
}
async function closestExistingPath(candidate) {
    let current = candidate;
    while (true) {
        try {
            await fs.lstat(current);
            return current;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = path.dirname(current);
            if (parent === current)
                throw error;
            current = parent;
        }
    }
}
