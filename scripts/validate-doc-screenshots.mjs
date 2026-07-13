#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const directory = path.resolve(
  root,
  process.argv.includes("--directory")
    ? process.argv[process.argv.indexOf("--directory") + 1]
    : "docs/assets/setup",
);
const expected = [
  "01-empty-connections.png",
  "02-endpoint-discovery.png",
  "03-project-setup.png",
  "04-role-routing.png",
  "05-execution-safety.png",
  "06-review.png",
];

async function main() {
  const entries = await fs.readdir(directory).catch(() => []);
  const actual = entries.filter((entry) => entry.endsWith(".png")).sort();
  const unexpected = actual.filter((entry) => !expected.includes(entry));
  if (unexpected.length) throw new Error(`Unexpected setup screenshots: ${unexpected.join(", ")}`);
  for (const file of expected) {
    const bytes = await fs.readFile(path.join(directory, file));
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error(`${file} is not a PNG`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== 1440 || height !== 1000)
      throw new Error(`${file} must be 1440x1000, got ${width}x${height}`);
  }
  console.log(`Validated ${expected.length} documentation screenshots at 1440x1000.`);
}

main().catch((error) => {
  console.error(`Screenshot validation failed: ${error.message}`);
  process.exitCode = 1;
});
