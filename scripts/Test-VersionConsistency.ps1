<#
.SYNOPSIS
    Verifies synchronized application version across all VANTA Download Manager manifests and lockfiles.
#>
[CmdletBinding()]
param(
    [string]$ExpectedVersion = '',
    [string]$ReleaseTag = '',
    [string]$RepoRootPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = $PSCommandPath
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    $scriptPath = $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    $candidate = Join-Path (Get-Location).Path 'scripts\Test-VersionConsistency.ps1'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $scriptPath = $candidate
    }
}
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    throw 'Unable to resolve Test-VersionConsistency.ps1 location.'
}

$scriptPath = [System.IO.Path]::GetFullPath($scriptPath)
$scriptDirectory = [System.IO.Path]::GetDirectoryName($scriptPath)
$repoRoot = if (-not [string]::IsNullOrWhiteSpace($RepoRootPath)) {
    [System.IO.Path]::GetFullPath($RepoRootPath)
} else {
    [System.IO.Path]::GetDirectoryName($scriptDirectory)
}

$lockValidationHelper = Join-Path $scriptDirectory 'LockfileValidation.ps1'
if (-not (Test-Path -LiteralPath $lockValidationHelper -PathType Leaf)) {
    throw "Missing required helper module: $lockValidationHelper"
}
. $lockValidationHelper

$packageJsonPath = Join-Path $repoRoot 'package.json'
$packageLockPath = Join-Path $repoRoot 'package-lock.json'
$tauriConfPath   = Join-Path $repoRoot 'src-tauri/tauri.conf.json'
$cargoTomlPath   = Join-Path $repoRoot 'src-tauri/Cargo.toml'
$cargoLockPath   = Join-Path $repoRoot 'src-tauri/Cargo.lock'

foreach ($required in @($packageJsonPath, $packageLockPath, $tauriConfPath, $cargoTomlPath, $cargoLockPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required version manifest or lockfile is missing: $required"
    }
}

$pkgJson = ConvertFrom-JsonDictionary -JsonText (Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8)
$pkgLock = ConvertFrom-JsonDictionary -JsonText (Get-Content -LiteralPath $packageLockPath -Raw -Encoding UTF8)
$tauriConf = ConvertFrom-JsonDictionary -JsonText (Get-Content -LiteralPath $tauriConfPath -Raw -Encoding UTF8)

$pkgVersion = if ($pkgJson.Contains('version')) { [string]$pkgJson['version'] } else { '' }
$lockRootVersion = if ($pkgLock.Contains('version')) { [string]$pkgLock['version'] } else { '' }
$lockPackagesRootVersion = ''
if ($pkgLock.Contains('packages') -and ($pkgLock['packages'] -is [System.Collections.IDictionary]) -and $pkgLock['packages'].Contains('')) {
    $rootPkgEntry = $pkgLock['packages']['']
    if (($rootPkgEntry -is [System.Collections.IDictionary]) -and $rootPkgEntry.Contains('version')) {
        $lockPackagesRootVersion = [string]$rootPkgEntry['version']
    }
}
$tauriVersion = if ($tauriConf.Contains('version')) { [string]$tauriConf['version'] } else { '' }

# Extract [package] version cleanly from Cargo.toml
$cargoTomlLines = Get-Content -LiteralPath $cargoTomlPath -Encoding UTF8
$inPackageSection = $false
$cargoTomlPackageName = ''
$cargoTomlVersion = ''
foreach ($rawLine in $cargoTomlLines) {
    $line = $rawLine.Trim()
    if ($line -match '^\[([^\]]+)\]') {
        $inPackageSection = ($Matches[1].Trim() -eq 'package')
        continue
    }
    if (-not $inPackageSection -or $line.StartsWith('#') -or [string]::IsNullOrWhiteSpace($line)) {
        continue
    }
    if ($line -match '^name\s*=\s*"([^"]+)"') {
        $cargoTomlPackageName = $Matches[1]
    } elseif ($line -match '^version\s*=\s*"([^"]+)"') {
        $cargoTomlVersion = $Matches[1]
    }
}

if ([string]::IsNullOrWhiteSpace($cargoTomlPackageName)) {
    throw "Could not locate [package] name in $cargoTomlPath"
}

# Extract local application package version from Cargo.lock
$cargoLockLines = Get-Content -LiteralPath $cargoLockPath -Encoding UTF8
$cargoLockVersion = ''
$inTargetBlock = $false
$pendingNameMatch = $false
foreach ($rawLine in $cargoLockLines) {
    $line = $rawLine.Trim()
    if ($line -eq '[[package]]') {
        $inTargetBlock = $true
        $pendingNameMatch = $false
        continue
    }
    if (-not $inTargetBlock) { continue }
    if ($line -match '^name\s*=\s*"([^"]+)"') {
        $pendingNameMatch = ($Matches[1] -eq $cargoTomlPackageName)
        continue
    }
    if ($pendingNameMatch -and ($line -match '^version\s*=\s*"([^"]+)"')) {
        $cargoLockVersion = $Matches[1]
        break
    }
}

$records = @(
    [PSCustomObject]@{ Source = 'package.json';                    Version = $pkgVersion }
    [PSCustomObject]@{ Source = 'package-lock.json (version)';     Version = $lockRootVersion }
    [PSCustomObject]@{ Source = 'package-lock.json (packages[""])'; Version = $lockPackagesRootVersion }
    [PSCustomObject]@{ Source = 'src-tauri/tauri.conf.json';       Version = $tauriVersion }
    [PSCustomObject]@{ Source = 'src-tauri/Cargo.toml';            Version = $cargoTomlVersion }
    [PSCustomObject]@{ Source = "src-tauri/Cargo.lock ($cargoTomlPackageName)"; Version = $cargoLockVersion }
)

$semverPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'
$errors = New-Object System.Collections.Generic.List[string]

foreach ($rec in $records) {
    if ([string]::IsNullOrWhiteSpace($rec.Version)) {
        [void]$errors.Add("$($rec.Source): missing version")
    } elseif ($rec.Version -notmatch $semverPattern) {
        [void]$errors.Add("$($rec.Source): invalid semantic version '$($rec.Version)'")
    }
}

$canonicalVersion = if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $ExpectedVersion.Trim()
} else {
    $pkgVersion
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion) -and ($canonicalVersion -notmatch $semverPattern)) {
    [void]$errors.Add("ExpectedVersion '$canonicalVersion' is not valid semantic version X.Y.Z")
}

foreach ($rec in $records) {
    if ($rec.Version -ne $canonicalVersion) {
        [void]$errors.Add("$($rec.Source) reports '$($rec.Version)', expected '$canonicalVersion'")
    }
}

if (-not [string]::IsNullOrWhiteSpace($ReleaseTag)) {
    $trimmedTag = $ReleaseTag.Trim()
    $tagPattern = '^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'
    if ($trimmedTag -notmatch $tagPattern) {
        [void]$errors.Add("Release tag '$trimmedTag' does not match vX.Y.Z semantic version format")
    } elseif ($trimmedTag.Substring(1) -ne $canonicalVersion) {
        [void]$errors.Add("Release tag '$trimmedTag' does not match manifest version '$canonicalVersion' (expected 'v$canonicalVersion')")
    }
}

Write-Host "VANTA Version Consistency Audit:" -ForegroundColor Cyan
foreach ($rec in $records) {
    Write-Host ("  - {0,-38} : {1}" -f $rec.Source, $rec.Version)
}
if (-not [string]::IsNullOrWhiteSpace($ReleaseTag)) {
    Write-Host ("  - {0,-38} : {1}" -f 'Release Tag', $ReleaseTag.Trim())
}

if ($errors.Count -gt 0) {
    throw ("Version consistency verification failed:`n - " + ($errors -join "`n - "))
}

Write-Host "[OK] All application manifests and lockfiles match version '$canonicalVersion'." -ForegroundColor Green
