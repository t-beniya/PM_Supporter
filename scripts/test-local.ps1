$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "local-env.ps1")

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
  throw "npm was not found. Run scripts\setup-local.ps1 first, then retry."
}

& $npm.Source test
exit $LASTEXITCODE
