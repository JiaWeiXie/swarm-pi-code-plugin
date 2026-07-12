import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, } from "@earendil-works/pi-coding-agent";
import { isProtectedWorkspacePath } from "../git/worktree.js";
import { assertPathAllowed, ProjectPolicyError } from "../policy/project-policy.js";
export async function assertMutationPath(cwd, candidate) {
    const lexicalRoot = path.resolve(cwd);
    const root = await fs.realpath(cwd);
    const absolute = path.resolve(cwd, candidate);
    assertInside(lexicalRoot, absolute);
    assertUnprotected(lexicalRoot, absolute);
    const existingAncestor = await closestExistingPath(absolute);
    try {
        if ((await fs.lstat(absolute)).isSymbolicLink()) {
            throw new Error(`Mutation path cannot be a symlink: ${candidate}`);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const realAncestor = await fs.realpath(existingAncestor);
    assertInside(root, realAncestor);
    return absolute;
}
export async function secureWriteFile(cwd, candidate, content) {
    const absolute = await assertMutationPath(cwd, candidate);
    const root = await fs.realpath(cwd);
    const parent = path.dirname(absolute);
    const identities = await captureDirectoryChain(root, parent);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let handle;
    try {
        handle = await fs.open(absolute, constants.O_WRONLY | noFollow);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        handle = await fs.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    }
    try {
        await assertDirectoryChainStable(identities);
        const descriptor = await handle.stat();
        const final = await fs.lstat(absolute);
        if (final.isSymbolicLink() || final.dev !== descriptor.dev || final.ino !== descriptor.ino) {
            throw new Error(`Mutation path changed during secure open: ${candidate}`);
        }
        await handle.truncate(0);
        await handle.writeFile(content);
        await handle.sync();
        await assertDirectoryChainStable(identities);
    }
    finally {
        await handle.close();
    }
}
async function secureReadFile(cwd, candidate) {
    const absolute = await assertReadPath(cwd, candidate);
    const root = await fs.realpath(cwd);
    const identities = await captureDirectoryChain(root, path.dirname(absolute));
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        await assertDirectoryChainStable(identities);
        const descriptor = await handle.stat();
        const final = await fs.lstat(absolute);
        if (final.isSymbolicLink() || final.dev !== descriptor.dev || final.ino !== descriptor.ino) {
            throw new Error(`Read path changed during secure open: ${candidate}`);
        }
        const content = await handle.readFile();
        await assertDirectoryChainStable(identities);
        return content;
    }
    finally {
        await handle.close();
    }
}
async function secureAccess(cwd, candidate, write) {
    const absolute = write ? await assertMutationPath(cwd, candidate) : await assertReadPath(cwd, candidate);
    const root = await fs.realpath(cwd);
    const identities = await captureDirectoryChain(root, path.dirname(absolute));
    const flags = (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(absolute, flags);
    try {
        await assertDirectoryChainStable(identities);
        const descriptor = await handle.stat();
        const final = await fs.lstat(absolute);
        if (final.isSymbolicLink() || final.dev !== descriptor.dev || final.ino !== descriptor.ino) {
            throw new Error(`Access path changed during secure open: ${candidate}`);
        }
    }
    finally {
        await handle.close();
    }
}
async function assertReadPath(cwd, candidate) {
    const lexicalRoot = path.resolve(cwd);
    const root = await fs.realpath(cwd);
    const absolute = path.resolve(cwd, candidate);
    assertInside(lexicalRoot, absolute);
    const existingAncestor = await closestExistingPath(absolute);
    const realAncestor = await fs.realpath(existingAncestor);
    assertInside(root, realAncestor);
    return absolute;
}
async function secureMkdir(cwd, candidate) {
    const absolute = await assertMutationPath(cwd, candidate);
    const root = await fs.realpath(cwd);
    const relative = path.relative(root, absolute);
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        const parentIdentity = await captureIdentity(current);
        const next = path.join(current, component);
        try {
            const existing = await fs.lstat(next);
            if (existing.isSymbolicLink() || !existing.isDirectory())
                throw new Error(`Directory component is not a stable directory: ${next}`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            await fs.mkdir(next, { mode: 0o700 });
        }
        await assertDirectoryChainStable([parentIdentity]);
        const created = await fs.lstat(next);
        if (created.isSymbolicLink() || !created.isDirectory())
            throw new Error(`Directory component changed during creation: ${next}`);
        current = next;
    }
}
async function captureDirectoryChain(root, target) {
    assertInside(root, target);
    const relative = path.relative(root, target);
    const identities = [await captureIdentity(root)];
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error(`Path component is not a stable directory: ${current}`);
        identities.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
    return identities;
}
async function captureIdentity(candidate) {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error(`Path component is not a stable directory: ${candidate}`);
    return { path: candidate, dev: stat.dev, ino: stat.ino };
}
async function assertDirectoryChainStable(identities) {
    for (const identity of identities) {
        const current = await fs.lstat(identity.path);
        if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
            throw new Error(`Directory identity changed during filesystem operation: ${identity.path}`);
        }
    }
}
function assertUnprotected(root, candidate) {
    const relative = path.relative(root, candidate);
    if (isProtectedWorkspacePath(relative)) {
        throw new Error(`Mutation path is protected by the delegated worker boundary: ${candidate}`);
    }
}
/**
 * Creates filesystem tools whose operations are constrained by the bound
 * project policy.  The SDK implementations remain responsible for tool
 * rendering, truncation, images, and search semantics.
 */
export function createScopedFilesystemTools(options) {
    const assertAllowed = async (operation, candidate) => {
        try {
            return await assertPathAllowed(options.boundProjectPolicy, operation, candidate);
        }
        catch (error) {
            if (error instanceof ProjectPolicyError) {
                try {
                    await options.onPolicyViolation?.(error);
                }
                catch {
                    // Preserve the structured policy rejection even if audit persistence fails.
                }
            }
            throw error;
        }
    };
    const read = createReadToolDefinition(options.cwd, {
        operations: {
            async access(file) {
                const scoped = await assertAllowed("read", file);
                await secureAccess(options.cwd, scoped, false);
            },
            async readFile(file) {
                const scoped = await assertAllowed("read", file);
                return secureReadFile(options.cwd, scoped);
            },
        },
    });
    const grep = withSearchPolicy(createGrepToolDefinition(options.cwd), assertAllowed, options.onPolicyViolation, options.boundProjectPolicy);
    const find = withSearchPolicy(createFindToolDefinition(options.cwd), assertAllowed, options.onPolicyViolation, options.boundProjectPolicy);
    const ls = withSearchPolicy(createLsToolDefinition(options.cwd), assertAllowed, options.onPolicyViolation, options.boundProjectPolicy);
    if (options.mode === "readonly") {
        return [read, grep, find, ls];
    }
    const write = createWriteToolDefinition(options.cwd, {
        operations: {
            async mkdir(directory) {
                const scoped = await assertMutationPath(options.cwd, directory);
                await assertAllowed("write", scoped);
                await secureMkdir(options.cwd, scoped);
            },
            async writeFile(file, content) {
                const scoped = await assertMutationPath(options.cwd, file);
                await assertAllowed("write", scoped);
                await secureWriteFile(options.cwd, scoped, content);
            },
        },
    });
    const edit = createEditToolDefinition(options.cwd, {
        operations: {
            async access(file) {
                const scoped = await assertMutationPath(options.cwd, file);
                await assertAllowed("write", scoped);
                await assertAllowed("read", scoped);
                await secureAccess(options.cwd, scoped, true);
            },
            async readFile(file) {
                const scoped = await assertMutationPath(options.cwd, file);
                await assertAllowed("read", scoped);
                return secureReadFile(options.cwd, scoped);
            },
            async writeFile(file, content) {
                const scoped = await assertMutationPath(options.cwd, file);
                await assertAllowed("write", scoped);
                await secureWriteFile(options.cwd, scoped, content);
            },
        },
    });
    return [read, grep, find, ls, write, edit];
}
function withSearchPolicy(definition, assertAllowed, onPolicyViolation, boundProjectPolicy) {
    const tool = definition;
    return {
        ...tool,
        async execute(...args) {
            // SDK tool executions receive a call id before their parameter object.
            // Locate the parameter object defensively so this remains transparent to
            // SDK context arguments added after signal/onUpdate.
            const params = args.find((value) => (typeof value === "object" && value !== null && !Array.isArray(value)));
            const searchRoot = await assertAllowed("search", typeof params?.path === "string" ? params.path : ".");
            const selectorKeys = tool.name === "grep"
                ? ["glob"]
                : tool.name === "find" ? ["pattern"] : [];
            for (const key of selectorKeys) {
                const selector = params?.[key];
                if (typeof selector === "string" && isUnsafeSearchSelector(selector)) {
                    const violation = new ProjectPolicyError({
                        event: "policy-rejected",
                        errorCode: "project-scope-violation",
                        stage: "preflight",
                        recoverable: false,
                        message: `Search selector is outside the execution workspace: ${selector}`,
                        preserved: [],
                        nextActions: [{ action: "review-project-policy", label: "Review project policy" }],
                        ...(boundProjectPolicy ? { policyHash: boundProjectPolicy.effective.hash, scopeHash: boundProjectPolicy.effective.scopeHash } : {}),
                        violatingPaths: [selector],
                    });
                    try {
                        await onPolicyViolation?.(violation);
                    }
                    catch {
                        // Preserve the structured policy rejection even if audit persistence fails.
                    }
                    throw violation;
                }
            }
            const tree = await assertSearchTreeHasNoSymlinks(searchRoot);
            const result = await tool.execute(...args);
            await assertDirectoryChainStable(tree);
            return result;
        },
    };
}
function isUnsafeSearchSelector(selector) {
    // Check every glob alternative boundary, not only the first character. This
    // rejects `{../outside/**,**/*.ts}` and `{src/**,/etc/**}` while allowing
    // harmless names such as `*..test.ts`.
    return /(?:^|[,{(|])\s*(?:[\\/]|[A-Za-z]:)/.test(selector)
        || /(?:^|[\\/{(|])\.\.(?:[\\/]|$)/.test(selector);
}
export function createScopedMutationTools(cwd) {
    const write = createWriteToolDefinition(cwd, {
        operations: {
            async mkdir(directory) {
                await secureMkdir(cwd, directory);
            },
            async writeFile(file, content) {
                await secureWriteFile(cwd, file, content);
            },
        },
    });
    const edit = createEditToolDefinition(cwd, {
        operations: {
            async access(file) {
                await secureAccess(cwd, file, true);
            },
            async readFile(file) {
                return secureReadFile(cwd, file);
            },
            async writeFile(file, content) {
                await secureWriteFile(cwd, file, content);
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
async function assertSearchTreeHasNoSymlinks(root) {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink())
        throw new Error(`Recursive search refuses symlinked root: ${root}`);
    if (!rootStat.isDirectory())
        return [];
    const pending = [root];
    const identities = [];
    while (pending.length > 0) {
        const directory = pending.pop();
        const identity = await captureIdentity(directory);
        identities.push(identity);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const candidate = path.join(directory, entry.name);
            const stat = await fs.lstat(candidate);
            if (stat.isSymbolicLink())
                throw new Error(`Recursive search refuses symlinked entries: ${candidate}`);
            if (stat.isDirectory())
                pending.push(candidate);
        }
    }
    return identities;
}
