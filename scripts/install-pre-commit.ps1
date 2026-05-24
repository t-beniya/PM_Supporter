param(
  [string]$UvVersion = $env:UV_VERSION,
  [string]$PreCommitVersion = $env:PRE_COMMIT_VERSION,
  [string]$InstallDir,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $UvVersion) {
  $UvVersion = "0.11.11"
}
if (-not $PreCommitVersion) {
  $PreCommitVersion = "4.6.0"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $InstallDir) {
  $InstallDir = Join-Path $RepoRoot ".tools\bin"
}
$DownloadDir = Join-Path $RepoRoot ".tools\downloads"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Assert-UnderDirectory {
  param(
    [string]$Path,
    [string]$Root
  )

  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $fullPath = [IO.Path]::GetFullPath($Path)
  $rootWithSeparator = $fullRoot + [IO.Path]::DirectorySeparatorChar

  if (-not $fullPath.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside ${fullRoot}: ${fullPath}"
  }
}

function Remove-DirectorySafe {
  param(
    [string]$Path,
    [string]$Root
  )

  Assert-UnderDirectory -Path $Path -Root $Root
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
}

function Save-Url {
  param(
    [string]$Uri,
    [string]$OutFile
  )

  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source -fL $Uri -o $OutFile
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to download $Uri."
    }
    return
  }

  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile
}

function Get-UvArchitecture {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "x86_64-pc-windows-msvc" }
    "arm64" { return "aarch64-pc-windows-msvc" }
    default { throw "Unsupported CPU architecture: $arch" }
  }
}

$uvTarget = Join-Path $InstallDir "uv.exe"
$uvxTarget = Join-Path $InstallDir "uvx.exe"
$preCommitTarget = Join-Path $InstallDir "pre-commit.cmd"
if ((Test-Path $uvTarget) -and (Test-Path $uvxTarget) -and (Test-Path $preCommitTarget) -and -not $Force) {
  Write-Host "pre-commit wrapper already available: $preCommitTarget"
  & $preCommitTarget --version
  return
}

Ensure-Directory $InstallDir
Ensure-Directory $DownloadDir

$arch = Get-UvArchitecture
$archive = "uv-$arch.zip"
$baseUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion"
$archiveUrl = "$baseUrl/$archive"
$checksumUrl = "$archiveUrl.sha256"
$archivePath = Join-Path $DownloadDir $archive
$checksumPath = Join-Path $DownloadDir "$archive.sha256"

Write-Host "Installing uv $UvVersion for $arch..."
Save-Url -Uri $archiveUrl -OutFile $archivePath
Save-Url -Uri $checksumUrl -OutFile $checksumPath

$checksumText = Get-Content -Raw -LiteralPath $checksumPath
if ($checksumText -notmatch "([a-fA-F0-9]{64})") {
  throw "Could not parse uv checksum for $archive."
}
$expectedHash = $Matches[1].ToLowerInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch for $archive."
}

$stagingDir = Join-Path $DownloadDir "uv-staging"
Remove-DirectorySafe -Path $stagingDir -Root $DownloadDir
Ensure-Directory $stagingDir
Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force

$uvExe = Get-ChildItem -LiteralPath $stagingDir -Recurse -Filter "uv.exe" | Select-Object -First 1
$uvxExe = Get-ChildItem -LiteralPath $stagingDir -Recurse -Filter "uvx.exe" | Select-Object -First 1
if (-not $uvExe -or -not $uvxExe) {
  throw "uv archive did not contain uv.exe and uvx.exe."
}

Copy-Item -LiteralPath $uvExe.FullName -Destination $uvTarget -Force
Copy-Item -LiteralPath $uvxExe.FullName -Destination $uvxTarget -Force
Remove-DirectorySafe -Path $stagingDir -Root $DownloadDir

@"
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "TOOLS_DIR=%%~fI"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=%TOOLS_DIR%\uv-cache"
if not defined UV_TOOL_DIR set "UV_TOOL_DIR=%TOOLS_DIR%\uv-tools"
if not defined UV_PYTHON_INSTALL_DIR set "UV_PYTHON_INSTALL_DIR=%TOOLS_DIR%\uv-python"
if not defined PRE_COMMIT_HOME set "PRE_COMMIT_HOME=%TOOLS_DIR%\pre-commit-cache"
"%SCRIPT_DIR%uvx.exe" --from "pre-commit==$PreCommitVersion" pre-commit %*
"@ | Set-Content -LiteralPath $preCommitTarget -Encoding ASCII

Write-Host "Installed pre-commit wrapper to $preCommitTarget"
& $preCommitTarget --version
