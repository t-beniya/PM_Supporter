param(
  [int]$NodeMajor = 22,
  [string]$PreCommitVersion = "4.6.0",
  [switch]$SkipPreCommit,
  [switch]$SkipSecurityTools
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ToolsDir = Join-Path $RepoRoot ".tools"
$NodeDir = Join-Path $ToolsDir "node"
$DownloadDir = Join-Path $ToolsDir "downloads"
$BinDir = Join-Path $ToolsDir "bin"

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

function Move-DirectorySafe {
  param(
    [string]$Path,
    [string]$Destination,
    [string]$Root
  )

  Assert-UnderDirectory -Path $Path -Root $Root
  Assert-UnderDirectory -Path $Destination -Root $Root
  Move-Item -LiteralPath $Path -Destination $Destination
}

function Get-ToolArchitecture {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  switch ($arch) {
    "x64" {
      return @{
        Node = "x64"
      }
    }
    "arm64" {
      return @{
        Node = "arm64"
      }
    }
    default {
      throw "Unsupported CPU architecture: $arch"
    }
  }
}

function Get-NodeMajorVersion {
  param([string]$NodePath)

  try {
    $version = & $NodePath --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $version) {
      return $null
    }
    if ($version -match "^v(?<major>[0-9]+)\.") {
      return [int]$Matches.major
    }
  } catch {
    return $null
  }

  return $null
}

function Get-UsableNode {
  $localNode = Join-Path $NodeDir "node.exe"
  if (Test-Path $localNode) {
    $major = Get-NodeMajorVersion $localNode
    if ($major -ge $NodeMajor) {
      return $localNode
    }
  }

  $globalNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $globalNode) {
    $globalNode = Get-Command node -ErrorAction SilentlyContinue
  }
  if ($globalNode) {
    $major = Get-NodeMajorVersion $globalNode.Source
    if ($major -ge $NodeMajor) {
      return $globalNode.Source
    }
  }

  return $null
}

function Get-ChecksumLine {
  param(
    [string]$Text,
    [string]$Pattern
  )

  foreach ($line in ($Text -split "`n")) {
    $trimmed = $line.Trim()
    if ($trimmed -match $Pattern) {
      return @{
        Hash = $Matches.hash
        Archive = $Matches.archive
        Version = $Matches.version
      }
    }
  }

  throw "Could not find a matching Node archive in SHASUMS256.txt."
}

function Install-PortableNode {
  $toolArch = Get-ToolArchitecture
  $nodeArch = $toolArch.Node
  $latestAlias = "latest-v$NodeMajor.x"
  $baseUrl = "https://nodejs.org/dist/$latestAlias"
  $checksumsUrl = "$baseUrl/SHASUMS256.txt"

  Ensure-Directory $ToolsDir
  Ensure-Directory $DownloadDir

  Write-Host "Resolving Node.js $NodeMajor.x for Windows $nodeArch..."
  $checksums = (Invoke-WebRequest -UseBasicParsing -Uri $checksumsUrl).Content
  $escapedArch = [regex]::Escape($nodeArch)
  $pattern = "^(?<hash>[a-fA-F0-9]{64})\s+(?<archive>node-v(?<version>$NodeMajor\.[0-9]+\.[0-9]+)-win-$escapedArch\.zip)$"
  $match = Get-ChecksumLine -Text $checksums -Pattern $pattern

  $archivePath = Join-Path $DownloadDir $match.Archive
  $archiveUrl = "$baseUrl/$($match.Archive)"
  Write-Host "Downloading $($match.Archive)..."
  Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath

  $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
  if ($actualHash -ne $match.Hash.ToLowerInvariant()) {
    throw "Checksum mismatch for $($match.Archive)."
  }

  $stagingDir = Join-Path $ToolsDir "node-staging"
  $nextDir = Join-Path $ToolsDir "node-next"
  Remove-DirectorySafe -Path $stagingDir -Root $ToolsDir
  Remove-DirectorySafe -Path $nextDir -Root $ToolsDir
  Ensure-Directory $stagingDir

  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force
  $expanded = Get-ChildItem -LiteralPath $stagingDir -Directory | Select-Object -First 1
  if (-not $expanded) {
    throw "Node archive did not contain an extracted directory."
  }

  Move-DirectorySafe -Path $expanded.FullName -Destination $nextDir -Root $ToolsDir
  Remove-DirectorySafe -Path $NodeDir -Root $ToolsDir
  Move-DirectorySafe -Path $nextDir -Destination $NodeDir -Root $ToolsDir
  Remove-DirectorySafe -Path $stagingDir -Root $ToolsDir

  $nodePath = Join-Path $NodeDir "node.exe"
  Write-Host "Installed Node.js $(& $nodePath --version) to $NodeDir"
}

function Get-PythonCommand {
  $candidates = @(
    @{ Command = "py.exe"; Args = @("-3") },
    @{ Command = "py"; Args = @("-3") },
    @{ Command = "python.exe"; Args = @() },
    @{ Command = "python"; Args = @() },
    @{ Command = "python3"; Args = @() }
  )

  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate.Command -ErrorAction SilentlyContinue
    if (-not $command) {
      continue
    }

    try {
      $output = & $command.Source @($candidate.Args + @("--version")) 2>&1
      if ($LASTEXITCODE -eq 0 -and ($output -join " ") -match "Python 3\.") {
        return @{
          Command = $command.Source
          Args = $candidate.Args
        }
      }
    } catch {
      continue
    }
  }

  return $null
}

function Ensure-PreCommit {
  if ($SkipPreCommit) {
    Write-Host "Skipping pre-commit setup."
    return
  }

  $preCommit = Get-Command pre-commit -ErrorAction SilentlyContinue
  if ($preCommit) {
    Write-Host "pre-commit already available: $(& $preCommit.Source --version)"
    return
  }

  $python = Get-PythonCommand
  if (-not $python) {
    Write-Warning "Python 3 was not found. Installing repo-local pre-commit wrapper through uv instead."
    & (Join-Path $PSScriptRoot "install-pre-commit.ps1") -InstallDir $BinDir -PreCommitVersion $PreCommitVersion
    return
  }

  Write-Host "Installing pipx and pre-commit $PreCommitVersion..."
  & $python.Command @($python.Args + @("-m", "pip", "install", "--user", "pipx"))
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install pipx."
  }
  & $python.Command @($python.Args + @("-m", "pipx", "ensurepath"))
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to update pipx PATH."
  }
  & $python.Command @($python.Args + @("-m", "pipx", "install", "pre-commit==$PreCommitVersion", "--force"))
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install pre-commit."
  }
}

Ensure-Directory $ToolsDir
Ensure-Directory $BinDir

$node = Get-UsableNode
if ($node) {
  Write-Host "Node already available: $(& $node --version)"
} else {
  Install-PortableNode
}

. (Join-Path $PSScriptRoot "local-env.ps1")

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
  throw "npm was not found after Node setup."
}
Write-Host "npm available: $(& $npm.Source --version)"

Ensure-PreCommit

if ($SkipSecurityTools) {
  Write-Host "Skipping Cosign and Trivy setup."
} else {
  & (Join-Path $PSScriptRoot "install-cosign.ps1") -InstallDir $BinDir
  & (Join-Path $PSScriptRoot "install-trivy.ps1") -InstallDir $BinDir
}

Write-Host ""
Write-Host "Local toolchain is ready. For an interactive PowerShell session:"
Write-Host "  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass"
Write-Host "  . .\scripts\local-env.ps1"
Write-Host "  npm test"
