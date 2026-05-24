$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ToolsDir = Join-Path $RepoRoot ".tools"
$NodeDir = Join-Path $ToolsDir "node"
$BinDir = Join-Path $ToolsDir "bin"

$prepend = @()
if (Test-Path (Join-Path $NodeDir "node.exe")) {
  $prepend += $NodeDir
}
if (Test-Path $BinDir) {
  $prepend += $BinDir
}

$pythonScriptDirs = @(
  (Join-Path $env:USERPROFILE ".local\bin"),
  (Join-Path $env:APPDATA "Python\Scripts"),
  (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\Scripts"),
  (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\Scripts"),
  (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\Scripts")
)
foreach ($dir in $pythonScriptDirs) {
  if ($dir -and (Test-Path $dir)) {
    $prepend += $dir
  }
}

$seen = @{}
$pathParts = @()
foreach ($part in ($prepend + ($env:PATH -split [IO.Path]::PathSeparator))) {
  if (-not $part) {
    continue
  }
  $key = $part.TrimEnd("\").ToLowerInvariant()
  if ($seen.ContainsKey($key)) {
    continue
  }
  $seen[$key] = $true
  $pathParts += $part
}

$env:PATH = $pathParts -join [IO.Path]::PathSeparator
$env:PM_SUPPORTER_REPO_ROOT = $RepoRoot
$env:PM_SUPPORTER_TOOLS_DIR = $ToolsDir
