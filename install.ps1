<#
.SYNOPSIS
    ProjectMind Universal Installer for Windows
    Supports Windows 10/11, Windows Server, PowerShell 5.1 & PowerShell 7+

.DESCRIPTION
    Installs ProjectMind runtime, creates CLI wrappers, configures PATH,
    and optionally installs agent integrations.

.PARAMETER Agent
    Specific agent to install (e.g. antigravity, cursor, opencode, deepseek-harness)

.PARAMETER All
    Install integrations for all 9 supported agents

.PARAMETER InstallDir
    Target directory for ProjectMind installation (default: $env:LOCALAPPDATA\ProjectMind)

.PARAMETER BinDir
    Directory where CLI wrapper scripts are placed (default: $InstallDir\bin)

.PARAMETER DryRun
    Simulate actions without writing files or modifying system configuration

.PARAMETER NoVerify
    Skip post-install diagnostic doctor check
#>

[CmdletBinding()]
param(
    [string]$Agent = "",
    [switch]$All,
    [string]$InstallDir = "",
    [string]$BinDir = "",
    [switch]$DryRun,
    [switch]$NoVerify,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Get-Help $MyInvocation.MyCommand.Path -Full
    exit 0
}

$Version = "1.1.0"
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "ProjectMind Universal Windows Installer v$Version" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Resolve Installation Directories
if (-not $InstallDir) {
    if ($env:LOCALAPPDATA) {
        $InstallDir = Join-Path $env:LOCALAPPDATA "ProjectMind"
    } else {
        $InstallDir = Join-Path $env:USERPROFILE ".projectmind"
    }
}

if (-not $BinDir) {
    $BinDir = Join-Path $InstallDir "bin"
}

Write-Host "Install Directory: $InstallDir"
Write-Host "Bin Directory:     $BinDir"

# 2. Check Node.js
$nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Error "Node.js is required but not found in PATH. Please install Node.js >= 18.0.0 from https://nodejs.org/"
    exit 1
}

$nodeVersionString = & node -v
$nodeVersion = $nodeVersionString -replace '^v', ''
$majorVersion = [int]($nodeVersion.Split('.')[0])

if ($majorVersion -lt 18) {
    Write-Error "Node.js v18.0.0 or higher is required. Found v$nodeVersion."
    exit 1
}
Write-Host "[✓] Node.js v$nodeVersion detected (>= 18.0.0)" -ForegroundColor Green

# 3. Detect Local Repo Checkout or Setup
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$isLocalRepo = $false

if (Test-Path (Join-Path $ScriptDir "package.json")) {
    $pkgJson = Get-Content (Join-Path $ScriptDir "package.json") -Raw | ConvertFrom-Json
    if ($pkgJson.name -eq "projectmind") {
        $isLocalRepo = $true
        $RepoRoot = $ScriptDir
        Write-Host "[✓] Detected local repository checkout at: $RepoRoot" -ForegroundColor Green
    }
}

# 4. Create Directories
if (-not $DryRun) {
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }
    if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
} else {
    Write-Host "[Dry-Run] Would create directory: $InstallDir" -ForegroundColor Yellow
    Write-Host "[Dry-Run] Would create directory: $BinDir" -ForegroundColor Yellow
}

# 5. Build if local checkout
$CliScript = ""
if ($isLocalRepo) {
    $CliScript = Join-Path $RepoRoot "apps\cli\dist\index.js"
    if (-not (Test-Path $CliScript)) {
        Write-Host "Building ProjectMind packages..." -ForegroundColor Cyan
        if (-not $DryRun) {
            & node (Join-Path $RepoRoot "scripts\build.js")
        }
    }
} else {
    $CliScript = Join-Path $InstallDir "apps\cli\dist\index.js"
}

# 6. Create Windows CLI Command Wrappers (.cmd and .ps1)
$CmdWrapperPath = Join-Path $BinDir "projectmind.cmd"
$Ps1WrapperPath = Join-Path $BinDir "projectmind.ps1"

$CmdContent = @"
@echo off
node "$CliScript" %*
"@

$Ps1Content = @"
& node "$CliScript" `$args
"@

if (-not $DryRun) {
    Set-Content -Path $CmdWrapperPath -Value $CmdContent -Force
    Set-Content -Path $Ps1WrapperPath -Value $Ps1Content -Force
    Write-Host "[✓] Created CLI wrappers in $BinDir" -ForegroundColor Green
} else {
    Write-Host "[Dry-Run] Would create $CmdWrapperPath" -ForegroundColor Yellow
    Write-Host "[Dry-Run] Would create $Ps1WrapperPath" -ForegroundColor Yellow
}

# 7. Add BinDir to User PATH environment variable if missing
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $userPath) { $userPath = "" }
$paths = $userPath.Split(';') | Where-Object { $_ -ne "" }

if ($paths -notcontains $BinDir) {
    if (-not $DryRun) {
        $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        $env:PATH = "$env:PATH;$BinDir"
        Write-Host "[✓] Added $BinDir to User PATH environment variable." -ForegroundColor Green
    } else {
        Write-Host "[Dry-Run] Would add $BinDir to User PATH." -ForegroundColor Yellow
    }
} else {
    Write-Host "[✓] $BinDir is already in PATH." -ForegroundColor Green
}

# 8. Agent Installation (if requested)
$CurrentDir = (Get-Location).Path
if ($All) {
    Write-Host "Installing all 9 agent plugins into $CurrentDir..." -ForegroundColor Cyan
    if (-not $DryRun) {
        & node $CliScript plugin install --all --yes --project-root $CurrentDir
    } else {
        Write-Host "[Dry-Run] Would run: projectmind plugin install --all" -ForegroundColor Yellow
    }
} elseif ($Agent) {
    Write-Host "Installing plugin '$Agent' into $CurrentDir..." -ForegroundColor Cyan
    if (-not $DryRun) {
        & node $CliScript plugin install $Agent --yes --project-root $CurrentDir
    } else {
        Write-Host "[Dry-Run] Would run: projectmind plugin install $Agent" -ForegroundColor Yellow
    }
}

# 9. Verification Doctor Check
if ((-not $NoVerify) -and (-not $DryRun)) {
    Write-Host ""
    Write-Host "Running ProjectMind system diagnostics..." -ForegroundColor Cyan
    & node $CliScript plugin doctor
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "ProjectMind Windows installation completed successfully!" -ForegroundColor Green
Write-Host "Run 'projectmind help' to get started." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

