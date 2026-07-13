#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = findRoot();
const SETUP_SCREENSHOTS = "docs/assets/setup";
const USER_DOCS = new Set(["README.md", "README.zh-TW.md"]);
const FOCUSED_DOC = "docs/configuration.md";
const DECLARATIONS = new Set([
  "documentation-not-applicable",
  "configuration-web-reviewed-current",
  "screenshots-reviewed-current",
]);

function findRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`Not a Git repository: ${error.message}`);
  }
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input: options.input,
  });
}

function parseArgs(argv) {
  const args = { mode: argv[0] ?? "worktree", format: "text", declarations: new Map() };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format") args.format = argv[++index];
    else if (value === "--base") args.base = argv[++index];
    else if (value === "--head") args.head = argv[++index];
    else if (value === "--declare") {
      const declaration = argv[++index];
      const reasonFlag = argv[++index];
      if (reasonFlag !== "--reason")
        throw new Error("--declare must be followed by --reason <text>");
      const reason = argv[++index];
      if (!DECLARATIONS.has(declaration)) throw new Error(`Unknown declaration: ${declaration}`);
      if (args.declarations.has(declaration))
        throw new Error(`Duplicate declaration: ${declaration}`);
      args.declarations.set(declaration, reason);
    } else if (value === "--help" || value === "-h") args.help = true;
    else if (value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    else if (index > 0) throw new Error(`Unexpected argument: ${value}`);
  }
  if (!new Set(["worktree", "staged", "ci"]).has(args.mode))
    throw new Error(`Unknown mode: ${args.mode}`);
  if (!["text", "json"].includes(args.format)) throw new Error(`Unknown format: ${args.format}`);
  if (args.mode === "ci" && (!args.base || !args.head))
    throw new Error("ci mode requires --base <sha> and --head <sha>");
  if (args.mode !== "ci" && (args.base || args.head))
    throw new Error("--base and --head are only valid in ci mode");
  for (const reason of args.declarations.values()) {
    if (typeof reason !== "string" || reason.trim().length < 15)
      throw new Error("Declaration reasons must contain at least 15 non-whitespace characters");
  }
  return args;
}

function emptyTree() {
  return git(["mktree"], { input: "" }).trim();
}

function validRevision(revision) {
  try {
    git(["rev-parse", "--verify", `${revision}^{object}`]);
    return true;
  } catch {
    return false;
  }
}

function parseNameStatus(raw) {
  const fields = raw.split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const oldPath = fields[index++];
    const newPath = renamed ? fields[index++] : oldPath;
    if (!status || !oldPath || !newPath)
      throw new Error("Malformed NUL-delimited Git name-status output");
    entries.push({ status: status[0], score: status.slice(1), oldPath, path: newPath });
  }
  return entries;
}

function changedEntries(mode, args) {
  if (mode === "ci") {
    if (!validRevision(args.base) || !validRevision(args.head))
      throw new Error("CI base/head revision is not available");
    return parseNameStatus(
      git(["diff", "--name-status", "-z", "--find-renames", "--find-copies", args.base, args.head]),
    );
  }
  const base = validRevision("HEAD") ? "HEAD" : emptyTree();
  const diffArgs = ["diff", "--name-status", "-z", "--find-renames", "--find-copies"];
  if (mode === "staged") diffArgs.push("--cached", base);
  else diffArgs.push(base);
  const entries = parseNameStatus(git(diffArgs));
  if (mode === "worktree") {
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const file of untracked.split("\0").filter(Boolean))
      entries.push({ status: "A", score: "", oldPath: file, path: file });
  }
  return entries;
}

function normalized(value) {
  return value.replaceAll(path.sep, "/");
}

function isUserDoc(file) {
  return (
    USER_DOCS.has(file) ||
    (file.startsWith("docs/") &&
      file.endsWith(".md") &&
      !file.startsWith("docs/research/") &&
      file !== "docs/documentation-sop.md")
  );
}

function isSetupScreenshot(file) {
  return file.startsWith(`${SETUP_SCREENSHOTS}/`) && file.endsWith(".png");
}

function classify(file) {
  const normalizedFile = normalized(file);
  return {
    userDoc: isUserDoc(normalizedFile),
    readme: USER_DOCS.has(normalizedFile),
    webDoc: normalizedFile === FOCUSED_DOC,
    screenshot: isSetupScreenshot(normalizedFile),
    webSource: normalizedFile.startsWith("src/web/"),
    uiSource: normalizedFile === "src/web/ui.ts",
    configSource:
      normalizedFile === "src/state/model-config.ts" || normalizedFile.startsWith("src/providers/"),
    sharedConfigSource: [
      "src/orchestration/roles.ts",
      "src/state/state.ts",
      "src/core/contracts.ts",
      "src/runner/args.ts",
    ].includes(normalizedFile),
    functional:
      (normalizedFile.startsWith("src/") && !normalizedFile.startsWith("src/web/")) ||
      (normalizedFile.startsWith("plugins/swarm-pi-code-plugin/") &&
        !normalizedFile.startsWith("plugins/swarm-pi-code-plugin/runtime/")) ||
      ["package.json", "package-lock.json", "mise.toml"].includes(normalizedFile),
  };
}

function snapshotFiles(mode, revision) {
  if (mode === "worktree") {
    return git(["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .concat(git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))
      .filter((file) => fs.existsSync(path.resolve(ROOT, file)));
  }
  const tree = mode === "staged" ? ":" : revision;
  if (mode === "staged") return git(["ls-files", "-z", "--cached"]).split("\0").filter(Boolean);
  return git(["ls-tree", "-r", "--name-only", "-z", tree]).split("\0").filter(Boolean);
}

function readSnapshot(mode, revision, file) {
  if (mode === "worktree") {
    const absolute = path.resolve(ROOT, file);
    if (!absolute.startsWith(`${ROOT}${path.sep}`) && absolute !== ROOT) return null;
    try {
      return fs.readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  }
  try {
    return git(["show", `${mode === "staged" ? ":" : `${revision}:`}${file}`]);
  } catch {
    return null;
  }
}

function localImageTarget(raw, markdownFile) {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  if (/^(?:https?:|data:)/i.test(target)) return { remote: true };
  target = target.split(/[?#]/, 1)[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    return { error: `Invalid encoded image path: ${raw}` };
  }
  if (target.startsWith("/")) return { error: `Absolute image path is not allowed: ${raw}` };
  const absolute = path.resolve(ROOT, path.dirname(markdownFile), target);
  if (!absolute.startsWith(`${ROOT}${path.sep}`))
    return { error: `Image path escapes repository: ${raw}` };
  return { file: normalized(path.relative(ROOT, absolute)) };
}

function imageReferences(markdown, markdownFile) {
  const found = [];
  const definitions = new Map();
  for (const match of markdown.matchAll(/^\s*\[([^\]]+)\]:\s*(<[^>]+>|\S+)/gim))
    definitions.set(match[1].trim().toLowerCase(), match[2]);
  const inline = /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const match of markdown.matchAll(inline)) found.push(match[1]);
  for (const match of markdown.matchAll(/!\[[^\]]*\]\[([^\]]*)\]/g)) {
    const key = (match[1] || "").trim().toLowerCase();
    if (definitions.has(key)) found.push(definitions.get(key));
  }
  for (const match of markdown.matchAll(
    /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gim,
  ))
    found.push(match[1] || match[2] || match[3]);
  return found.map((raw) => ({ raw, ...localImageTarget(raw, markdownFile) }));
}

function parseDeclarations(mode, args, revision) {
  const declarations = new Map(args.declarations);
  if (mode === "ci") {
    const message = git(["log", "-1", "--format=%B", revision]);
    const lines = message.split(/\r?\n/);
    const trailers = new Map();
    for (const line of lines) {
      const match = line.match(/^([A-Za-z-]+):\s*(.*)$/);
      if (match) trailers.set(match[1].toLowerCase(), match[2].trim());
    }
    for (const match of message.matchAll(/^([A-Za-z-]+):\s*(.+)$/gim)) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      const mapping = {
        "documentation-impact": "documentation-not-applicable",
        "configuration-web-impact": "configuration-web-reviewed-current",
        "screenshot-impact": "screenshots-reviewed-current",
      };
      if (!mapping[key]) continue;
      const accepted = key === "documentation-impact" ? "not-applicable" : "reviewed-current";
      if (value !== accepted) throw new Error(`Invalid ${match[1]} trailer value: ${value}`);
      const reason = trailers.get(`${key}-reason`);
      if (!reason || reason.trim().length < 15)
        throw new Error(`Missing meaningful ${match[1]}-Reason trailer`);
      declarations.set(mapping[key], reason);
    }
  }
  return declarations;
}

function evaluate(mode, args) {
  const entries = changedEntries(mode, args);
  const revision = mode === "ci" ? args.head : mode === "staged" ? ":" : null;
  const changedPaths = [...new Set(entries.flatMap((entry) => [entry.oldPath, entry.path]))].map(
    normalized,
  );
  const activePaths = entries
    .filter((entry) => entry.status !== "D")
    .map((entry) => normalized(entry.path));
  const declarations = parseDeclarations(mode, args, revision);
  const flags = changedPaths.map((file) => ({ file, ...classify(file) }));
  const functional = flags.some((flag) => flag.functional);
  const webSource = flags.some((flag) => flag.webSource);
  const uiSource = flags.some((flag) => flag.uiSource);
  const configSource = flags.some((flag) => flag.configSource);
  const sharedConfigSource = flags.some((flag) => flag.sharedConfigSource);
  const readmes = new Set(activePaths.filter((file) => USER_DOCS.has(file)));
  const focusedDocChanged = activePaths.includes(FOCUSED_DOC);
  const screenshotChanged = activePaths.some(isSetupScreenshot);
  const missing = [];
  const advisories = [];
  if (functional && !declarations.has("documentation-not-applicable")) {
    if (!readmes.has("README.md")) missing.push("README.md");
    if (!readmes.has("README.zh-TW.md")) missing.push("README.zh-TW.md");
  }
  if (webSource && !focusedDocChanged && !declarations.has("configuration-web-reviewed-current"))
    missing.push(FOCUSED_DOC);
  if (configSource && !webSource && !declarations.has("configuration-web-reviewed-current"))
    missing.push("src/web/** (Configuration Web review)");
  if (sharedConfigSource && !webSource)
    advisories.push(
      "Shared configuration code changed; confirm whether the Configuration Web UI must change.",
    );
  if (uiSource && !screenshotChanged && !declarations.has("screenshots-reviewed-current"))
    missing.push(`${SETUP_SCREENSHOTS}/<scenario>.png or Screenshot-Impact declaration`);

  const files = snapshotFiles(mode, revision);
  const markdownFiles = files.filter((file) => isUserDoc(file));
  const screenshotFiles = files.filter(isSetupScreenshot);
  const referenced = new Set();
  const imageErrors = [];
  for (const markdownFile of markdownFiles) {
    const content = readSnapshot(mode, revision, markdownFile) ?? "";
    for (const reference of imageReferences(content, markdownFile)) {
      if (reference.error) imageErrors.push(`${markdownFile}: ${reference.error}`);
      if (reference.file) {
        referenced.add(reference.file);
        if (!files.includes(reference.file))
          imageErrors.push(`${markdownFile}: missing image ${reference.file}`);
      }
    }
  }
  for (const image of screenshotFiles)
    if (!referenced.has(image)) imageErrors.push(`Unreferenced setup screenshot: ${image}`);
  const result = missing.length || imageErrors.length ? "fail" : "pass";
  return {
    mode,
    result,
    exitCode: result === "fail" ? 1 : 0,
    changedPaths,
    triggers: flags
      .filter(
        (flag) =>
          flag.functional ||
          flag.webSource ||
          flag.configSource ||
          flag.sharedConfigSource ||
          flag.uiSource,
      )
      .map((flag) => flag.file),
    missing: [...new Set(missing)],
    imageErrors,
    advisories,
    declarations: Object.fromEntries(declarations),
    screenshotsRequired: uiSource && !declarations.has("screenshots-reviewed-current"),
  };
}

function usage() {
  return [
    "Usage:",
    "  mise exec -- node scripts/check-documentation-impact.mjs worktree [--format text|json]",
    "  mise exec -- node scripts/check-documentation-impact.mjs staged [--format text|json]",
    "  mise exec -- node scripts/check-documentation-impact.mjs ci --base <sha> --head <sha> [--format text|json]",
    "  --declare <documentation-not-applicable|configuration-web-reviewed-current|screenshots-reviewed-current> --reason <text>",
  ].join("\n");
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const report = evaluate(args.mode, args);
    if (args.format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`Documentation impact (${args.mode}): ${report.result}\n`);
      if (report.changedPaths.length)
        process.stdout.write(`Changed paths: ${report.changedPaths.join(", ")}\n`);
      if (report.missing.length) process.stdout.write(`Missing: ${report.missing.join(", ")}\n`);
      if (report.imageErrors.length)
        process.stdout.write(`Images: ${report.imageErrors.join(" | ")}\n`);
      for (const advisory of report.advisories) process.stdout.write(`Advisory: ${advisory}\n`);
      if (report.screenshotsRequired)
        process.stdout.write("Screenshot generation is required: mise run docs-screenshots\n");
    }
    return report.exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
}

process.exitCode = main();
