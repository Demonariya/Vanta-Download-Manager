<#
.SYNOPSIS
    Shared, read-only npm package-lock.json validation helpers for VANTA Download Manager.
.DESCRIPTION
    Pure helper module loaded by build.ps1 and scripts/Test-LockfileConsistency.ps1.
    Importing this file performs zero filesystem mutations and zero build actions.
#>

function ConvertFrom-JsonDictionary {
    param(
        [Parameter(Mandatory = $true)]
        [string]$JsonText
    )

    if ($PSVersionTable.PSVersion.Major -ge 6) {
        return (ConvertFrom-Json -InputObject $JsonText -AsHashtable)
    }

    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    return $serializer.DeserializeObject($JsonText)
}

function Test-LockfileConsistency {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LockfilePath,
        [string]$PackageJsonPath = ''
    )

    if ([string]::IsNullOrWhiteSpace($LockfilePath) -or -not (Test-Path -LiteralPath $LockfilePath -PathType Leaf)) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "Missing package-lock.json at '$LockfilePath'."
            Missing = @('package-lock.json')
        }
    }

    $rawLock = Get-Content -LiteralPath $LockfilePath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($rawLock)) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json is empty."
            Missing = @('invalid-json')
        }
    }

    try {
        $lock = ConvertFrom-JsonDictionary -JsonText $rawLock
    } catch {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json is not valid JSON: $($_.Exception.Message)"
            Missing = @('invalid-json')
        }
    }

    if (-not ($lock -is [System.Collections.IDictionary])) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json root must be a JSON object."
            Missing = @('invalid-json')
        }
    }

    if (-not $lock.Contains('lockfileVersion') -or $null -eq $lock['lockfileVersion']) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json is missing 'lockfileVersion'."
            Missing = @('lockfileVersion-3')
        }
    }

    try {
        $lockVersion = [int]$lock['lockfileVersion']
    } catch {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json has non-numeric lockfileVersion '$($lock['lockfileVersion'])'."
            Missing = @('lockfileVersion-3')
        }
    }

    if ($lockVersion -lt 3) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json uses lockfileVersion $lockVersion; expected lockfileVersion 3."
            Missing = @('lockfileVersion-3')
        }
    }

    if (-not $lock.Contains('packages') -or -not ($lock['packages'] -is [System.Collections.IDictionary])) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json is missing the 'packages' dependency map."
            Missing = @('packages')
        }
    }

    $packagesMap = $lock['packages']
    if (-not $packagesMap.Contains('') -or -not ($packagesMap[''] -is [System.Collections.IDictionary])) {
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json is missing root package entry (`"`") inside 'packages'."
            Missing = @('root-package')
        }
    }

    $missing = New-Object System.Collections.Generic.List[string]
    $rootEntry = $packagesMap['']

    $resolvedPkgJson = if (-not [string]::IsNullOrWhiteSpace($PackageJsonPath)) {
        $PackageJsonPath
    } else {
        $parentDir = Split-Path -LiteralPath $LockfilePath -Parent
        if (-not [string]::IsNullOrWhiteSpace($parentDir)) {
            Join-Path $parentDir 'package.json'
        } else {
            ''
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($resolvedPkgJson) -and (Test-Path -LiteralPath $resolvedPkgJson -PathType Leaf)) {
        $rawPkg = Get-Content -LiteralPath $resolvedPkgJson -Raw -Encoding UTF8
        try {
            $pkgDoc = ConvertFrom-JsonDictionary -JsonText $rawPkg
        } catch {
            return [PSCustomObject]@{
                Valid   = $false
                Reason  = "package.json is not valid JSON: $($_.Exception.Message)"
                Missing = @('invalid-package-json')
            }
        }

        if ($pkgDoc -is [System.Collections.IDictionary]) {
            foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies')) {
                if ($pkgDoc.Contains($section) -and ($pkgDoc[$section] -is [System.Collections.IDictionary])) {
                    $rootSection = if ($rootEntry.Contains($section) -and ($rootEntry[$section] -is [System.Collections.IDictionary])) {
                        $rootEntry[$section]
                    } else {
                        $null
                    }
                    foreach ($depName in $pkgDoc[$section].Keys) {
                        $expectedSpec = [string]$pkgDoc[$section][$depName]
                        if (-not $rootSection -or -not $rootSection.Contains($depName) -or ([string]$rootSection[$depName] -ne $expectedSpec)) {
                            [void]$missing.Add("root:$depName")
                        }
                        if (-not $packagesMap.Contains("node_modules/$depName")) {
                            [void]$missing.Add([string]$depName)
                        }
                    }
                }
            }
        }
    }

    # Verify declared optionalDependencies entries exist in packages (catches stripped cross-platform native bindings)
    foreach ($pkgKey in $packagesMap.Keys) {
        $pkgMeta = $packagesMap[$pkgKey]
        if (-not ($pkgMeta -is [System.Collections.IDictionary])) { continue }
        if (-not $pkgMeta.Contains('optionalDependencies') -or -not ($pkgMeta['optionalDependencies'] -is [System.Collections.IDictionary])) {
            continue
        }

        foreach ($optName in $pkgMeta['optionalDependencies'].Keys) {
            $topLevelKey = "node_modules/$optName"
            $nestedKey = if ([string]::IsNullOrEmpty([string]$pkgKey)) { $topLevelKey } else { "$pkgKey/node_modules/$optName" }
            if (-not $packagesMap.Contains($topLevelKey) -and -not $packagesMap.Contains($nestedKey)) {
                if (-not $missing.Contains([string]$optName)) {
                    [void]$missing.Add([string]$optName)
                }
            }
        }
    }

    if ($missing.Count -gt 0) {
        $uniqueMissing = @($missing | Select-Object -Unique)
        return [PSCustomObject]@{
            Valid   = $false
            Reason  = "package-lock.json is out of sync or missing optional dependencies: $($uniqueMissing -join ', ')"
            Missing = $uniqueMissing
        }
    }

    return [PSCustomObject]@{
        Valid   = $true
        Reason  = "Lockfile consistency and cross-platform optional dependencies verified (lockfileVersion $lockVersion, $($packagesMap.Count) packages)."
        Missing = @()
    }
}
