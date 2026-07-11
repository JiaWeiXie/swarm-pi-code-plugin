import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assessWorkspace } from "../git/worktree.js";
import { resolveStateDir } from "../state/state.js";
const CONTINUATION_TTL_MS = 24 * 60 * 60_000;
export async function createContinuation(cwd, request) {
    const now = Date.now();
    const record = {
        id: randomUUID(),
        request: structuredClone(request),
        workspaceFingerprint: (await assessWorkspace(cwd)).fingerprint,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + CONTINUATION_TTL_MS).toISOString(),
    };
    await writeContinuation(cwd, record);
    return record;
}
export async function readContinuation(cwd, id) {
    const file = await continuationFile(cwd, id);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (record.id !== id || record.consumedAt)
        throw new Error(`Continuation is unavailable: ${id}`);
    if (Date.parse(record.expiresAt) <= Date.now())
        throw new Error(`Continuation expired: ${id}`);
    const current = await assessWorkspace(record.request.cwd);
    if (current.fingerprint !== record.workspaceFingerprint)
        throw new Error(`Continuation workspace changed: ${id}`);
    return record;
}
export async function consumeContinuation(cwd, id) {
    const record = await readContinuation(cwd, id);
    record.consumedAt = new Date().toISOString();
    await writeContinuation(cwd, record);
}
async function continuationFile(cwd, id) {
    if (!/^[a-f0-9-]{36}$/.test(id))
        throw new Error("Invalid continuation id");
    return path.join(await resolveStateDir(cwd), "continuations", `${id}.json`);
}
async function writeContinuation(cwd, record) {
    const file = await continuationFile(cwd, record.id);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
    }
    finally {
        await fs.rm(temporary, { force: true });
    }
}
