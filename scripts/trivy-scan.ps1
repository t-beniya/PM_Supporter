param(
  [string[]]$Target = @(".")
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "local-env.ps1")

$trivyCommand = Get-Command trivy.exe -ErrorAction SilentlyContinue
if (-not $trivyCommand) {
  $trivyCommand = Get-Command trivy -ErrorAction SilentlyContinue
}
if (-not $trivyCommand) {
  throw "Trivy is not installed. Run scripts\install-trivy.ps1 first."
}

$env:TRIVY_CACHE_DIR = Join-Path $RepoRoot ".tools\trivy-cache"

$trivyArgs = @(
  "fs",
  "--scanners", "vuln,secret,misconfig",
  "--severity", "HIGH,CRITICAL",
  "--exit-code", "1",
  "--ignore-unfixed",
  "--skip-version-check",
  "--skip-dirs", ".git",
  "--skip-dirs", ".tools",
  "--skip-dirs", "node_modules",
  "--skip-dirs", ".vscode-test",
  "--skip-dirs", ".devcontainer",
  "--skip-dirs", "coverage",
  "--skip-dirs", "out",
  "--skip-dirs", "dist",
  "--skip-files", "*.vsix"
) + $Target

& $trivyCommand.Source @trivyArgs
exit $LASTEXITCODE
