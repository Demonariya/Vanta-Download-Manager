<#
.SYNOPSIS
    Automated verification tests for Test-LockfileConsistency in build.ps1.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$buildScript = Join-Path $repoRoot 'build.ps1'

if (-not (Test-Path -Path $buildScript -PathType Leaf)) {
    throw "Cannot locate build.ps1 at $buildScript"
}

# Dot-source helper functions from build.ps1 without running the build pipeline
. $buildScript

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vanta-lockfile-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    # 1. Actual repository package-lock.json must pass without mutating its SHA-256
    $repoLock = Join-Path $repoRoot 'package-lock.json'
    $repoPkg = Join-Path $repoRoot 'package.json'
    $hashBefore = (Get-FileHash -Algorithm SHA256 -Path $repoLock).Hash
    $repoResult = Test-LockfileConsistency -LockfilePath $repoLock -PackageJsonPath $repoPkg
    $hashAfter = (Get-FileHash -Algorithm SHA256 -Path $repoLock).Hash

    Assert-True ($repoResult.Valid -eq $true) "Repository package-lock.json failed validation: $($repoResult.Reason)"
    Assert-True ($hashBefore -eq $hashAfter) "Test-LockfileConsistency mutated repository package-lock.json!"
    Write-Host "[PASS] Real repository package-lock.json validated without mutation"

    # 2. Synthetic valid npm v3 lockfile containing empty string property key ("") passes cleanly
    $validFixtureDir = Join-Path $tempRoot 'valid-empty-key'
    New-Item -ItemType Directory -Path $validFixtureDir -Force | Out-Null
    $validPkg = Join-Path $validFixtureDir 'package.json'
    $validLock = Join-Path $validFixtureDir 'package-lock.json'
    @'
{
  "name": "fixture-app",
  "version": "1.0.0",
  "dependencies": {
    "demo-pkg": "^1.0.0"
  }
}
'@ | Out-File -FilePath $validPkg -Encoding utf8
    @'
{
  "name": "fixture-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "fixture-app",
      "version": "1.0.0",
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
    Assert-True ($validRes.Valid -eq $true) "Valid lockfile with `"`" root property failed: $($validRes.Reason)"
    Write-Host "[PASS] Lockfile containing empty string property (`"`") parsed and validated"

    # 3. Malformed JSON fails clearly with invalid-json diagnostic
    $badJsonPath = Join-Path $tempRoot 'bad-json.json'
    '{ "lockfileVersion": 3, "packages": { ' | Out-File -FilePath $badJsonPath -Encoding utf8
    $badJsonRes = Test-LockfileConsistency -LockfilePath $badJsonPath
    Assert-True ($badJsonRes.Valid -eq $false) "Malformed JSON unexpectedly passed validation"
    Assert-True ($badJsonRes.Missing -contains 'invalid-json') "Expected 'invalid-json' marker for malformed JSON, got: $($badJsonRes.Missing -join ',')"
    Write-Host "[PASS] Malformed JSON rejected clearly"

    # 4. Outdated lockfileVersion or missing packages map fails cleanly
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
    Write-Host "[PASS] Invalid lockfileVersion and missing packages map rejected cleanly"

    # 5. Missing declared optionalDependency (cross-platform binding) fails cleanly
    $missingOptDir = Join-Path $tempRoot 'missing-opt'
    New-Item -ItemType Directory -Path $missingOptDir -Force | Out-Null
    $missingOptLock = Join-Path $missingOptDir 'package-lock.json'
    @'
{
  "name": "fixture-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "fixture-app",
      "version": "1.0.0",
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
    Assert-True ($missingOptRes.Valid -eq $false) "Lockfile missing declared optionalDependency unexpectedly passed"
    Assert-True ($missingOptRes.Missing -contains '@tailwindcss/oxide-win32-x64-msvc') "Expected missing optional dep '@tailwindcss/oxide-win32-x64-msvc'"
    Write-Host "[PASS] Stripped cross-platform optionalDependency detected and rejected"

    Write-Host ""
    Write-Host "ALL LOCKFILE CONSISTENCY TESTS PASSED." -ForegroundColor Green
} finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
