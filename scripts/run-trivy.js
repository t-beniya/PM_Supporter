// @ts-check

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const targets = process.argv.slice(2);

const command = process.platform === "win32" ? "powershell" : "sh";
const args = process.platform === "win32"
  ? [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(repoRoot, "scripts", "trivy-scan.ps1"),
    ...targets
  ]
  : [
    path.join(repoRoot, "scripts", "trivy-scan.sh"),
    ...targets
  ];

const result = spawnSync(command, args, {
  cwd: repoRoot,
  stdio: "inherit",
  shell: false
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
