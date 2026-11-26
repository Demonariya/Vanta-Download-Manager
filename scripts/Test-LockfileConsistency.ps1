<#
.SYNOPSIS
    Automated regression tests for LockfileValidation.ps1 and Test-VersionConsistency.ps1.
#>
[CmdletBinding()]
param(
    [switch]$IncludeSubprocessTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Safely resolve script path across pwsh/powershell invocation modes without passing null to Split-Path
$scriptPath = $PSCommandPath
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    $scriptPath = $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    $candidate = Join-Path (Get-Location).Path 'scripts\Test-LockfileConsistency.ps1'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $scriptPath = $candidate
    }
}
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    throw 'Unable to resolve Test-LockfileConsistency.ps1 location.'
}

$scriptPath = [System.IO.Path]::GetFullPath($scriptPath)
$scriptDirectory = [System.IO.Path]::GetDirectoryName($scriptPath)
$repoRoot = [System.IO.Path]::GetDirectoryName($scriptDirectory)

$lockHelper = Join-Path $scriptDirectory 'LockfileValidation.ps1'
$versionScript = Join-Path $scriptDirectory 'Test-VersionConsistency.ps1'

if (-not (Test-Path -LiteralPath $lockHelper -PathType Leaf)) {
    throw "Cannot locate LockfileValidation.ps1 at '$lockHelper'"
}
if (-not (Test-Path -LiteralPath $versionScript -PathType Leaf)) {
    throw "Cannot locate Test-VersionConsistency.ps1 at '$versionScript'"
}

# Load ONLY the pure validation helper; never dot-source build.ps1
. $lockHelper

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

# Verify build.ps1 pipeline functions were NOT loaded or executed as a side effect
Assert-True ($null -eq (Get-Command 'Invoke-NativeStep' -ErrorAction SilentlyContinue)) `
    "build.ps1 pipeline symbols should not be loaded when running Test-LockfileConsistency.ps1"

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vanta-lockfile-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    # 1. Real repository package-lock.json must pass cleanly without mutating SHA-256
    $repoLock = Join-Path $repoRoot 'package-lock.json'
    $repoPkg = Join-Path $repoRoot 'package.json'
    $hashBefore = (Get-FileHash -Algorithm SHA256 -Path $repoLock).Hash
    $repoResult = Test-LockfileConsistency -LockfilePath $repoLock -PackageJsonPath $repoPkg
    $hashAfter = (Get-FileHash -Algorithm SHA256 -Path $repoLock).Hash

    Assert-True ($repoResult.Valid -eq $true) "Repository package-lock.json failed validation: $($repoResult.Reason)"
    Assert-True ($hashBefore -eq $hashAfter) "Test-LockfileConsistency mutated repository package-lock.json!"
    Write-Host "[PASS] Real repository package-lock.json validated without mutation"

    # 2. Valid npm v3 lockfile containing empty root key ("") passes cleanly
    $validFixtureDir = Join-Path $tempRoot 'valid-empty-key'
    New-Item -ItemType Directory -Path $validFixtureDir -Force | Out-Null
    $validPkg = Join-Path $validFixtureDir 'package.json'
    $validLock = Join-Path $validFixtureDir 'package-lock.json'
    @'
{
  "name": "fixture-app",
  "version": "0.0.1",
  "dependencies": {
    "demo-pkg": "^1.0.0"
  }
}
'@ | Out-File -FilePath $validPkg -Encoding utf8
    @'
{
  "name": "fixture-app",
  "version": "0.0.1",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "fixture-app",
      "version": "0.0.1",
      "dependencies": {
        "demo-pkg": "^1.0.0"
      }
    },
    "node_modules/demo-pkg": {
      "version": "1.0.0"
    }
  }
}
'@ | Out-File -FilePath $validLock -Encoding utf8
    $validRes = Test-LockfileConsistency -LockfilePath $validLock -PackageJsonPath $validPkg
    Assert-True ($validRes.Valid -eq $true) "Valid lockfile with empty root key failed: $($validRes.Reason)"
    Write-Host "[PASS] Valid npm lockfile with `"`" root package key passed"

    # 3. Malformed JSON fails clearly with invalid-json diagnostic
    $badJsonPath = Join-Path $tempRoot 'bad-json.json'
    '{ "lockfileVersion": 3, "packages": { ' | Out-File -FilePath $badJsonPath -Encoding utf8
    $badJsonRes = Test-LockfileConsistency -LockfilePath $badJsonPath
    Assert-True ($badJsonRes.Valid -eq $false) "Malformed JSON unexpectedly passed validation"
    Assert-True ($badJsonRes.Missing -contains 'invalid-json') "Expected 'invalid-json' marker for malformed JSON"
    Write-Host "[PASS] Malformed JSON distinguished and rejected cleanly"

    # 4. Outdated lockfileVersion, missing packages map, and missing root ("") key fail clearly
    $oldLockPath = Join-Path $tempRoot 'old-version.json'
    '{"name":"x","lockfileVersion":2,"packages":{"":{}}}' | Out-File -FilePath $oldLockPath -Encoding utf8
    $oldRes = Test-LockfileConsistency -LockfilePath $oldLockPath
    Assert-True ($oldRes.Valid -eq $false) "lockfileVersion 2 unexpectedly passed"
    Assert-True ($oldRes.Missing -contains 'lockfileVersion-3') "Expected lockfileVersion-3 marker"

    $noPkgsPath = Join-Path $tempRoot 'no-packages.json'
    '{"name":"x","lockfileVersion":3}' | Out-File -FilePath $noPkgsPath -Encoding utf8
    $noPkgsRes = Test-LockfileConsistency -LockfilePath $noPkgsPath
    Assert-True ($noPkgsRes.Valid -eq $false) "Lockfile missing packages unexpectedly passed"
    Assert-True ($noPkgsRes.Missing -contains 'packages') "Expected packages marker"

    $noRootKeyPath = Join-Path $tempRoot 'no-root-key.json'
    '{"name":"x","lockfileVersion":3,"packages":{"node_modules/foo":{"version":"1.0.0"}}}' | Out-File -FilePath $noRootKeyPath -Encoding utf8
    $noRootRes = Test-LockfileConsistency -LockfilePath $noRootKeyPath
    Assert-True ($noRootRes.Valid -eq $false) "Lockfile missing root '' entry unexpectedly passed"
    Assert-True ($noRootRes.Missing -contains 'root-package') "Expected root-package marker"
    Write-Host "[PASS] Invalid lockfileVersion, missing packages, and missing root key rejected"

    # 5. Missing declared cross-platform optionalDependency fails cleanly
    $missingOptDir = Join-Path $tempRoot 'missing-opt'
    New-Item -ItemType Directory -Path $missingOptDir -Force | Out-Null
    $missingOptLock = Join-Path $missingOptDir 'package-lock.json'
    @'
{
  "name": "fixture-app",
  "version": "0.0.1",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "fixture-app",
      "version": "0.0.1",
      "dependencies": {
        "@tailwindcss/oxide": "^4.3.3"
      }
    },
    "node_modules/@tailwindcss/oxide": {
      "version": "4.3.3",
      "optionalDependencies": {
        "@tailwindcss/oxide-win32-x64-msvc": "4.3.3"
      }
    }
  }
}
'@ | Out-File -FilePath $missingOptLock -Encoding utf8
    $missingOptRes = Test-LockfileConsistency -LockfilePath $missingOptLock
    Assert-True ($missingOptRes.Valid -eq $false) "Lockfile missing optionalDependency unexpectedly passed"
    Assert-True ($missingOptRes.Missing -contains '@tailwindcss/oxide-win32-x64-msvc') "Expected missing '@tailwindcss/oxide-win32-x64-msvc'"
    Write-Host "[PASS] Missing optional dependency detected and rejected"

    # 6. Repository version consistency passes & release tag mismatch is rejected
    & $versionScript -RepoRootPath $repoRoot
    $mismatchCaught = $false
    try {
        & $versionScript -RepoRootPath $repoRoot -ReleaseTag 'v9.9.9' *> $null
    } catch {
        $mismatchCaught = $true
    }
    Assert-True $mismatchCaught "Expected Test-VersionConsistency.ps1 to reject mismatched tag v9.9.9"
    Write-Host "[PASS] Version consistency verified and mismatched release tag rejected"

    # 7. Subprocess invocation tests (repo-root relative and outside-repo absolute path)
    if ($IncludeSubprocessTests) {
        $psExe = (Get-Process -Id $PID).Path
        if ([string]::IsNullOrWhiteSpace($psExe)) {
            $psExe = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh' } else { 'powershell' }
        }

        Push-Location $repoRoot
        try {
            & $psExe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\Test-LockfileConsistency.ps1'
            if ($LASTEXITCODE -ne 0) {
                throw "Relative repo-root invocation failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
        Write-Host "[PASS] Subprocess invocation from repository root succeeded"

        $outsideDir = [System.IO.Path]::GetTempPath()
        Push-Location $outsideDir
        try {
            & $psExe -NoProfile -ExecutionPolicy Bypass -File $scriptPath
            if ($LASTEXITCODE -ne 0) {
                throw "Absolute-path outside-repo invocation failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
        Write-Host "[PASS] Subprocess invocation with absolute path from outside repository succeeded"
    }

    Write-Host ""
    Write-Host "ALL LOCKFILE & VERSION CONSISTENCY TESTS PASSED." -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
