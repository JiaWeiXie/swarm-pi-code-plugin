#!/usr/bin/env node
// Generates the network-disabled 36-job manifest; execution remains explicit.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(await fs.readFile(path.join(root, "benchmarks/prewalk/fixtures.json"), "utf8"));
const jobs = [];
for (const fixture of config.fixtures) for (const arm of config.arms) for (let repeat = 1; repeat <= config.repeats; repeat += 1) jobs.push({ fixture, arm, repeat, network: "disabled", gitHistory: "hidden", hiddenOracle: true });
if (process.argv.includes("--execute")) throw new Error("Benchmark execution requires an explicit external harness with locked models and hidden oracle.");
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), fixtureCount: config.fixtures.length, jobCount: jobs.length, randomizationSeed: crypto.randomUUID(), promotionGate: { hiddenOraclePassDeltaAtLeast: -1, newPolicyViolations: 0, medianUncachedInputReductionPct: 25, medianRepeatedReadReductionPct: 30, p50CompletionTimeReductionPct: 15 }, jobs }, null, 2)}\n`);
