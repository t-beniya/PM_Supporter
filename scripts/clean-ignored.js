#!/usr/bin/env node
// @ts-check

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PROTECTED_PATTERNS = [
  ".tools/",
  "node_modules/",
  ".env",
  ".env.local"
];

const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
let mode = "dry-run";
let includeProtected = false;

for (const arg of args) {
  if (arg === "--dry-run" || arg === "-n") {
    mode = "dry-run";
  } else if (arg === "--check") {
    mode = "check";
  } else if (arg === "--force" || arg === "-f") {
    mode = "force";
  } else if (arg === "--all") {
    includeProtected = true;
  } else if (arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unexpected argument: ${arg}`);
    printHelp();
    process.exit(2);
  }
}

const preview = runGitClean(["-X", "-d", "-n"]);
if (preview.status !== 0) {
  exitWithGitResult(preview);
}

const ignoredPaths = preview.stdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .map(parseGitCleanLine)
  .filter(Boolean);
const cleanablePaths = includeProtected
  ? ignoredPaths
  : ignoredPaths.filter((ignoredPath) => !isProtected(ignoredPath));
const protectedPaths = includeProtected
  ? []
  : ignoredPaths.filter((ignoredPath) => isProtected(ignoredPath));

if (cleanablePaths.length === 0) {
  console.log("No ignored files or directories to clean.");
  if (protectedPaths.length > 0) {
    console.log("");
    console.log("Protected ignored paths left in place:");
    printPaths(protectedPaths, console.log);
    console.log("");
    console.log("Use `npm run clean:ignored:dry-run:all` to include protected paths.");
  }
  process.exit(0);
}

if (mode === "check") {
  console.error("Ignored files or directories were found:");
  printPaths(cleanablePaths, console.error);
  console.error("");
  console.error("Run `npm run clean:ignored:dry-run` to review them.");
  printRemovalHint(console.error);
  process.exit(1);
}

if (mode === "dry-run") {
  console.log("Ignored files or directories that would be removed:");
  printPaths(cleanablePaths, console.log);
  if (protectedPaths.length > 0) {
    console.log("");
    console.log("Protected ignored paths left in place:");
    printPaths(protectedPaths, console.log);
  }
  console.log("");
  printRemovalHint(console.log);
  process.exit(0);
}

const clean = runGitClean(["-X", "-d", "-f", "--", ...cleanablePaths]);
if (clean.status !== 0) {
  exitWithGitResult(clean);
}

if (clean.stdout) {
  process.stdout.write(clean.stdout);
}
if (clean.stderr) {
  process.stderr.write(clean.stderr);
}

function runGitClean(cleanArgs) {
  return spawnSync("git", ["clean", ...cleanArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false
  });
}

/**
 * @param {string} line
 */
function parseGitCleanLine(line) {
  return line.replace(/^Would remove /, "").replace(/^Removing /, "");
}

/**
 * @param {string} ignoredPath
 */
function isProtected(ignoredPath) {
  const normalizedPath = ignoredPath.replace(/\\/g, "/");
  return PROTECTED_PATTERNS.some((pattern) => {
    if (pattern.endsWith("/")) {
      return normalizedPath === pattern || normalizedPath.startsWith(pattern);
    }
    return normalizedPath === pattern || normalizedPath.startsWith(`${pattern}.`);
  });
}

/**
 * @param {(message: string) => void} writeLine
 */
function printRemovalHint(writeLine) {
  if (includeProtected) {
    writeLine("Run `npm run clean:ignored:all` to remove them.");
    return;
  }
  writeLine("Run `npm run clean:ignored` to remove them.");
}

/**
 * @param {Array<string>} paths
 * @param {(message: string) => void} writeLine
 */
function printPaths(paths, writeLine) {
  for (const ignoredPath of paths) {
    writeLine(`  ${ignoredPath}`);
  }
}

/**
 * @param {{ error?: Error, stdout?: string, stderr?: string, status: number | null }} result
 */
function exitWithGitResult(result) {
  if (result.error) {
    console.error(result.error.message);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status === null ? 1 : result.status);
}

function printHelp() {
  console.log(`Usage: node ./scripts/clean-ignored.js [--dry-run|--check|--force] [--all]

Modes:
  --dry-run, -n  Show ignored files and directories that would be removed.
  --check       Fail when ignored files or directories are present.
  --force, -f   Remove ignored files and directories.

Options:
  --all          Include protected paths such as .tools/, node_modules/, and .env files.
`);
}
