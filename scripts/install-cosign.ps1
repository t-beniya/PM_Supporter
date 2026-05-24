param(
  [string]$CosignVersion = $env:COSIGN_VERSION,
  [string]$InstallDir,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $CosignVersion) {
  $CosignVersion = "3.0.6"
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

function Get-CosignArchitecture {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "amd64" }
    "arm64" {
      Write-Warning "Cosign v$CosignVersion does not publish a Windows ARM64 asset; using the Windows AMD64 binary under emulation."
      return "amd64"
    }
    default { throw "Unsupported CPU architecture: $arch" }
  }
}

$target = Join-Path $InstallDir "cosign.exe"
if ((Test-Path $target) -and -not $Force) {
  Write-Host "Cosign already available: $(& $target version 2>$null)"
  return
}

Ensure-Directory $InstallDir
Ensure-Directory $DownloadDir

$arch = Get-CosignArchitecture
$asset = "cosign-windows-$arch.exe"
$baseUrl = "https://github.com/sigstore/cosign/releases/download/v$CosignVersion"
$assetUrl = "$baseUrl/$asset"
$checksumsUrl = "$baseUrl/cosign_checksums.txt"
$downloadPath = Join-Path $DownloadDir $asset
$checksumsPath = Join-Path $DownloadDir "cosign_checksums.txt"

Write-Host "Installing Cosign v$CosignVersion for Windows $arch..."
Save-Url -Uri $assetUrl -OutFile $downloadPath
Save-Url -Uri $checksumsUrl -OutFile $checksumsPath

$line = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" } | Select-Object -First 1
if (-not $line) {
  throw "Could not find $asset in cosign_checksums.txt."
}
$expectedHash = ($line -split "\s+")[0].ToLowerInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 $downloadPath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch for $asset."
}

Copy-Item -LiteralPath $downloadPath -Destination $target -Force
Write-Host "Installed Cosign to $target"
& $target version
