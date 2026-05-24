// @ts-check

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_FILE_BYTES = 1024 * 1024;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const MERGE_CONFLICT_PATTERN = /^(<<<<<<<|=======|>>>>>>>) /m;
const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

const repoRoot = path.resolve(__dirname, "..");
const inputFiles = process.argv.slice(2);
const files = inputFiles.length ? inputFiles : gitFiles();
const allFiles = gitFiles();
const problems = [];
let changed = false;

checkCaseConflicts(allFiles);

for (const file of files) {
  const fullPath = path.normalize(path.resolve(repoRoot, file));
  const normalizedRoot = path.normalize(repoRoot) + path.sep;
  if (!fullPath.startsWith(normalizedRoot) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    continue;
  }

  const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");
  checkLargeFile(relativePath, fullPath);
  checkIllegalWindowsName(relativePath);

  const buffer = fs.readFileSync(fullPath);
  if (isBinary(buffer)) {
    continue;
  }

  let text = buffer.toString("utf8");
  checkJson(relativePath, text);
  checkYamlBasics(relativePath, text);
  checkMergeConflict(relativePath, text);
  checkPrivateKey(relativePath, text);

  const fixed = fixText(text);
  if (fixed !== text) {
    fs.writeFileSync(fullPath, fixed, "utf8");
    changed = true;
    text = fixed;
  }
}

if (changed) {
  problems.push("One or more files were normalized. Re-run pre-commit.");
}

if (problems.length) {
  for (const problem of problems) {
    console.error(problem);
  }
  process.exit(1);
}

function gitFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * @param {Array<string>} trackedFiles
 */
function checkCaseConflicts(trackedFiles) {
  const seen = new Map();
  for (const file of trackedFiles) {
    const key = file.toLowerCase();
    const existing = seen.get(key);
    if (existing && existing !== file) {
      problems.push(`Case conflict: ${existing} and ${file}`);
    }
    seen.set(key, file);
  }
}

/**
 * @param {string} relativePath
 * @param {string} fullPath
 */
function checkLargeFile(relativePath, fullPath) {
  const size = fs.statSync(fullPath).size;
  if (size > MAX_FILE_BYTES) {
    problems.push(`Large file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
  }
}

/**
 * @param {string} relativePath
 */
function checkIllegalWindowsName(relativePath) {
  for (const segment of relativePath.split("/")) {
    const base = segment.replace(/\..*$/, "").toLowerCase();
    if (RESERVED_WINDOWS_NAMES.has(base) || /[ .]$/.test(segment)) {
      problems.push(`Illegal Windows path segment: ${relativePath}`);
      return;
    }
  }
}

/**
 * @param {Buffer} buffer
 */
function isBinary(buffer) {
  return buffer.includes(0);
}

/**
 * @param {string} relativePath
 * @param {string} text
 */
function checkJson(relativePath, text) {
  if (!relativePath.endsWith(".json")) {
    return;
  }
  try {
    JSON.parse(text);
  } catch (error) {
    problems.push(`Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * @param {string} relativePath
 * @param {string} text
 */
function checkYamlBasics(relativePath, text) {
  if (!/\.(ya?ml)$/.test(relativePath) && !relativePath.endsWith(".yaml") && !relativePath.endsWith(".yml")) {
    return;
  }
  if (/\t/.test(text)) {
    problems.push(`YAML contains tab indentation: ${relativePath}`);
  }
}

/**
 * @param {string} relativePath
 * @param {string} text
 */
function checkMergeConflict(relativePath, text) {
  if (MERGE_CONFLICT_PATTERN.test(text)) {
    problems.push(`Merge conflict marker found: ${relativePath}`);
  }
}

/**
 * @param {string} relativePath
 * @param {string} text
 */
function checkPrivateKey(relativePath, text) {
  if (PRIVATE_KEY_PATTERN.test(text)) {
    problems.push(`Private key block found: ${relativePath}`);
  }
}

/**
 * @param {string} text
 */
function fixText(text) {
  let fixed = text.replace(/\r\n?/g, "\n");
  fixed = fixed
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  if (fixed.length && !fixed.endsWith("\n")) {
    fixed += "\n";
  }
  return fixed;
}
