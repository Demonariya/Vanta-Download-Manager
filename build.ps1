<#
.SYNOPSIS
    Production Windows build, diagnostics, and lockfile-repair pipeline for VANTA Download Manager.

.DESCRIPTION
    Canonical Windows build entrypoint for VANTA Download Manager (Rust + Tauri 2 + React/Vite).
    Supports read-only pre-flight verification (-Check), clean rebuilds (-Clean), release/debug
    packaging (-Release / -Dev), targeted bundles (-Target all|nsis|msi|portable), and explicit
    cross-platform lockfile repair (-RepairLockfile).

.EXAMPLE
    .\build.ps1
    Runs a deterministic Release build producing NSIS, MSI, Portable ZIP, SHA256SUMS.txt, and build-report.txt in dist/.

.EXAMPLE
    .\build.ps1 -Check
    Runs read-only environment, Visual Studio/SDK/WebView2, Rust target, lockfile, icon, and TypeScript checks.

.EXAMPLE
    .\build.ps1 -Clean -Release -Target all
    Cleans generated build directories and Cargo target cache, then performs a full release build.

.EXAMPLE
    .\build.ps1 -RepairLockfile
    Regenerates package-lock.json with full cross-platform optional dependencies and verifies clean npm ci --include=optional.
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
    [switch]$RepairLockfile,
    [string]$RustTarget = 'x86_64-pc-windows-msvc',
    [int]$CommandTimeoutSeconds = 1800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Non-interactive hosts may not expose a console handle
}

$script:TotalStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:StepIndex = 0
$script:TotalSteps = 7
$script:RepoRoot = $null
$script:DistDir = $null

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

function Test-IsWindowsHost {
    if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
        return [bool]$IsWindows
    }
    return ($env:OS -eq 'Windows_NT')
}

function Format-CommandArgument {
    param([string]$Arg)
    if ($null -eq $Arg) { return '""' }
    if ($Arg -eq '') { return '""' }
    if ($Arg -match '[\s"&|<>^()]') {
        $escaped = $Arg -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        return '"' + $escaped + '"'
    }
    return $Arg
}

function Get-FailureDiagnosis {
    param(
        [string]$Stage,
        [string]$Command,
        [int]$ExitCode,
        [string[]]$OutputLines
    )

    $joined = ($OutputLines -join "`n")

    if ($joined -match 'EUSAGE' -or $joined -match 'package\.json and package-lock\.json are in sync' -or $joined -match 'Missing: .* from lock file') {
        return "npm lockfile mismatch (EUSAGE): package-lock.json is out of sync or missing platform optional dependencies. Run '.\build.ps1 -RepairLockfile' locally and commit the updated package-lock.json. Do NOT switch to 'npm install' or '--omit=optional'."
    }
    if ($joined -match 'Cannot find native binding' -or $joined -match '@rolldown/binding' -or $joined -match '@tailwindcss/oxide' -or $joined -match 'lightningcss') {
        return "Missing native frontend binding (Rolldown / Tailwind Oxide / LightningCSS). Run '.\build.ps1 -RepairLockfile' followed by a clean '.\build.ps1 -Clean'."
    }
    if ($joined -match 'EJSONPARSE' -or $joined -match 'Invalid package\.json') {
        return "Invalid JSON syntax in package.json or package-lock.json. Validate both JSON files before retrying."
    }
    if ($joined -match 'ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|SELF_SIGNED_CERT|unable to get local issuer certificate|proxy') {
        return "Network / DNS / TLS / proxy failure reaching registry or crates.io. Check internet connectivity, corporate proxy environment variables (HTTP_PROXY/HTTPS_PROXY), and retry."
    }
    if ($joined -match 'is not recognized as an internal or external command|Cannot find module .*vite|Cannot find module .*tauri') {
        return "Missing Vite or Tauri CLI binary inside node_modules. Run a clean 'npm ci --include=optional' (or '.\build.ps1' without -SkipInstall)."
    }
    if ($joined -match 'error TS\d+:') {
        return "TypeScript compilation error detected. Fix the reported TypeScript diagnostics in src/ or server/ before building."
    }
    if ($joined -match "can't find crate for|target may not be installed|target .* not found") {
        return "Missing Rust target triple ('$RustTarget'). Install it via: rustup target add $RustTarget"
    }
    if ($joined -match 'linker `link\.exe` not found|LNK\d+|msvc.*not found') {
        return "MSVC C++ linker failure (link.exe missing or broken). Install Visual Studio 2022 Build Tools with 'Desktop development with C++' and restart your shell."
    }
    if ($joined -match 'kernel32\.lib|windows\.h|rc\.exe|Windows SDK') {
        return "Missing Windows 10/11 SDK components. Open Visual Studio Installer -> Modify -> enable Windows 10/11 SDK."
    }
    if ($joined -match 'error\[E\d+\]|aborting due to \d+ previous error') {
        return "Rust compiler error in src-tauri/. Review the Rust diagnostics printed above."
    }
    if ($joined -match 'failed to select a version|no matching package|Cargo\.lock') {
        return "Cargo dependency resolution failure. Check src-tauri/Cargo.toml, Cargo.lock, and crates.io network access."
    }
    if ($joined -match 'makensis|nsis|candle\.exe|light\.exe|wix') {
        return "Tauri Windows installer bundler (NSIS/WiX) failed. Inspect bundled files, antivirus locks on target/, and Tauri bundle configuration."
    }
    if ($joined -match 'frontendDist|dist.*does not exist') {
        return "Frontend distribution directory configured by Tauri (../dist) is missing. Ensure 'npm run build' succeeds before packaging."
    }
    if ($joined -match 'icon|capabilities|tauri\.conf\.json') {
        return "Tauri configuration, capability, or icon validation failure. Check src-tauri/tauri.conf.json, capabilities/default.json, and src-tauri/icons/."
    }
    if ($ExitCode -eq 124) {
        return "Command exceeded timeout ($CommandTimeoutSeconds s) and its process tree was terminated."
    }

    return "Review the captured output above and the saved failure log for exact diagnostics."
}

function Fail-Build {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [string]$Stage = 'Pipeline',
        [string]$Command = '',
        [int]$ExitCode = 1,
        [string[]]$CapturedLines = @(),
        [string]$Suggestion = ''
    )

    if ($script:TotalStopwatch.IsRunning) {
        $script:TotalStopwatch.Stop()
    }

    $logSavedPath = $null
    if ($CapturedLines.Count -gt 0 -and $script:RepoRoot) {
        try {
            $logTarget = Join-Path $script:RepoRoot 'last-build-failure.log'
            @(
                "VANTA Build Failure Log"
                "Timestamp : $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss UTC'))"
                "Stage     : $Stage"
                "Command   : $Command"
                "ExitCode  : $ExitCode"
                "Summary   : $Message"
                "------------------------------------------------------------------------"
            ) + $CapturedLines | Out-File -FilePath $logTarget -Encoding utf8
            $logSavedPath = $logTarget
        } catch {
            $logSavedPath = $null
        }
    }

    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Red
    Write-Host ("  BUILD FAILED ({0})" -f $script:TotalStopwatch.Elapsed.ToString('mm\:ss\.ff')) -ForegroundColor Red
    Write-Host ("  Stage     : {0}" -f $Stage) -ForegroundColor Red
    if ($Command) {
        Write-Host ("  Command   : {0}" -f $Command) -ForegroundColor Red
    }
    Write-Host ("  Exit Code : {0}" -f $ExitCode) -ForegroundColor Red
    Write-Host ("  Error     : {0}" -f $Message) -ForegroundColor Red

    if ($CapturedLines.Count -gt 0) {
        $tailCount = [Math]::Min(25, $CapturedLines.Count)
        $tail = $CapturedLines[($CapturedLines.Count - $tailCount)..($CapturedLines.Count - 1)]
        Write-Host ""
        Write-Host "  Recent Output Lines:" -ForegroundColor DarkYellow
        foreach ($line in $tail) {
            Write-Host ("    {0}" -f $line) -ForegroundColor Gray
        }
    }

    $diag = if ($Suggestion) { $Suggestion } else { Get-FailureDiagnosis -Stage $Stage -Command $Command -ExitCode $ExitCode -OutputLines $CapturedLines }
    if ($diag) {
        Write-Host ""
        Write-Host ("  Diagnosis : {0}" -f $diag) -ForegroundColor Yellow
    }
    if ($logSavedPath) {
        Write-Host ("  Log File  : {0}" -f $logSavedPath) -ForegroundColor DarkGray
    }
    Write-Host "========================================================================" -ForegroundColor Red
    exit 1
}

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = $CommandTimeoutSeconds,
        [switch]$AllowFailure,
        [switch]$Quiet
    )

    $resolvedCmd = Get-Command $Executable -ErrorAction SilentlyContinue
    $exePath = if ($resolvedCmd) { $resolvedCmd.Source } else { $Executable }

    $formattedArgs = @()
    foreach ($a in $Arguments) {
        $formattedArgs += (Format-CommandArgument -Arg $a)
    }
    $argString = ($formattedArgs -join ' ').Trim()
    $displayCmd = if ($argString) { "$Executable $argString" } else { $Executable }

    if (-not $Quiet) {
        Write-Info "Running: $displayCmd"
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.WorkingDirectory = if ($script:RepoRoot) { $script:RepoRoot } else { (Get-Location).Path }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    if ((Test-IsWindowsHost) -and ($exePath -match '\.(cmd|bat)$')) {
        $psi.FileName = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
        $innerCmd = Format-CommandArgument -Arg $exePath
        if ($argString) {
            $psi.Arguments = "/d /s /c `"$innerCmd $argString`""
        } else {
            $psi.Arguments = "/d /s /c `"$innerCmd`""
        }
    } else {
        $psi.FileName = $exePath
        $psi.Arguments = $argString
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $captured = New-Object System.Collections.Generic.List[string]
    $timedOut = $false
    $exitCode = -1

    try {
        if (-not $proc.Start()) {
            throw "Failed to launch process '$exePath'."
        }

        $outTask = $proc.StandardOutput.ReadLineAsync()
        $errTask = $proc.StandardError.ReadLineAsync()
        $outDone = $false
        $errDone = $false
        $timeoutMs = [Math]::Max(1, $TimeoutSeconds) * 1000

        while (-not ($outDone -and $errDone -and $proc.HasExited)) {
            $madeProgress = $false

            if (-not $outDone -and $outTask.IsCompleted) {
                $line = $outTask.GetAwaiter().GetResult()
                if ($null -eq $line) {
                    $outDone = $true
                } else {
                    $captured.Add($line)
                    if (-not $Quiet) { Write-Host "    $line" }
                    $outTask = $proc.StandardOutput.ReadLineAsync()
                }
                $madeProgress = $true
            }

            if (-not $errDone -and $errTask.IsCompleted) {
                $line = $errTask.GetAwaiter().GetResult()
                if ($null -eq $line) {
                    $errDone = $true
                } else {
                    $captured.Add($line)
                    if (-not $Quiet) { Write-Host "    $line" }
                    $errTask = $proc.StandardError.ReadLineAsync()
                }
                $madeProgress = $true
            }

            if ($sw.ElapsedMilliseconds -ge $timeoutMs) {
                $timedOut = $true
                break
            }

            if (-not $madeProgress) {
                $pending = New-Object System.Collections.Generic.List[System.Threading.Tasks.Task]
                if (-not $outDone) { $pending.Add($outTask) }
                if (-not $errDone) { $pending.Add($errTask) }
                if ($pending.Count -gt 0) {
                    [void][System.Threading.Tasks.Task]::WaitAny($pending.ToArray(), 150)
                } else {
                    [void]$proc.WaitForExit(150)
                }
            }
        }

        if ($timedOut) {
            try {
                if (Test-IsWindowsHost) {
                    & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null
                } else {
                    $proc.Kill()
                }
            } catch {
                try { $proc.Kill() } catch {}
            }
            $exitCode = 124
        } else {
            $proc.WaitForExit()
            $exitCode = $proc.ExitCode
        }
    } finally {
        $proc.Dispose()
        $sw.Stop()
    }

    if ($exitCode -ne 0) {
        if ($AllowFailure) {
            return [PSCustomObject]@{
                ExitCode = $exitCode
                Lines    = $captured.ToArray()
                Command  = $displayCmd
                TimedOut = $timedOut
            }
        }
        $errMsg = if ($timedOut) {
            "$Description timed out after $TimeoutSeconds seconds."
        } else {
            "$Description failed with exit code $exitCode."
        }
        Fail-Build -Message $errMsg -Stage $Description -Command $displayCmd -ExitCode $exitCode -CapturedLines $captured.ToArray()
    }

    if (-not $Quiet) {
        Write-Ok ("{0} completed in {1:N1}s" -f $Description, $sw.Elapsed.TotalSeconds)
    }

    return [PSCustomObject]@{
        ExitCode = 0
        Lines    = $captured.ToArray()
        Command  = $displayCmd
        TimedOut = $false
    }
}

function Resolve-RepoRoot {
    $candidates = @()
    if ($PSScriptRoot) { $candidates += $PSScriptRoot }
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
            if (-not $parent -or $parent -eq $dir) { break }
            $current = Resolve-Path -Path $parent -ErrorAction SilentlyContinue
        }
    }

    Fail-Build -Message "Could not locate repository root containing package.json and src-tauri/tauri.conf.json." -Stage 'Discovery'
}

function Get-ToolVersion {
    param(
        [string]$CommandName,
        [string[]]$CommandArgs = @('--version')
    )
    $cmd = Get-Command $CommandName -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $out = & $cmd.Source @CommandArgs 2>&1
        if ($LASTEXITCODE -ne 0) { return $null }
        return (($out | Out-String).Trim() -split "`r?`n")[0]
    } catch {
        return $null
    }
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

# Load shared read-only lockfile validation helpers (single source of truth)
$buildScriptPath = $PSCommandPath
if ([string]::IsNullOrWhiteSpace($buildScriptPath)) {
    $buildScriptPath = $MyInvocation.MyCommand.Path
}
$buildScriptDir = if (-not [string]::IsNullOrWhiteSpace($buildScriptPath)) {
    Split-Path -LiteralPath (Resolve-Path -LiteralPath $buildScriptPath).Path -Parent
} else {
    Resolve-RepoRoot
}
$lockValidationHelper = Join-Path $buildScriptDir 'scripts/LockfileValidation.ps1'
if (-not (Test-Path -LiteralPath $lockValidationHelper -PathType Leaf)) {
    Fail-Build -Message "Missing required lockfile validation module: $lockValidationHelper" -Stage 'Bootstrap'
}
. $lockValidationHelper

function Test-WindowsBuildPrerequisites {
    param([switch]$StrictFail)

    $pf86 = [Environment]::GetFolderPath('ProgramFilesX86')
    if (-not $pf86) { $pf86 = [Environment]::GetFolderPath('ProgramFiles') }
    $vsWhere = if ($pf86) { Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe' } else { '' }
    $msvcFound = $false
    $msvcDetail = 'Not detected'

    if ($vsWhere -and (Test-Path $vsWhere)) {
        $vsOut = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        $vsPath = ($vsOut | Out-String).Trim()
        if ($vsPath) {
            $msvcFound = $true
            $msvcDetail = $vsPath
        }
    }
    if (-not $msvcFound) {
        $clCmd = Get-Command 'cl.exe' -ErrorAction SilentlyContinue
        $linkCmd = Get-Command 'link.exe' -ErrorAction SilentlyContinue
        if ($clCmd -or $linkCmd) {
            $msvcFound = $true
            $msvcDetail = if ($clCmd) { $clCmd.Source } else { $linkCmd.Source }
        }
    }

    if ($msvcFound) {
        Write-Ok "Visual Studio C++ Build Tools: $msvcDetail"
    } elseif ($StrictFail) {
        Fail-Build -Message "Visual Studio C++ Build Tools (MSVC x64) not found." -Stage 'Toolchain Validation' -Suggestion "Install Visual Studio 2022 Build Tools with 'Desktop development with C++'."
    } else {
        Write-Warn "Visual Studio C++ Build Tools not detected via vswhere/PATH."
    }

    $sdkFound = $false
    $sdkDetail = 'Not detected'
    $kitsKey = 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots'
    if (Test-Path $kitsKey) {
        try {
            $kitsRoot = (Get-ItemProperty -Path $kitsKey -Name 'KitsRoot10' -ErrorAction SilentlyContinue).KitsRoot10
            if ($kitsRoot -and (Test-Path (Join-Path $kitsRoot 'Include'))) {
                $sdkDirs = @(Get-ChildItem -Path (Join-Path $kitsRoot 'Include') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
                if ($sdkDirs.Count -gt 0) {
                    $sdkFound = $true
                    $sdkDetail = "$kitsRoot ($($sdkDirs[0].Name))"
                }
            }
        } catch {}
    }

    if ($sdkFound) {
        Write-Ok "Windows 10/11 SDK: $sdkDetail"
    } elseif ($StrictFail) {
        Fail-Build -Message "Windows 10/11 SDK headers/libraries not found." -Stage 'Toolchain Validation' -Suggestion "Install a Windows 10 or Windows 11 SDK component in Visual Studio Installer."
    } else {
        Write-Warn "Windows 10/11 SDK not detected in registry."
    }

    $wv2Found = $false
    $wv2Version = ''
    foreach ($regPath in @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )) {
        if (Test-Path $regPath) {
            try {
                $pv = (Get-ItemProperty -Path $regPath -Name 'pv' -ErrorAction SilentlyContinue).pv
                if ($pv) {
                    $wv2Found = $true
                    $wv2Version = $pv
                    break
                }
            } catch {}
        }
    }

    if ($wv2Found) {
        Write-Ok "WebView2 Runtime: v$wv2Version"
    } else {
        Write-Warn "WebView2 Runtime registry key not detected (required when running the desktop app on Windows)."
    }
}

# Allow tests and maintenance scripts to dot-source helper functions safely without executing the build.
if ($MyInvocation.InvocationName -eq '.') {
    return
}

# Validate parameter combinations
if ($Release -and $Dev) {
    Fail-Build -Message "Invalid parameters: -Release and -Dev cannot be combined." -Stage 'Arguments'
}
if ($RepairLockfile -and $SkipInstall) {
    Fail-Build -Message "Invalid parameters: -RepairLockfile cannot be combined with -SkipInstall." -Stage 'Arguments'
}

$script:RepoRoot = Resolve-RepoRoot
Set-Location $script:RepoRoot
$script:DistDir = Join-Path $script:RepoRoot 'dist'

$isWindowsHost = Test-IsWindowsHost
$npmExe = Resolve-NpmExecutable
$npxExe = Resolve-NpxExecutable
$tauriConfPath = Join-Path $script:RepoRoot 'src-tauri/tauri.conf.json'
$cargoTomlPath = Join-Path $script:RepoRoot 'src-tauri/Cargo.toml'
$packageJsonPath = Join-Path $script:RepoRoot 'package.json'
$lockfilePath = Join-Path $script:RepoRoot 'package-lock.json'

try {
    $tauriConf = Get-Content -Path $tauriConfPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $packageJson = Get-Content -Path $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail-Build -Message "Failed parsing project manifests (package.json or src-tauri/tauri.conf.json): $_" -Stage 'Manifest Parsing'
}

$productName = if ($tauriConf.productName) { [string]$tauriConf.productName } else { 'VANTA Download Manager' }
$tauriAppVersion = if ($tauriConf.version) { ([string]$tauriConf.version).Trim() } else { '' }
$npmAppVersion = if ($packageJson.version) { ([string]$packageJson.version).Trim() } else { '' }
if ([string]::IsNullOrWhiteSpace($tauriAppVersion) -or [string]::IsNullOrWhiteSpace($npmAppVersion)) {
    Fail-Build -Message "Missing explicit application version in package.json ('$npmAppVersion') or src-tauri/tauri.conf.json ('$tauriAppVersion')." -Stage 'Manifest Parsing'
}
if ($tauriAppVersion -ne $npmAppVersion) {
    Fail-Build -Message "Manifest version mismatch: src-tauri/tauri.conf.json reports '$tauriAppVersion' while package.json reports '$npmAppVersion'." -Stage 'Manifest Parsing'
}
$appVersion = $tauriAppVersion

$versionCheckScript = Join-Path $script:RepoRoot 'scripts/Test-VersionConsistency.ps1'
if (Test-Path -LiteralPath $versionCheckScript -PathType Leaf) {
    & $versionCheckScript -ExpectedVersion $appVersion -RepoRootPath $script:RepoRoot | Out-Null
}
$isReleaseBuild = -not $Dev.IsPresent
if ($Release.IsPresent) { $isReleaseBuild = $true }
$buildModeLabel = if ($RepairLockfile) { 'RepairLockfile' } elseif ($Check) { 'Check (Read-Only)' } elseif ($isReleaseBuild) { 'Release' } else { 'Debug' }
$cargoProfile = if ($isReleaseBuild) { 'release' } else { 'debug' }

if ($RepairLockfile) {
    $script:TotalSteps = 4
} elseif ($Check) {
    $script:TotalSteps = 4
}

Write-Host ""
Write-Host "========================================================================" -ForegroundColor White
Write-Host ("  {0} v{1} — Windows Build Pipeline" -f $productName, $appVersion) -ForegroundColor White
Write-Host ("  Mode: {0} | Target: {1} | Rust Triple: {2}" -f $buildModeLabel, $Target, $RustTarget) -ForegroundColor Gray
Write-Host ("  Root: {0}" -f $script:RepoRoot) -ForegroundColor Gray
Write-Host "========================================================================" -ForegroundColor White

# ------------------------------------------------------------------------------
# RepairLockfile Mode (Explicit Only — Never Run Implicitly During Normal Builds)
# ------------------------------------------------------------------------------
if ($RepairLockfile) {
    Write-Stage "Checking Node.js and npm toolchain for lockfile repair"
    $nodeVer = Get-ToolVersion -CommandName 'node'
    if (-not $nodeVer -or -not $npmExe) {
        Fail-Build -Message "Node.js and npm are required to repair package-lock.json." -Stage 'Lockfile Repair'
    }
    $npmVer = (& $npmExe --version 2>&1 | Out-String).Trim()
    Write-Ok "Node.js $nodeVer | npm $npmVer"

    Write-Stage "Inspecting package.json, lockfiles, and npm configuration"
    foreach ($ambiguousLock in @('bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json')) {
        $ambPath = Join-Path $script:RepoRoot $ambiguousLock
        if (Test-Path $ambPath) {
            Write-Warn "Found extraneous lockfile '$ambiguousLock' alongside package-lock.json."
        }
    }

    $beforeHash = if (Test-Path $lockfilePath) { (Get-FileHash -Algorithm SHA256 -Path $lockfilePath).Hash } else { 'NONE' }
    $lockAuditBefore = Test-LockfileConsistency -LockfilePath $lockfilePath
    Write-Info "Pre-repair lockfile status: $($lockAuditBefore.Reason)"

    $backupPath = Join-Path ([System.IO.Path]::GetTempPath()) ("vanta-lock-backup-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $hadLockfile = Test-Path $lockfilePath
    if ($hadLockfile) {
        Copy-Item -Path $lockfilePath -Destination $backupPath -Force
    }

    Write-Stage "Regenerating package-lock.json with full cross-platform optional dependencies"
    $nodeModulesPath = Join-Path $script:RepoRoot 'node_modules'
    try {
        if (Test-Path $nodeModulesPath) {
            Write-Info "Removing node_modules/ so npm Arborist resolves all OS/CPU optional dependencies cleanly..."
            Remove-Item -Path $nodeModulesPath -Recurse -Force
        }
        if (Test-Path $lockfilePath) {
            Remove-Item -Path $lockfilePath -Force
        }

        Invoke-NativeStep -Description "Regenerate cross-platform package-lock.json" -Executable $npmExe -Arguments @('install', '--package-lock-only', '--ignore-scripts', '--include=optional')

        $lockAuditAfter = Test-LockfileConsistency -LockfilePath $lockfilePath
        if (-not $lockAuditAfter.Valid) {
            throw "Regenerated lockfile failed validation: $($lockAuditAfter.Reason)"
        }
        Write-Ok $lockAuditAfter.Reason
    } catch {
        if ($hadLockfile -and (Test-Path $backupPath)) {
            Copy-Item -Path $backupPath -Destination $lockfilePath -Force
            Write-Warn "Restored original package-lock.json after repair failure."
        }
        Remove-Item -Path $backupPath -Force -ErrorAction SilentlyContinue
        Fail-Build -Message "$_" -Stage 'Lockfile Repair'
    }
    Remove-Item -Path $backupPath -Force -ErrorAction SilentlyContinue

    Write-Stage "Verifying clean installation via npm ci --include=optional"
    if (Test-Path $nodeModulesPath) {
        Remove-Item -Path $nodeModulesPath -Recurse -Force
    }
    Invoke-NativeStep -Description "Verify clean npm ci --include=optional" -Executable $npmExe -Arguments @('ci', '--include=optional')
    Invoke-NativeStep -Description "Verify dependency tree (npm ls --depth=0)" -Executable $npmExe -Arguments @('ls', '--depth=0')
    Invoke-NativeStep -Description "Verify TypeScript check (npm run lint)" -Executable $npmExe -Arguments @('run', 'lint')
    Invoke-NativeStep -Description "Verify Vite production build (npm run build)" -Executable $npmExe -Arguments @('run', 'build')

    $afterHash = (Get-FileHash -Algorithm SHA256 -Path $lockfilePath).Hash
    Write-Host ""
    Write-Ok "package-lock.json SHA256 before: $beforeHash"
    Write-Ok "package-lock.json SHA256 after : $afterHash"

    $gitCmd = Get-Command 'git' -ErrorAction SilentlyContinue
    if ($gitCmd -and (Test-Path (Join-Path $script:RepoRoot '.git'))) {
        Write-Info "Git status after lockfile repair:"
        & $gitCmd.Source status --short
    }

    $script:TotalStopwatch.Stop()
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Green
    Write-Host ("  LOCKFILE REPAIR & CLEAN VERIFICATION SUCCEEDED in {0:N1}s" -f $script:TotalStopwatch.Elapsed.TotalSeconds) -ForegroundColor Green
    Write-Host "========================================================================" -ForegroundColor Green
    exit 0
}

# ------------------------------------------------------------------------------
# Step 1: Validate Toolchains, Windows SDK, Lockfile & Project Resources
# ------------------------------------------------------------------------------
Write-Stage "Validating toolchains, Windows SDK, lockfile, and resources"

$nodeVer = Get-ToolVersion -CommandName 'node'
if (-not $nodeVer -or -not $npmExe -or -not $npxExe) {
    Fail-Build -Message "Node.js / npm is required but not found on PATH." -Stage 'Toolchain Validation' -Suggestion "Install Node.js 20.19+ (Node 24 LTS recommended) from https://nodejs.org/."
}
$npmVer = (& $npmExe --version 2>&1 | Out-String).Trim()
Write-Ok "Node.js $nodeVer | npm $npmVer"

$nodeMatch = [regex]::Match($nodeVer, 'v?(\d+)\.(\d+)\.')
if ($nodeMatch.Success) {
    $nodeMajor = [int]$nodeMatch.Groups[1].Value
    $nodeMinor = [int]$nodeMatch.Groups[2].Value
    if (($nodeMajor -lt 20) -or ($nodeMajor -eq 20 -and $nodeMinor -lt 19)) {
        Fail-Build -Message "Node.js $nodeVer is below minimum required version 20.19.0." -Stage 'Toolchain Validation' -Suggestion "Upgrade to Node.js 24 LTS or >= 20.19.0."
    }
}

$rustcVer = Get-ToolVersion -CommandName 'rustc'
$cargoVer = Get-ToolVersion -CommandName 'cargo'
if (-not $rustcVer -or -not $cargoVer) {
    Fail-Build -Message "Rust / Cargo toolchain was not found on PATH." -Stage 'Toolchain Validation' -Suggestion "Install Rust via https://rustup.rs/."
}
Write-Ok "$rustcVer"
Write-Ok "$cargoVer"

$rustupCmd = Get-Command 'rustup' -ErrorAction SilentlyContinue
if ($rustupCmd) {
    $installedTargets = (& $rustupCmd.Source target list --installed 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0) {
        if ($installedTargets -notmatch [regex]::Escape($RustTarget)) {
            if ($Check) {
                Fail-Build -Message "Required Rust target '$RustTarget' is not installed." -Stage 'Toolchain Validation' -Suggestion "Run: rustup target add $RustTarget"
            } elseif ($isWindowsHost) {
                Write-Warn "Rust target '$RustTarget' is not installed. Adding via rustup..."
                Invoke-NativeStep -Description "Install Rust target $RustTarget" -Executable $rustupCmd.Source -Arguments @('target', 'add', $RustTarget)
            } else {
                Write-Warn "Rust target '$RustTarget' is not installed locally (non-Windows host)."
            }
        } else {
            Write-Ok "Rust target installed: $RustTarget"
        }
    }
} else {
    Write-Warn "rustup not found on PATH; cannot verify installed target triples."
}

if ($isWindowsHost) {
    Test-WindowsBuildPrerequisites -StrictFail:(-not $Check)
} else {
    Write-Warn "Non-Windows host detected; skipping MSVC/Windows SDK/WebView2 registry checks."
}

# Lockfile integrity check (never mutates package-lock.json)
foreach ($dupLock in @('bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml')) {
    if (Test-Path (Join-Path $script:RepoRoot $dupLock)) {
        Fail-Build -Message "Ambiguous duplicate lockfile detected: $dupLock" -Stage 'Lockfile Validation' -Suggestion "Remove $dupLock so package-lock.json is the sole package-manager lockfile."
    }
}

$lockCheck = Test-LockfileConsistency -LockfilePath $lockfilePath -PackageJsonPath $packageJsonPath
if (-not $lockCheck.Valid) {
    Fail-Build -Message $lockCheck.Reason -Stage 'Lockfile Validation' -Suggestion "Run '.\build.ps1 -RepairLockfile' to regenerate package-lock.json with full cross-platform optional dependencies."
}
Write-Ok $lockCheck.Reason

$cargoLockPath = Join-Path $script:RepoRoot 'src-tauri/Cargo.lock'
if (Test-Path -Path $cargoLockPath -PathType Leaf) {
    $cargoLockRaw = Get-Content -Path $cargoLockPath -Raw -Encoding UTF8
    if ($cargoLockRaw -notmatch 'name\s*=\s*"zip"') {
        Write-Warn "src-tauri/Cargo.lock is missing crate entries declared in src-tauri/Cargo.toml (e.g., zip); cargo will refresh Cargo.lock during check/build."
    } else {
        Write-Ok "Cargo.lock basic crate check passed"
    }
} else {
    Write-Warn "src-tauri/Cargo.lock not found; cargo will generate a lockfile on first build."
}

# Tauri capability, icons, and public assets
$capPath = Join-Path $script:RepoRoot 'src-tauri/capabilities/default.json'
if (-not (Test-Path $capPath)) {
    Fail-Build -Message "Missing Tauri capability file: src-tauri/capabilities/default.json" -Stage 'Asset Validation'
}
try {
    Get-Content -Path $capPath -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
} catch {
    Fail-Build -Message "Invalid JSON in src-tauri/capabilities/default.json: $_" -Stage 'Asset Validation'
}
Write-Ok "Tauri capabilities validated: src-tauri/capabilities/default.json"

$nsisHookPath = Join-Path $script:RepoRoot 'src-tauri/nsis/hooks.nsh'
if (-not (Test-Path $nsisHookPath)) {
    Fail-Build -Message "Missing NSIS installer hook script: src-tauri/nsis/hooks.nsh" -Stage 'Asset Validation'
}
Write-Ok "NSIS installer hooks validated: src-tauri/nsis/hooks.nsh"

if ($tauriConf.bundle -and $tauriConf.bundle.icon) {
    foreach ($iconRel in $tauriConf.bundle.icon) {
        $iconFull = Join-Path $script:RepoRoot (Join-Path 'src-tauri' $iconRel)
        if (-not (Test-Path $iconFull)) {
            Fail-Build -Message "Missing configured Tauri bundle icon '$iconRel' at $iconFull." -Stage 'Asset Validation'
        }
    }
    Write-Ok ("Verified {0} configured bundle icon(s) in src-tauri/icons" -f @($tauriConf.bundle.icon).Count)
}

if (-not (Test-Path (Join-Path $script:RepoRoot 'public/favicon.ico')) -or -not (Test-Path (Join-Path $script:RepoRoot 'public/icon.png'))) {
    Fail-Build -Message "Missing required web icon assets in public/ (favicon.ico or icon.png)." -Stage 'Asset Validation'
}
Write-Ok "Frontend public/ icon assets verified"

$tauriBinDir = Join-Path $script:RepoRoot 'src-tauri/bin'
if (Test-Path $tauriBinDir) {
    $bundledBins = @(Get-ChildItem -Path $tauriBinDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.gitkeep' })
    if ($bundledBins.Count -gt 0) {
        Write-Ok ("Found {0} side-by-side binary(ies) in src-tauri/bin" -f $bundledBins.Count)
    } else {
        Write-Info "Slim installer mode: external engines download and SHA-256 verify on first launch."
    }
}

if (-not $isWindowsHost -and -not $Check) {
    Fail-Build -Message "Building Windows installers (.exe / .msi) requires a Windows host (use -Check for pre-flight validation)." -Stage 'Host Check'
}

# ------------------------------------------------------------------------------
# Check Mode Remaining Read-Only Steps (No compilation or workspace mutation)
# ------------------------------------------------------------------------------
if ($Check) {
    Write-Stage "Checking npm lockfile synchronization (dry-run)"
    Invoke-NativeStep -Description "Dry-run npm ci --include=optional" -Executable $npmExe -Arguments @('ci', '--dry-run', '--include=optional')

    Write-Stage "Checking frontend TypeScript & CLI readiness"
    if (Test-Path (Join-Path $script:RepoRoot 'node_modules')) {
        Invoke-NativeStep -Description "TypeScript check (npm run lint)" -Executable $npmExe -Arguments @('run', 'lint')
        $tauriCheck = Invoke-NativeStep -Description "Query Tauri CLI version" -Executable $npxExe -Arguments @('tauri', '--version') -Quiet
        Write-Ok ("Tauri CLI: {0}" -f (($tauriCheck.Lines -join ' ').Trim()))
    } else {
        Write-Warn "node_modules/ is not currently installed; run 'npm ci --include=optional' to populate local workspace dependencies."
    }

    Write-Stage "Checking Rust crate formatting and manifest"
    $formatResult = Invoke-NativeStep -Description "Cargo format check (cargo fmt --all -- --check)" -Executable 'cargo' -Arguments @('fmt', '--manifest-path', $cargoTomlPath, '--all', '--', '--check') -Quiet -AllowFailure
    if ($formatResult.ExitCode -eq 0) {
        Write-Ok "cargo fmt --all -- --check passed"
    } else {
        Write-Warn "Existing Rust formatting differences detected; continuing without rewriting source files. Run 'cargo fmt --all' to apply the formatting pass."
    }
    Invoke-NativeStep -Description "Verify Cargo dependency metadata" -Executable 'cargo' -Arguments @('metadata', '--manifest-path', $cargoTomlPath, '--no-deps', '--format-version', '1', '--locked') -Quiet
    Write-Ok "Cargo.toml metadata validated"

    $script:TotalStopwatch.Stop()
    Write-Host ""
    Write-Host "========================================================================" -ForegroundColor Green
    Write-Host ("  PRE-FLIGHT CHECK PASSED (READ-ONLY) in {0:N1}s" -f $script:TotalStopwatch.Elapsed.TotalSeconds) -ForegroundColor Green
    Write-Host "========================================================================" -ForegroundColor Green
    exit 0
}

# ------------------------------------------------------------------------------
# Step 2: Optional Clean (Preserves source, lockfiles, icons & user data)
# ------------------------------------------------------------------------------
if ($Clean) {
    Write-Stage "Cleaning generated build outputs and Cargo cache"
    foreach ($dirToClean in @('dist', 'release_artifacts', 'portable_package')) {
        $fullCleanPath = Join-Path $script:RepoRoot $dirToClean
        if (Test-Path $fullCleanPath) {
            Write-Info "Removing $dirToClean/"
            Remove-Item -Path $fullCleanPath -Recurse -Force
        }
    }
    Invoke-NativeStep -Description "Cargo clean" -Executable 'cargo' -Arguments @('clean', '--manifest-path', $cargoTomlPath)
} else {
    Write-Stage "Preparing incremental build workspace"
    Write-Info "Incremental build mode (pass -Clean to purge dist/ and Cargo target cache)"
}

# ------------------------------------------------------------------------------
# Step 3: Deterministic Dependency Installation
# ------------------------------------------------------------------------------
Write-Stage "Installing dependencies deterministically (npm ci --include=optional)"

$nodeModulesPath = Join-Path $script:RepoRoot 'node_modules'
$tauriCliBin = if ($isWindowsHost) {
    Join-Path $script:RepoRoot 'node_modules/.bin/tauri.cmd'
} else {
    Join-Path $script:RepoRoot 'node_modules/.bin/tauri'
}

if ($SkipInstall) {
    if (-not (Test-Path $nodeModulesPath) -or -not (Test-Path $tauriCliBin)) {
        Fail-Build -Message "-SkipInstall was requested, but node_modules or Tauri CLI is missing." -Stage 'Dependency Installation' -Suggestion "Re-run without -SkipInstall."
    }
    Write-Ok "Using existing node_modules (-SkipInstall)"
} else {
    Invoke-NativeStep -Description "Clean npm dependency install (npm ci --include=optional)" -Executable $npmExe -Arguments @('ci', '--include=optional')
    Invoke-NativeStep -Description "Verify dependency tree (npm ls --depth=0)" -Executable $npmExe -Arguments @('ls', '--depth=0')
}

$tauriVerRes = Invoke-NativeStep -Description "Verify Tauri CLI" -Executable $npxExe -Arguments @('tauri', '--version') -Quiet
Write-Ok ("Tauri CLI: {0}" -f (($tauriVerRes.Lines -join ' ').Trim()))

# ------------------------------------------------------------------------------
# Step 4: Frontend TypeScript Verification
# ------------------------------------------------------------------------------
Write-Stage "Validating frontend TypeScript sources"
if (-not $SkipTests) {
    Invoke-NativeStep -Description "TypeScript typecheck (npm run lint)" -Executable $npmExe -Arguments @('run', 'lint')
} else {
    Write-Warn "Skipping TypeScript lint check (-SkipTests)"
}

# ------------------------------------------------------------------------------
# Step 5: Rust Backend Formatting & Unit Tests
# ------------------------------------------------------------------------------
Write-Stage "Running Rust checks and unit tests"
if ($SkipTests) {
    Write-Warn "Skipping Rust tests (-SkipTests)"
} else {
    $formatResult = Invoke-NativeStep -Description "Cargo format check (cargo fmt --all -- --check)" -Executable 'cargo' -Arguments @('fmt', '--manifest-path', $cargoTomlPath, '--all', '--', '--check') -Quiet -AllowFailure
    if ($formatResult.ExitCode -eq 0) {
        Write-Ok "cargo fmt --all -- --check passed"
    } else {
        Write-Warn "Existing Rust formatting differences detected; continuing without rewriting source files. Run 'cargo fmt --all' to apply the formatting pass."
    }
    Invoke-NativeStep -Description "Rust unit tests (cargo test --locked)" -Executable 'cargo' -Arguments @('test', '--locked', '--manifest-path', $cargoTomlPath, '--features', 'desktop')
}

# ------------------------------------------------------------------------------
# Step 6: Build Tauri Desktop Application & Installers
# ------------------------------------------------------------------------------
Write-Stage "Building Tauri desktop application ($buildModeLabel / $Target)"

# Remove any prior release deliverables in dist/ before Vite generates ../dist for Tauri embedding
if (Test-Path $script:DistDir) {
    Get-ChildItem -Path $script:DistDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @('.exe', '.msi', '.zip') -or $_.Name -in @('SHA256SUMS.txt', 'build-report.txt', 'last-build-failure.log') } |
        Remove-Item -Force
}

$tauriBuildArgs = @('tauri', 'build', '--ci', '--features', 'desktop', '--target', $RustTarget)
if (-not $isReleaseBuild) {
    $tauriBuildArgs += '--debug'
}

switch ($Target) {
    'nsis'     { $tauriBuildArgs += @('--bundles', 'nsis') }
    'msi'      { $tauriBuildArgs += @('--bundles', 'msi') }
    'portable' { $tauriBuildArgs += '--no-bundle' }
    'all'      { $tauriBuildArgs += @('--bundles', 'nsis,msi') }
}

Invoke-NativeStep -Description "Tauri desktop build" -Executable $npxExe -Arguments $tauriBuildArgs

# ------------------------------------------------------------------------------
# Step 7: Stage & Verify Final Artifacts, Checksums & Build Report in dist/
# ------------------------------------------------------------------------------
Write-Stage "Verifying generated artifacts and creating build report"

$targetOutDir = Join-Path $script:RepoRoot ("src-tauri/target/{0}/{1}" -f $RustTarget, $cargoProfile)
$mainExePath = Join-Path $targetOutDir 'vanta.exe'
if (-not (Test-Path $mainExePath) -or ((Get-Item $mainExePath).Length -eq 0)) {
    Fail-Build -Message "Missing or empty compiled desktop binary at $mainExePath" -Stage 'Artifact Verification'
}

$expectedNsis = ($Target -eq 'all' -or $Target -eq 'nsis')
$expectedMsi = ($Target -eq 'all' -or $Target -eq 'msi')
$expectedPortable = ($Target -eq 'all' -or $Target -eq 'portable')

$nsisFile = $null
if ($expectedNsis) {
    $nsisDir = Join-Path $targetOutDir 'bundle/nsis'
    $nsisFile = Get-ChildItem -Path $nsisDir -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $nsisFile -or $nsisFile.Length -eq 0) {
        Fail-Build -Message "Expected NSIS installer was not generated under $nsisDir" -Stage 'Artifact Verification'
    }
}

$msiFile = $null
if ($expectedMsi) {
    $msiDir = Join-Path $targetOutDir 'bundle/msi'
    $msiFile = Get-ChildItem -Path $msiDir -Filter '*.msi' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $msiFile -or $msiFile.Length -eq 0) {
        Fail-Build -Message "Expected MSI installer was not generated under $msiDir" -Stage 'Artifact Verification'
    }
}

# Remove intermediate Vite files from dist/ (already embedded into vanta.exe by Tauri)
# so dist/ contains only verified release deliverables and reports.
if (Test-Path $script:DistDir) {
    Remove-Item -Path $script:DistDir -Recurse -Force
}
New-Item -ItemType Directory -Path $script:DistDir -Force | Out-Null

$collectedArtifacts = @()

if ($nsisFile) {
    $nsisDest = Join-Path $script:DistDir $nsisFile.Name
    Copy-Item -Path $nsisFile.FullName -Destination $nsisDest -Force
    $collectedArtifacts += [PSCustomObject]@{
        Role = 'NSIS Setup Installer'
        Name = $nsisFile.Name
        Path = $nsisDest
    }
}

if ($msiFile) {
    $msiDest = Join-Path $script:DistDir $msiFile.Name
    Copy-Item -Path $msiFile.FullName -Destination $msiDest -Force
    $collectedArtifacts += [PSCustomObject]@{
        Role = 'Windows MSI Installer'
        Name = $msiFile.Name
        Path = $msiDest
    }
}

if ($expectedPortable) {
    $portableStaging = Join-Path $script:RepoRoot 'portable_package'
    if (Test-Path $portableStaging) {
        Remove-Item -Path $portableStaging -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $portableStaging 'Engine/yt-dlp') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $portableStaging 'Engine/spotdl') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $portableStaging 'Engine/ffmpeg/bin') -Force | Out-Null
    Copy-Item -Path $mainExePath -Destination (Join-Path $portableStaging 'VANTA.exe') -Force

    if (Test-Path $tauriBinDir) {
        Get-ChildItem -Path $tauriBinDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne '.gitkeep' } |
            ForEach-Object {
                $targetSub = if ($_.Name -like '*yt-dlp*') {
                    'Engine/yt-dlp'
                } elseif ($_.Name -like '*ffmpeg*' -or $_.Name -like '*ffprobe*') {
                    'Engine/ffmpeg/bin'
                } elseif ($_.Name -like '*spotdl*') {
                    'Engine/spotdl'
                } else {
                    'Engine'
                }
                Copy-Item -Path $_.FullName -Destination (Join-Path $portableStaging $targetSub) -Force
            }
    }

    $safeProductSlug = ($productName -replace '[^A-Za-z0-9._-]+', '-')
    $portableName = "{0}_{1}_x64-portable.zip" -f $safeProductSlug, $appVersion
    $portableDest = Join-Path $script:DistDir $portableName
    Compress-Archive -Path (Join-Path $portableStaging '*') -DestinationPath $portableDest -CompressionLevel Optimal -Force
    Remove-Item -Path $portableStaging -Recurse -Force

    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
        $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($portableDest)
        try {
            if ($zipArchive.Entries.Count -eq 0) {
                throw "Portable ZIP archive '$portableDest' contains zero entries."
            }
            $exeEntry = $zipArchive.Entries | Where-Object { $_.FullName -ieq 'VANTA.exe' } | Select-Object -First 1
            if (-not $exeEntry -or $exeEntry.Length -le 0) {
                throw "Portable ZIP archive '$portableDest' is missing non-empty VANTA.exe."
            }
        } finally {
            $zipArchive.Dispose()
        }
    } catch {
        Fail-Build -Message "Portable ZIP readability verification failed: $($_.Exception.Message)" -Stage 'Artifact Verification'
    }

    $collectedArtifacts += [PSCustomObject]@{
        Role = 'Portable Standalone ZIP'
        Name = $portableName
        Path = $portableDest
    }
}

$checksumLines = @()
$reportArtifactRows = @()

foreach ($art in $collectedArtifacts) {
    if (-not (Test-Path $art.Path)) {
        Fail-Build -Message "Artifact verification failed: missing $($art.Path)" -Stage 'Artifact Verification'
    }
    $item = Get-Item -Path $art.Path
    if ($item.Length -le 0) {
        Fail-Build -Message "Artifact verification failed: empty file $($art.Path)" -Stage 'Artifact Verification'
    }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $art.Path).Hash.ToLowerInvariant()
    $mib = [Math]::Round($item.Length / 1MB, 2)
    $checksumLines += ("{0}  {1}" -f $hash, $art.Name)
    $reportArtifactRows += ("- {0}: {1} | {2:N0} bytes ({3:N2} MiB) | SHA256: {4}" -f $art.Role, $art.Name, $item.Length, $mib, $hash)
}

$checksumsPath = Join-Path $script:DistDir 'SHA256SUMS.txt'
$checksumLines | Out-File -FilePath $checksumsPath -Encoding ascii

$script:TotalStopwatch.Stop()
$buildTimestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss UTC')
$mainExeItem = Get-Item -Path $mainExePath
$mainExeMib = [Math]::Round($mainExeItem.Length / 1MB, 2)

$gitCommit = 'N/A'
$gitCmd = Get-Command 'git' -ErrorAction SilentlyContinue
if ($gitCmd -and (Test-Path (Join-Path $script:RepoRoot '.git'))) {
    try {
        $rev = (& $gitCmd.Source rev-parse --short HEAD 2>$null | Out-String).Trim()
        if ($rev) { $gitCommit = $rev }
    } catch {
        $gitCommit = 'N/A'
    }
}

$reportPath = Join-Path $script:DistDir 'build-report.txt'
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
