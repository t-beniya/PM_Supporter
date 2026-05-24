param(
  [string]$TrivyVersion = $env:TRIVY_VERSION,
  [string]$InstallDir,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $TrivyVersion) {
  $TrivyVersion = "0.69.3"
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $InstallDir) {
  $InstallDir = Join-Path $RepoRoot ".tools\bin"
}
$DownloadDir = Join-Path $RepoRoot ".tools\downloads"
$verifySignature = $env:TRIVY_VERIFY_SIGNATURE -ne "0"

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

function Get-TrivyArchitecture {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" { return "64bit" }
    "arm64" {
      Write-Warning "Trivy v$TrivyVersion does not publish a Windows ARM64 asset; using the Windows 64-bit binary under emulation."
      return "64bit"
    }
    default { throw "Unsupported CPU architecture: $arch" }
  }
}

function Invoke-CosignVerification {
  param(
    [string]$CosignPath,
    [string]$ArchivePath,
    [string]$BundlePath,
    [string]$Version
  )

  & $CosignPath verify-blob-attestation $ArchivePath `
    --bundle $BundlePath `
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" `
    --certificate-identity "https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v$Version"

  if ($LASTEXITCODE -eq 0) {
    return
  }

  Write-Host "Trivy release bundle is not an attestation; verifying it as a signed blob instead."
  & $CosignPath verify-blob $ArchivePath `
    --bundle $BundlePath `
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" `
    --certificate-identity "https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v$Version"

  if ($LASTEXITCODE -ne 0) {
    throw "Trivy signature verification failed."
  }
}

$target = Join-Path $InstallDir "trivy.exe"
if ((Test-Path $target) -and -not $Force) {
  Write-Host "Trivy already available: $(& $target --version)"
  return
}

Ensure-Directory $InstallDir
Ensure-Directory $DownloadDir

$arch = Get-TrivyArchitecture
$archive = "trivy_${TrivyVersion}_Windows-$arch.zip"
$baseUrl = "https://github.com/aquasecurity/trivy/releases/download/v$TrivyVersion"
$archiveUrl = "$baseUrl/$archive"
$checksumsUrl = "$baseUrl/trivy_${TrivyVersion}_checksums.txt"
$bundleUrl = "$archiveUrl.sigstore.json"
$archivePath = Join-Path $DownloadDir $archive
$checksumsPath = Join-Path $DownloadDir "trivy_${TrivyVersion}_checksums.txt"
$bundlePath = Join-Path $DownloadDir "$archive.sigstore.json"

Write-Host "Installing Trivy v$TrivyVersion for Windows $arch..."
Save-Url -Uri $archiveUrl -OutFile $archivePath
Save-Url -Uri $checksumsUrl -OutFile $checksumsPath

$line = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($archive))$" } | Select-Object -First 1
if (-not $line) {
  throw "Could not find $archive in Trivy checksums."
}
$expectedHash = ($line -split "\s+")[0].ToLowerInvariant()
$actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch for $archive."
}

if ($verifySignature) {
  $cosign = Get-Command cosign.exe -ErrorAction SilentlyContinue
  if (-not $cosign) {
    $localCosign = Join-Path $InstallDir "cosign.exe"
    if (Test-Path $localCosign) {
      $cosign = @{ Source = $localCosign }
    }
  }
  if (-not $cosign) {
    throw "Cosign is required to verify Trivy. Run scripts\install-cosign.ps1 first, or set TRIVY_VERIFY_SIGNATURE=0."
  }

  Save-Url -Uri $bundleUrl -OutFile $bundlePath
  Invoke-CosignVerification -CosignPath $cosign.Source -ArchivePath $archivePath -BundlePath $bundlePath -Version $TrivyVersion
}

$stagingDir = Join-Path $DownloadDir "trivy-staging"
Remove-DirectorySafe -Path $stagingDir -Root $DownloadDir
Ensure-Directory $stagingDir
Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force

$trivyExe = Get-ChildItem -LiteralPath $stagingDir -Recurse -Filter "trivy.exe" | Select-Object -First 1
if (-not $trivyExe) {
  throw "Trivy archive did not contain trivy.exe."
}

Copy-Item -LiteralPath $trivyExe.FullName -Destination $target -Force
Remove-DirectorySafe -Path $stagingDir -Root $DownloadDir

Write-Host "Installed Trivy to $target"
& $target --version
