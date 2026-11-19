<#
.SYNOPSIS
    Production Windows build and packaging pipeline for VANTA Download Manager.

.DESCRIPTION
    Validates toolchain prerequisites, builds the Vite/React frontend, executes Rust
    verification and tests, compiles the Tauri 2 desktop application, packages Windows
    installers (NSIS / MSI) and portable archive, verifies artifact integrity, and
    publishes final outputs plus build-report.txt and SHA256SUMS.txt into dist/.

.EXAMPLE
    .\build.ps1
    Runs a full Release build targeting NSIS, MSI, and Portable ZIP into dist/.

.EXAMPLE
    .\build.ps1 -Clean -Release -Target all
    Performs a clean production build of all release formats.

.EXAMPLE
    .\build.ps1 -Target nsis -SkipInstall
    Builds only the NSIS installer using already-installed node_modules.

.EXAMPLE
    .\build.ps1 -Check
    Runs pre-flight environment diagnostics, icon/config checks, frontend typecheck, and Cargo check.
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Release,
    [switch]$Dev,
    [switch]$SkipInstall,
    [ValidateSet('all', 'nsis', 'msi', 'portable')]
    [string]$Target = 'all',
    [switch]$Check,
    [switch]$SkipTests,
    [string]$RustTarget = 'x86_64-pc-windows-msvc'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Ensure UTF-8 console output cleanly on both PowerShell 5.1 and PowerShell 7+
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Non-interactive hosts may not expose a console handle
}

$script:TotalStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:StepIndex = 0
$script:TotalSteps = 7

function Write-Stage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title
    )
    $script:StepIndex++
    $elapsed = $script:TotalStopwatch.Elapsed.ToString('mm\:ss')
    Write-Host ""
    Write-Host ("[{0}/{1}] {2}  (elapsed {3})" -f $script:StepIndex, $script:TotalSteps, $Title, $elapsed) -ForegroundColor Cyan
    Write-Host ("-" * 72) -ForegroundColor DarkGray
}

function Write-Info {
    param([string]$Message)
    Write-Host "  [INFO] $Message" -ForegroundColor Gray
}

function Write-Ok {
    param([string]$Message)
    Write-Host "  [OK]   $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Fail-Build {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )
    $script:TotalStopwatch.Stop()
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Red
    Write-Host "  BUILD FAILED ($($script:TotalStopwatch.Elapsed.ToString('mm\:ss\.ff')))" -ForegroundColor Red
    Write-Host "  Error: $Message" -ForegroundColor Red
    Write-Host "========================================================================" -ForegroundColor Red
    exit 1
}

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [string[]]$Arguments = @()
    )

    $displayArgs = ($Arguments -join ' ').Trim()
    $fullCmd = if ($displayArgs) { "$Executable $displayArgs" } else { $Executable }
    Write-Info "Running: $fullCmd"

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $Executable @Arguments
    $exitCode = $LASTEXITCODE
    $sw.Stop()

    if ($exitCode -ne 0) {
        Fail-Build "$Description failed with exit code $exitCode.`n  Command: $fullCmd"
    }

    Write-Ok ("{0} completed in {1:N1}s" -f $Description, $sw.Elapsed.TotalSeconds)
}

function Resolve-RepoRoot {
    $candidates = @()
    if ($PSScriptRoot) {
        $candidates += $PSScriptRoot
    }
    $candidates += (Get-Location).Path

    foreach ($candidate in $candidates) {
        $current = Resolve-Path -Path $candidate -ErrorAction SilentlyContinue
        while ($current) {
            $dir = $current.Path
            $pkg = Join-Path $dir 'package.json'
            $tauri = Join-Path $dir 'src-tauri/tauri.conf.json'
            if ((Test-Path $pkg) -and (Test-Path $tauri)) {
                return $dir
            }
            $parent = Split-Path -Path $dir -Parent
            if (-not $parent -or $parent -eq $dir) {
                break
            }
            $current = Resolve-Path -Path $parent -ErrorAction SilentlyContinue
        }
    }

    Fail-Build "Could not locate repository root containing package.json and src-tauri/tauri.conf.json."
}

function Get-ToolVersion {
    param(
        [string]$CommandName,
        [string[]]$CommandArgs = @('--version')
    )
    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    if (-not $cmd) {
        return $null
    }
    try {
        $out = & $cmd.Source @CommandArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        return (($out | Out-String).Trim() -split "`r?`n")[0]
    } catch {
        return $null
    }
}

function Test-IsWindowsHost {
    if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
        return [bool]$IsWindows
    }
    return ($env:OS -eq 'Windows_NT')
}

function Resolve-NpmExecutable {
    if (Test-IsWindowsHost) {
        $npmCmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
        if ($npmCmd) { return $npmCmd.Source }
    }
    $npm = Get-Command 'npm' -ErrorAction SilentlyContinue
    if ($npm) { return $npm.Source }
    return $null
}

function Resolve-NpxExecutable {
    if (Test-IsWindowsHost) {
        $npxCmd = Get-Command 'npx.cmd' -ErrorAction SilentlyContinue
        if ($npxCmd) { return $npxCmd.Source }
    }
    $npx = Get-Command 'npx' -ErrorAction SilentlyContinue
    if ($npx) { return $npx.Source }
    return $null
}

# Validate mutually exclusive build modes
if ($Release -and $Dev) {
    Fail-Build "Invalid parameters: -Release and -Dev cannot be combined."
}

$isReleaseBuild = -not $Dev.IsPresent
if ($Release.IsPresent) {
    $isReleaseBuild = $true
}
$buildModeLabel = if ($isReleaseBuild) { 'Release' } else { 'Debug' }

$repoRoot = Resolve-RepoRoot
Set-Location $repoRoot

$isWindowsHost = Test-IsWindowsHost
$npmExe = Resolve-NpmExecutable
$npxExe = Resolve-NpxExecutable
$tauriConfPath = Join-Path $repoRoot 'src-tauri/tauri.conf.json'
$cargoTomlPath = Join-Path $repoRoot 'src-tauri/Cargo.toml'
$packageJsonPath = Join-Path $repoRoot 'package.json'
$distDir = Join-Path $repoRoot 'dist'

try {
    $tauriConf = Get-Content -Path $tauriConfPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $packageJson = Get-Content -Path $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail-Build "Failed parsing project manifests (package.json or src-tauri/tauri.conf.json): $_"
}

$productName = if ($tauriConf.productName) { [string]$tauriConf.productName } else { 'VANTA Download Manager' }
$appVersion = if ($tauriConf.version) { [string]$tauriConf.version } elseif ($packageJson.version) { [string]$packageJson.version } else { '1.0.0' }
$cargoProfile = if ($isReleaseBuild) { 'release' } else { 'debug' }

if ($Check) {
    $script:TotalSteps = 4
}

Write-Host ""
Write-Host "========================================================================" -ForegroundColor White
Write-Host ("  {0} v{1} — Windows Build Pipeline" -f $productName, $appVersion) -ForegroundColor White
Write-Host ("  Mode: {0} | Target: {1} | Rust Triple: {2}" -f $buildModeLabel, $Target, $RustTarget) -ForegroundColor Gray
Write-Host ("  Root: {0}" -f $repoRoot) -ForegroundColor Gray
Write-Host "========================================================================" -ForegroundColor White

# ------------------------------------------------------------------------------
# Step 1: Validate Toolchains, Icons, Capabilities & Resources
# ------------------------------------------------------------------------------
Write-Stage "Validating toolchains and project resources"

$nodeVer = Get-ToolVersion -CommandName 'node'
if (-not $nodeVer -or -not $npmExe -or -not $npxExe) {
    Fail-Build "Node.js / npm is required but not found on PATH. Install Node.js 20+ (24 LTS recommended) from https://nodejs.org/."
}
$npmVer = & $npmExe --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail-Build "Unable to query npm version."
}
Write-Ok "Node.js $nodeVer | npm $npmVer"

$nodeMajorMatch = [regex]::Match($nodeVer, 'v?(\d+)\.')
if ($nodeMajorMatch.Success) {
    $nodeMajor = [int]$nodeMajorMatch.Groups[1].Value
    if ($nodeMajor -lt 20) {
        Fail-Build "Node.js $nodeVer is too old. Node.js 20+ (24 LTS recommended) is required."
    }
}

$rustcVer = Get-ToolVersion -CommandName 'rustc'
$cargoVer = Get-ToolVersion -CommandName 'cargo'
if (-not $rustcVer -or -not $cargoVer) {
    Fail-Build "Rust / Cargo toolchain was not found on PATH. Install Rust via https://rustup.rs/."
}
Write-Ok "$rustcVer"
Write-Ok "$cargoVer"

$rustupCmd = Get-Command 'rustup' -ErrorAction SilentlyContinue
if ($rustupCmd) {
    $installedTargets = (& $rustupCmd.Source target list --installed 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0) {
        if ($isWindowsHost -and ($installedTargets -notmatch [regex]::Escape($RustTarget))) {
            Write-Warn "Rust target '$RustTarget' is not installed. Installing via rustup..."
            Invoke-NativeStep -Description "Install Rust target $RustTarget" -Executable $rustupCmd.Source -Arguments @('target', 'add', $RustTarget)
        } else {
            Write-Ok "Rust target list verified (expected: $RustTarget)"
        }
    }
} else {
    Write-Warn "rustup not found on PATH; skipping target triple verification."
}

# Verify Tauri configuration, icons, capabilities, and binaries
$capPath = Join-Path $repoRoot 'src-tauri/capabilities/default.json'
if (-not (Test-Path $capPath)) {
    Fail-Build "Missing required Tauri capability file: src-tauri/capabilities/default.json"
}
Write-Ok "Tauri capabilities present: src-tauri/capabilities/default.json"

if ($tauriConf.bundle -and $tauriConf.bundle.icon) {
    foreach ($iconRel in $tauriConf.bundle.icon) {
        $iconFull = Join-Path $repoRoot (Join-Path 'src-tauri' $iconRel)
        if (-not (Test-Path $iconFull)) {
            Fail-Build "Missing configured Tauri bundle icon '$iconRel' (expected at $iconFull)."
        }
    }
    Write-Ok ("Verified {0} configured icon assets in src-tauri/icons" -f @($tauriConf.bundle.icon).Count)
}

$publicFavicon = Join-Path $repoRoot 'public/favicon.ico'
$publicIcon = Join-Path $repoRoot 'public/icon.png'
if (-not (Test-Path $publicFavicon) -or -not (Test-Path $publicIcon)) {
    Fail-Build "Missing required web icon assets in public/ (favicon.ico or icon.png)."
}
Write-Ok "Frontend public/ icons verified"

$tauriBinDir = Join-Path $repoRoot 'src-tauri/bin'
if (Test-Path $tauriBinDir) {
    $bundledBins = @(Get-ChildItem -Path $tauriBinDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.gitkeep' })
    if ($bundledBins.Count -gt 0) {
        Write-Ok ("Found {0} side-by-side engine binary(ies) in src-tauri/bin" -f $bundledBins.Count)
    } else {
        Write-Info "Slim installer mode: external engines download and SHA-256 verify to %LOCALAPPDATA%\com.vanta.downloadmanager\engines\bin on first run."
    }
}

if (-not $isWindowsHost -and -not $Check) {
    Fail-Build "Building native Windows installers (.exe / .msi) requires a Windows host (or run '.\build.ps1 -Check' for diagnostics)."
}

# ------------------------------------------------------------------------------
# Step 2: Optional Clean
# ------------------------------------------------------------------------------
if ($Clean) {
    Write-Stage "Cleaning build outputs and Cargo cache"
    foreach ($dirToClean in @('dist', 'release_artifacts', 'portable_package')) {
        $fullCleanPath = Join-Path $repoRoot $dirToClean
        if (Test-Path $fullCleanPath) {
            Write-Info "Removing $dirToClean/"
            Remove-Item -Path $fullCleanPath -Recurse -Force
        }
    }
    Invoke-NativeStep -Description "Cargo clean" -Executable 'cargo' -Arguments @('clean', '--manifest-path', $cargoTomlPath)
} elseif (-not $Check) {
    Write-Stage "Preparing output staging directory"
    Write-Info "Incremental build mode (pass -Clean for a full rebuild)"
}

# ------------------------------------------------------------------------------
# Step 3: Install Frontend Dependencies
# ------------------------------------------------------------------------------
Write-Stage "Checking frontend dependencies"

$nodeModulesPath = Join-Path $repoRoot 'node_modules'
$lockfilePath = Join-Path $repoRoot 'package-lock.json'
$tauriCliBin = if ($isWindowsHost) {
    Join-Path $repoRoot 'node_modules/.bin/tauri.cmd'
} else {
    Join-Path $repoRoot 'node_modules/.bin/tauri'
}

if ($SkipInstall) {
    if (-not (Test-Path $nodeModulesPath) -or -not (Test-Path $tauriCliBin)) {
        Fail-Build "-SkipInstall was specified, but node_modules or Tauri CLI is missing. Run without -SkipInstall."
    }
    Write-Ok "Skipping dependency installation (-SkipInstall)"
} else {
    if (Test-Path $lockfilePath) {
        Invoke-NativeStep -Description "Install npm dependencies (npm ci)" -Executable $npmExe -Arguments @('ci', '--include=optional')
    } else {
        Invoke-NativeStep -Description "Install npm dependencies (npm install)" -Executable $npmExe -Arguments @('install')
    }

    if ($isWindowsHost) {
        $rolldownWin = Join-Path $repoRoot 'node_modules/@rolldown/binding-win32-x64-msvc'
        if (-not (Test-Path $rolldownWin)) {
            Write-Info "Installing @rolldown/binding-win32-x64-msvc (--no-save)..."
            Invoke-NativeStep -Description "Install Windows native Rolldown binding" -Executable $npmExe -Arguments @('install', '--no-save', '@rolldown/binding-win32-x64-msvc')
        }
    }
}

$tauriVerOut = & $npxExe tauri --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail-Build "Tauri CLI (@tauri-apps/cli) is not runnable via npx tauri."
}
Write-Ok ("Tauri CLI: {0}" -f (($tauriVerOut | Out-String).Trim()))

# ------------------------------------------------------------------------------
# Step 4: Frontend Typecheck & Production Build (and Cargo check if -Check)
# ------------------------------------------------------------------------------
Write-Stage "Validating frontend and Rust crates"

if (-not $SkipTests -or $Check) {
    Invoke-NativeStep -Description "TypeScript typecheck (npm run lint)" -Executable $npmExe -Arguments @('run', 'lint')
} else {
    Write-Warn "Skipping TypeScript check (-SkipTests)"
}

if ($Check) {
    $cargoCheckArgs = @('check', '--manifest-path', $cargoTomlPath, '--features', 'desktop')
    if ($isWindowsHost) {
        $cargoCheckArgs += @('--target', $RustTarget)
    }
    Invoke-NativeStep -Description "Rust crate verification (cargo check)" -Executable 'cargo' -Arguments $cargoCheckArgs
    Invoke-NativeStep -Description "Frontend Vite production check (npm run build)" -Executable $npmExe -Arguments @('run', 'build')

    $script:TotalStopwatch.Stop()
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Green
    Write-Host ("  DIAGNOSTIC CHECK PASSED in {0:N1}s" -f $script:TotalStopwatch.Elapsed.TotalSeconds) -ForegroundColor Green
    Write-Host "========================================================================" -ForegroundColor Green
    exit 0
}

# ------------------------------------------------------------------------------
# Step 5: Rust Backend Unit Tests
# ------------------------------------------------------------------------------
Write-Stage "Running Rust backend tests"
if ($SkipTests) {
    Write-Warn "Skipping Rust unit tests (-SkipTests)"
} else {
    Invoke-NativeStep -Description "Rust unit tests" -Executable 'cargo' -Arguments @('test', '--manifest-path', $cargoTomlPath, '--features', 'desktop')
}

# ------------------------------------------------------------------------------
# Step 6: Build Tauri Desktop Application & Installers
# ------------------------------------------------------------------------------
Write-Stage "Building Tauri desktop application ($buildModeLabel / $Target)"

# Remove any prior packaged installers inside dist/ before Vite writes frontendDist
if (Test-Path $distDir) {
    Get-ChildItem -Path $distDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @('.exe', '.msi', '.zip') -or $_.Name -in @('SHA256SUMS.txt', 'build-report.txt') } |
        Remove-Item -Force
}

$tauriBuildArgs = @('tauri', 'build', '--features', 'desktop', '--target', $RustTarget)
if (-not $isReleaseBuild) {
    $tauriBuildArgs += '--debug'
}

switch ($Target) {
    'nsis' { $tauriBuildArgs += @('--bundles', 'nsis') }
    'msi'  { $tauriBuildArgs += @('--bundles', 'msi') }
    'portable' { $tauriBuildArgs += '--no-bundle' }
    'all'  { $tauriBuildArgs += @('--bundles', 'nsis,msi') }
}

Invoke-NativeStep -Description "Tauri desktop build" -Executable $npxExe -Arguments $tauriBuildArgs

# ------------------------------------------------------------------------------
# Step 7: Collect Verified Artifacts, Checksums & Build Report into dist/
# ------------------------------------------------------------------------------
Write-Stage "Collecting release artifacts and generating build report"

$targetOutDir = Join-Path $repoRoot ("src-tauri/target/{0}/{1}" -f $RustTarget, $cargoProfile)
$mainExePath = Join-Path $targetOutDir 'vanta.exe'
if (-not (Test-Path $mainExePath) -or ((Get-Item $mainExePath).Length -eq 0)) {
    Fail-Build "Missing or empty compiled desktop binary at $mainExePath"
}

$expectedNsis = ($Target -eq 'all' -or $Target -eq 'nsis')
$expectedMsi = ($Target -eq 'all' -or $Target -eq 'msi')
$expectedPortable = ($Target -eq 'all' -or $Target -eq 'portable')

$nsisFile = $null
if ($expectedNsis) {
    $nsisDir = Join-Path $targetOutDir 'bundle/nsis'
    $nsisFile = Get-ChildItem -Path $nsisDir -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $nsisFile -or $nsisFile.Length -eq 0) {
        Fail-Build "Expected NSIS installer was not generated under $nsisDir"
    }
}

$msiFile = $null
if ($expectedMsi) {
    $msiDir = Join-Path $targetOutDir 'bundle/msi'
    $msiFile = Get-ChildItem -Path $msiDir -Filter '*.msi' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $msiFile -or $msiFile.Length -eq 0) {
        Fail-Build "Expected MSI installer was not generated under $msiDir"
    }
}

# Clean Vite's intermediate web bundle out of dist/ (already embedded into vanta.exe by Tauri)
# so dist/ holds exclusively the clean Windows release deliverables and report.
if (Test-Path $distDir) {
    Remove-Item -Path $distDir -Recurse -Force
}
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

$collectedArtifacts = @()

if ($nsisFile) {
    $nsisDest = Join-Path $distDir $nsisFile.Name
    Copy-Item -Path $nsisFile.FullName -Destination $nsisDest -Force
    $collectedArtifacts += [PSCustomObject]@{
        Role = 'NSIS Setup Installer'
        Name = $nsisFile.Name
        Path = $nsisDest
        Source = $nsisFile.FullName
    }
}

if ($msiFile) {
    $msiDest = Join-Path $distDir $msiFile.Name
    Copy-Item -Path $msiFile.FullName -Destination $msiDest -Force
    $collectedArtifacts += [PSCustomObject]@{
        Role = 'Windows MSI Installer'
        Name = $msiFile.Name
        Path = $msiDest
        Source = $msiFile.FullName
    }
}

if ($expectedPortable) {
    $portableStaging = Join-Path $repoRoot 'portable_package'
    if (Test-Path $portableStaging) {
        Remove-Item -Path $portableStaging -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $portableStaging 'bin') -Force | Out-Null
    Copy-Item -Path $mainExePath -Destination (Join-Path $portableStaging 'VANTA.exe') -Force

    if (Test-Path $tauriBinDir) {
        Get-ChildItem -Path $tauriBinDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne '.gitkeep' } |
            ForEach-Object {
                Copy-Item -Path $_.FullName -Destination (Join-Path $portableStaging 'bin') -Force
            }
    }

    $safeProductSlug = ($productName -replace '[^A-Za-z0-9._-]+', '-')
    $portableName = "{0}_{1}_x64-portable.zip" -f $safeProductSlug, $appVersion
    $portableDest = Join-Path $distDir $portableName
    Compress-Archive -Path (Join-Path $portableStaging '*') -DestinationPath $portableDest -CompressionLevel Optimal -Force
    Remove-Item -Path $portableStaging -Recurse -Force

    $collectedArtifacts += [PSCustomObject]@{
        Role = 'Portable Standalone ZIP'
        Name = $portableName
        Path = $portableDest
        Source = $mainExePath
    }
}

# Verify every copied artifact and generate SHA256SUMS.txt
$checksumLines = @()
$reportArtifactRows = @()

foreach ($art in $collectedArtifacts) {
    if (-not (Test-Path $art.Path)) {
        Fail-Build "Artifact verification failed: missing $($art.Path)"
    }
    $item = Get-Item -Path $art.Path
    if ($item.Length -le 0) {
        Fail-Build "Artifact verification failed: empty file $($art.Path)"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $art.Path).Hash.ToLowerInvariant()
    $mib = [Math]::Round($item.Length / 1MB, 2)
    $checksumLines += ("{0}  {1}" -f $hash, $art.Name)
    $reportArtifactRows += ("- {0}: {1} | {2:N0} bytes ({3:N2} MiB) | SHA256: {4}" -f $art.Role, $art.Name, $item.Length, $mib, $hash)
}

$checksumsPath = Join-Path $distDir 'SHA256SUMS.txt'
$checksumLines | Out-File -FilePath $checksumsPath -Encoding ascii

$script:TotalStopwatch.Stop()
$buildTimestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss UTC')
$mainExeItem = Get-Item -Path $mainExePath
$mainExeMib = [Math]::Round($mainExeItem.Length / 1MB, 2)

$gitCommit = 'N/A'
$gitCmd = Get-Command 'git' -ErrorAction SilentlyContinue
if ($gitCmd -and (Test-Path (Join-Path $repoRoot '.git'))) {
    try {
        $rev = (& $gitCmd.Source rev-parse --short HEAD 2>$null | Out-String).Trim()
        if ($rev) { $gitCommit = $rev }
    } catch {
        $gitCommit = 'N/A'
    }
}

$reportPath = Join-Path $distDir 'build-report.txt'
$reportLines = @(
    "VANTA Download Manager — Windows Build Report"
    "============================================="
    ("Application   : {0}" -f $productName)
    ("Version       : {0}" -f $appVersion)
    ("Build Date    : {0}" -f $buildTimestamp)
    ("Build Mode    : {0}" -f $buildModeLabel)
    ("Bundle Target : {0}" -f $Target)
    ("Rust Triple   : {0}" -f $RustTarget)
    ("Git Commit    : {0}" -f $gitCommit)
    ("Build Status  : SUCCEEDED")
    ("Duration      : {0:N2}s" -f $script:TotalStopwatch.Elapsed.TotalSeconds)
    ""
    "Toolchain Versions:"
    ("- Node.js     : {0}" -f $nodeVer)
    ("- npm         : {0}" -f $npmVer)
    ("- Rustc       : {0}" -f $rustcVer)
    ("- Cargo       : {0}" -f $cargoVer)
    ""
    "Compiled Binary:"
    ("- vanta.exe   : {0} | {1:N0} bytes ({2:N2} MiB)" -f $mainExePath, $mainExeItem.Length, $mainExeMib)
    ""
    "Release Artifacts in dist/:"
) + $reportArtifactRows + @(
    ("- Checksums   : SHA256SUMS.txt")
)

$reportLines | Out-File -FilePath $reportPath -Encoding utf8

Write-Host ""
Write-Host "========================================================================" -ForegroundColor Green
Write-Host ("  BUILD SUCCEEDED in {0:N1}s — Output ready in dist/" -f $script:TotalStopwatch.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host "========================================================================" -ForegroundColor Green
foreach ($row in $reportArtifactRows) {
    Write-Host "  $row" -ForegroundColor White
}
Write-Host ("  - Checksums   : {0}" -f $checksumsPath) -ForegroundColor Gray
Write-Host ("  - Build Report: {0}" -f $reportPath) -ForegroundColor Gray
Write-Host ""
exit 0
