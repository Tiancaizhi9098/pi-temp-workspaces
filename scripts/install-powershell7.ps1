#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ProfilePath,
    [string]$AgentDir,
    [string]$LauncherPath,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This startup helper supports PowerShell 7 on Windows.' }
if (-not $ProfilePath) { $ProfilePath = $PROFILE.CurrentUserAllHosts }
if (-not $AgentDir) {
    $AgentDir = if ($env:PI_CODING_AGENT_DIR) {
        $env:PI_CODING_AGENT_DIR
    } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pi/agent' }
}
$AgentDir = [IO.Path]::GetFullPath($AgentDir)
$ProfilePath = [IO.Path]::GetFullPath($ProfilePath)
$piWrapperPath = Join-Path $AgentDir 'shell/pi-start.ps1'
$piBackupDir = Join-Path $AgentDir ('state/pi-temp-workspaces/install-backups/' + [Guid]::NewGuid().ToString('N'))
$piExistingProfile = if (Test-Path -LiteralPath $ProfilePath -PathType Leaf) {
    [IO.File]::ReadAllText($ProfilePath)
} else { '' }
$piPattern = '(?ms)^# >>> Pi scratch-directory launcher >>>.*?^# <<< Pi scratch-directory launcher <<<'
$piOpenCount = [regex]::Matches($piExistingProfile, '(?m)^# >>> Pi scratch-directory launcher >>>').Count
$piCloseCount = [regex]::Matches($piExistingProfile, '(?m)^# <<< Pi scratch-directory launcher <<<').Count
if ($piOpenCount -ne $piCloseCount -or [regex]::Matches($piExistingProfile, $piPattern).Count -ne $piOpenCount) {
    throw 'The Pi profile block is incomplete. Repair its markers before running this helper.'
}
if ($Uninstall) {
    $piUpdatedProfile = [regex]::Replace($piExistingProfile, $piPattern, '')
    if ($piUpdatedProfile -ne $piExistingProfile) {
        New-Item -ItemType Directory -Path $piBackupDir -Force | Out-Null
        Copy-Item -LiteralPath $ProfilePath -Destination (Join-Path $piBackupDir 'profile.ps1')
        [IO.File]::WriteAllText($ProfilePath, $piUpdatedProfile, [Text.UTF8Encoding]::new($false))
    }
    Write-Output 'Removed the Pi startup block. Open a new PowerShell 7 window to use the original Pi command.'
    Write-Output 'Existing backups and the inactive wrapper file are preserved.'
    return
}
if (-not $LauncherPath) {
    $piCommand = Get-Command pi -All -ErrorAction Stop |
        Where-Object { $_.CommandType -in @('ExternalScript', 'Application') } |
        Select-Object -First 1
    if (-not $piCommand) { throw 'Cannot find the underlying Pi launcher on PATH.' }
    $LauncherPath = $piCommand.Source
}
$LauncherPath = (Resolve-Path -LiteralPath $LauncherPath -ErrorAction Stop).ProviderPath
$piWrapper = @'
# Managed by pi-temp-workspaces PowerShell 7 helper.
# Use the temporary parent only at a drive root or the user home.
function global:pi {
    $piLauncher = '__PI_LAUNCHER__'
    $piLocation = Get-Location
    $piUseScratch = $false
    if ($piLocation.Provider.Name -eq 'FileSystem') {
        $piPath = [IO.Path]::GetFullPath($piLocation.ProviderPath).TrimEnd([char[]]'\/')
        $piRoot = [IO.Path]::GetPathRoot($piLocation.ProviderPath).TrimEnd([char[]]'\/')
        $piHomePath = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd([char[]]'\/')
        $piUseScratch = [string]::Equals($piPath, $piRoot, [StringComparison]::OrdinalIgnoreCase) -or
            [string]::Equals($piPath, $piHomePath, [StringComparison]::OrdinalIgnoreCase)
    }
    $piPushedLocation = $false
    if ($piUseScratch) {
        $piScratchPath = if ($env:PI_TEMP_WORK_ROOT) { $env:PI_TEMP_WORK_ROOT } else { Join-Path ([IO.Path]::GetTempPath()) 'Pi-Work' }
        if (-not [IO.Path]::IsPathFullyQualified($piScratchPath)) { throw 'PI_TEMP_WORK_ROOT must be an absolute path.' }
        New-Item -ItemType Directory -Path $piScratchPath -Force -ErrorAction Stop | Out-Null
        Push-Location -LiteralPath $piScratchPath -ErrorAction Stop
        $piPushedLocation = $true
    }
    try {
        & $piLauncher @args
        $piCommandExitCode = $LASTEXITCODE
    } finally {
        if ($piPushedLocation) { Pop-Location }
    }
    $global:LASTEXITCODE = $piCommandExitCode
}
'@
$piWrapper = $piWrapper.Replace('__PI_LAUNCHER__', $LauncherPath.Replace("'", "''"))
$piTokens = $null
$piErrors = $null
[void][Management.Automation.Language.Parser]::ParseInput($piWrapper, [ref]$piTokens, [ref]$piErrors)
if ($piErrors.Count) { throw ($piErrors | Out-String) }

$piProfileBlock = "# >>> Pi scratch-directory launcher >>>`n. '" + $piWrapperPath.Replace("'", "''") + "'`n# <<< Pi scratch-directory launcher <<<"
$piUpdatedProfile = if ($piExistingProfile -match $piPattern) {
    [regex]::Replace($piExistingProfile, $piPattern, [Text.RegularExpressions.MatchEvaluator]{ param($m) $piProfileBlock })
} else { $piExistingProfile + "`n" + $piProfileBlock }
if (-not $piUpdatedProfile.EndsWith("`n")) { $piUpdatedProfile += "`n" }

if (Test-Path -LiteralPath $piWrapperPath -PathType Leaf) {
    $piOldWrapper = [IO.File]::ReadAllText($piWrapperPath)
    if (-not $piOldWrapper.StartsWith('# Managed by pi-temp-workspaces PowerShell 7 helper.')) {
        throw "Refusing to replace an existing unrecognized wrapper: $piWrapperPath. Move it aside first."
    }
}

foreach ($piFile in @($ProfilePath, $piWrapperPath)) {
    if (Test-Path -LiteralPath $piFile -PathType Leaf) {
        New-Item -ItemType Directory -Path $piBackupDir -Force | Out-Null
        $piBackupName = if ($piFile -eq $ProfilePath) { 'profile.ps1' } else { 'pi-start.ps1' }
        Copy-Item -LiteralPath $piFile -Destination (Join-Path $piBackupDir $piBackupName)
    }
}
New-Item -ItemType Directory -Path (Split-Path -Parent $piWrapperPath) -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $ProfilePath) -Force | Out-Null
[IO.File]::WriteAllText($piWrapperPath, $piWrapper + "`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($ProfilePath, $piUpdatedProfile, [Text.UTF8Encoding]::new($false))
Write-Output "Configured Pi startup for PowerShell 7: $ProfilePath"
Write-Output 'Open a new PowerShell 7 window, or reload $PROFILE.CurrentUserAllHosts.'
