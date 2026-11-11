import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inside } from "../manager.mjs";

test("PowerShell 7 helper preserves profile content and redirects only root/home", { skip: process.platform !== "win32", timeout: 20000 }, () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".runs");
  fs.mkdirSync(root, { recursive: true });
  const base = fs.mkdtempSync(path.join(root, "profile-"));
  fs.copyFileSync(fileURLToPath(new URL("../scripts/install-powershell7.ps1", import.meta.url)), path.join(base, "install.ps1"));
  fs.writeFileSync(path.join(base, "profile.ps1"), "$global:PiTempProfileSentinel = 'preserved'\n");
  fs.writeFileSync(path.join(base, "mock-pi.ps1"), "[pscustomobject]@{ Cwd = (Get-Location).ProviderPath; Args = @($args) } | ConvertTo-Json -Compress\nexit 17\n");
  fs.writeFileSync(path.join(base, "verify.ps1"), `
$ErrorActionPreference = 'Stop'
$piProfile = Join-Path $PSScriptRoot 'profile.ps1'
$piAgent = Join-Path $PSScriptRoot 'agent'
$piMock = Join-Path $PSScriptRoot 'mock-pi.ps1'
$env:PI_TEMP_WORK_ROOT = Join-Path $PSScriptRoot 'custom scratch root'
& (Join-Path $PSScriptRoot 'install.ps1') -ProfilePath $piProfile -AgentDir $piAgent -LauncherPath $piMock | Out-Null
$piFirstProfileText = Get-Content -LiteralPath $piProfile -Raw
& (Join-Path $PSScriptRoot 'install.ps1') -ProfilePath $piProfile -AgentDir $piAgent -LauncherPath $piMock | Out-Null
$piProfileText = Get-Content -LiteralPath $piProfile -Raw
if ($piProfileText -ne $piFirstProfileText) { throw 'Repeated installation changed profile content.' }
if ([regex]::Matches($piProfileText, '# >>> Pi scratch-directory launcher >>>').Count -ne 1) { throw 'Duplicate profile block.' }
. $piProfile
if ($global:PiTempProfileSentinel -ne 'preserved') { throw 'Existing profile content changed.' }
$piProject = Join-Path $PSScriptRoot 'project with spaces'
New-Item -ItemType Directory -Path $piProject -Force | Out-Null
$piCases = @(
    @{ Path = [IO.Path]::GetPathRoot($PSScriptRoot); Scratch = $true },
    @{ Path = [Environment]::GetFolderPath('UserProfile'); Scratch = $true },
    @{ Path = $piProject; Scratch = $false }
)
foreach ($piCase in $piCases) {
    Push-Location -LiteralPath $piCase.Path
    try {
        $piBefore = (Get-Location).ProviderPath
        $piResult = (pi --flag 'value with spaces') | ConvertFrom-Json
        if ($LASTEXITCODE -ne 17) { throw 'Exit code changed.' }
        $piExpected = if ($piCase.Scratch) { (Resolve-Path -LiteralPath $env:PI_TEMP_WORK_ROOT).ProviderPath } else { $piBefore }
        if ($piResult.Cwd -ne $piExpected) { throw ('Unexpected cwd: ' + $piResult.Cwd + ' expected ' + $piExpected) }
        if ($piResult.Args.Count -ne 2 -or $piResult.Args[0] -ne '--flag' -or $piResult.Args[1] -ne 'value with spaces') { throw 'Arguments changed.' }
        if ((Get-Location).ProviderPath -ne $piBefore) { throw 'Shell location changed.' }
    } finally { Pop-Location }
}
Add-Content -LiteralPath $piProfile -Value "# Added after installation"
& (Join-Path $PSScriptRoot 'install.ps1') -ProfilePath $piProfile -AgentDir $piAgent -Uninstall | Out-Null
$piRemovedProfile = Get-Content -LiteralPath $piProfile -Raw
if ($piRemovedProfile -match 'Pi scratch-directory launcher') { throw 'Uninstall left the startup block.' }
if ($piRemovedProfile -notmatch 'Added after installation' -or $piRemovedProfile -notmatch 'preserved') { throw 'Uninstall removed unrelated edits.' }
& (Join-Path $PSScriptRoot 'install.ps1') -ProfilePath $piProfile -AgentDir $piAgent -Uninstall | Out-Null
if ((Get-Content -LiteralPath $piProfile -Raw) -ne $piRemovedProfile) { throw 'Repeated uninstall changed profile.' }
$piCustomWrapper = Join-Path $piAgent 'shell/pi-start.ps1'
Set-Content -LiteralPath $piCustomWrapper -Value '# My personal launcher'
$piRefused = $false
try { & (Join-Path $PSScriptRoot 'install.ps1') -ProfilePath $piProfile -AgentDir $piAgent -LauncherPath $piMock | Out-Null } catch { $piRefused = $true }
if (-not $piRefused) { throw 'Installer overwrote an unrelated launcher.' }
if ((Get-Content -LiteralPath $piCustomWrapper -Raw) -notmatch 'My personal launcher') { throw 'Custom launcher changed.' }
if ((Get-Content -LiteralPath $piProfile -Raw) -ne $piRemovedProfile) { throw 'Failed install changed profile.' }
Add-Content -LiteralPath $piProfile -Value '# >>> Pi scratch-directory launcher >>>'
$piBrokenProfile = Get-Content -LiteralPath $piProfile -Raw
$piRefused = $false
try { & (Join-Path $PSScriptRoot 'install.ps1') -ProfilePath $piProfile -AgentDir $piAgent -Uninstall | Out-Null } catch { $piRefused = $true }
if (-not $piRefused -or (Get-Content -LiteralPath $piProfile -Raw) -ne $piBrokenProfile) { throw 'Incomplete block was modified.' }
Write-Output 'PASS'
`);
  try {
    const output = execFileSync(process.env.PI_TEST_PWSH || "pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(base, "verify.ps1")], { encoding: "utf8", windowsHide: true });
    assert.match(output, /PASS/);
  } finally {
    assert.ok(inside(root, base) && base !== root);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
