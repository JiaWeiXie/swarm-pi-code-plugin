import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveStateDir, updateState } from "./state.js";
export async function startJob(cwd, input) {
    const jobId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const directory = await jobDirectory(cwd, jobId);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
        writeJson(path.join(directory, "request.json"), {
            id: jobId,
            host: input.host,
            kind: input.kind,
            cwd: input.cwd,
            startedAt: new Date().toISOString(),
        }),
        fs.writeFile(path.join(directory, "prompt.md"), input.prompt, "utf8"),
    ]);
    await updateState(cwd, (state) => {
        state.jobs.push({ id: jobId, host: input.host, kind: input.kind, status: "running" });
    });
    return jobId;
}
export async function finishJob(cwd, jobId, result, diff) {
    const directory = await jobDirectory(cwd, jobId);
    await fs.mkdir(directory, { recursive: true });
    await writeJson(path.join(directory, "result.json"), result);
    if (diff)
        await fs.writeFile(path.join(directory, "changes.patch"), diff, "utf8");
    await updateState(cwd, (state) => {
        const existing = state.jobs.find((job) => job.id === jobId);
        const summary = {
            id: jobId,
            host: result.host,
            kind: result.kind,
            status: result.status,
            model: result.model,
            finishedAt: new Date().toISOString(),
        };
        if (existing)
            Object.assign(existing, summary);
        else
            state.jobs.push(summary);
    });
}
export async function jobDirectory(cwd, jobId) {
    return path.join(await resolveStateDir(cwd), "jobs", jobId);
}
async function writeJson(file, value) {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
}
