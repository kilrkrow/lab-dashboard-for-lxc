<#
.SYNOPSIS
Restore the LXC webroot from a local timestamped snapshot taken by deploy.ps1.

.DESCRIPTION
Default restores the latest snapshot (backups/lxc-latest.txt).
Use -List to see stamps, -Stamp to pick one, -Path for a full folder path.

Usage:
  .\restore.ps1
  .\restore.ps1 -WhatIf
  .\restore.ps1 -List
  .\restore.ps1 -Stamp 20260721-154512-123
  .\restore.ps1 -Path D:\_dev\lab-dashboard-for-lxc\backups\lxc-20260721-154512-123
#>

param(
    [string]$LxcUser = $env:LXC_USER,
    [string]$LxcHost = $env:LXC_HOST,
    [string]$LxcPath = $env:LXC_PATH,
    [string]$Stamp,
    [string]$Path,
    [switch]$List,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "RemoteSync.ps1")

$backupsRoot = Join-Path $PSScriptRoot "backups"
$latestPointer = Join-Path $backupsRoot "lxc-latest.txt"

function Get-LxcBackupDirs {
    if (-not (Test-Path -LiteralPath $backupsRoot)) { return @() }
    Get-ChildItem -LiteralPath $backupsRoot -Directory -Filter "lxc-*" |
        Sort-Object Name -Descending
}

function Resolve-BackupDir {
    param(
        [string]$StampArg,
        [string]$PathArg
    )

    if ($PathArg) {
        if (-not (Test-Path -LiteralPath $PathArg)) {
            throw "Backup path not found: $PathArg"
        }
        return (Resolve-Path -LiteralPath $PathArg).Path
    }

    if ($StampArg) {
        $candidate = Join-Path $backupsRoot "lxc-$StampArg"
        if (-not (Test-Path -LiteralPath $candidate)) {
            # allow stamp that already includes lxc- prefix
            $candidate2 = Join-Path $backupsRoot $StampArg
            if (Test-Path -LiteralPath $candidate2) { return (Resolve-Path -LiteralPath $candidate2).Path }
            throw "No backup for stamp: $StampArg (looked for $candidate)"
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    if (Test-Path -LiteralPath $latestPointer) {
        $map = @{}
        Get-Content -LiteralPath $latestPointer | ForEach-Object {
            if ($_ -match '^(.*?)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
        }
        if ($map["dir"] -and (Test-Path -LiteralPath $map["dir"])) {
            return $map["dir"]
        }
        if ($map["stamp"]) {
            $c = Join-Path $backupsRoot ("lxc-" + $map["stamp"])
            if (Test-Path -LiteralPath $c) { return (Resolve-Path -LiteralPath $c).Path }
        }
    }

    # Fallback: newest lxc-* directory
    $dirs = @(Get-LxcBackupDirs)
    if ($dirs.Count -eq 0) {
        throw "No backups found under $backupsRoot. Run .\deploy.ps1 (without -SkipBackup) first."
    }
    return $dirs[0].FullName
}

if ($List) {
    Write-Host "=== Local LXC backups (newest first) ===" -ForegroundColor Cyan
    $dirs = @(Get-LxcBackupDirs)
    if ($dirs.Count -eq 0) {
        Write-Host "None under $backupsRoot" -ForegroundColor Yellow
        exit 0
    }
    $latestDir = $null
    try { $latestDir = Resolve-BackupDir -StampArg "" -PathArg "" } catch {}
    foreach ($d in $dirs) {
        $mark = if ($latestDir -and $d.FullName -eq $latestDir) { " [latest]" } else { "" }
        $stampName = $d.Name -replace '^lxc-', ''
        $meta = Join-Path $backupsRoot ("lxc-$stampName.meta.txt")
        if (-not (Test-Path -LiteralPath $meta)) {
            $meta = Join-Path $d.FullName "backup.meta.txt"  # legacy layout
        }
        $when = ""
        if (Test-Path -LiteralPath $meta) {
            $line = Select-String -Path $meta -Pattern "^backed_up_at=" | Select-Object -First 1
            if ($line) { $when = "  " + ($line.Line -replace "^backed_up_at=", "") }
        }
        Write-Host ("{0}{1}{2}" -f $d.Name, $mark, $when)
    }
    Write-Host ""
    Write-Host "Restore one: .\restore.ps1 -Stamp yyyyMMdd-HHmmss-fff" -ForegroundColor DarkGray
    exit 0
}

if (-not $LxcUser -or -not $LxcHost -or -not $LxcPath) {
    Write-Host "Missing LXC connection details." -ForegroundColor Red
    Write-Host "Set LXC_USER / LXC_HOST / LXC_PATH (same as deploy.ps1)." -ForegroundColor Yellow
    exit 1
}

try {
    $backupRoot = Resolve-BackupDir -StampArg $Stamp -PathArg $Path
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host "Tip: .\restore.ps1 -List" -ForegroundColor Yellow
    exit 1
}

$leaf = Split-Path -Leaf $backupRoot
$stampName = $leaf -replace '^lxc-', ''
$backupMeta = Join-Path $backupsRoot ("lxc-$stampName.meta.txt")
if (-not (Test-Path -LiteralPath $backupMeta)) {
    $backupMeta = Join-Path $backupRoot "backup.meta.txt"  # legacy
}
Write-Host "=== Using backup ===" -ForegroundColor Cyan
Write-Host $backupRoot
if (Test-Path -LiteralPath $backupMeta) {
    Get-Content -LiteralPath $backupMeta
    Write-Host ""
}

if ($WhatIf) {
    Write-Host "=== DRY RUN restore ===" -ForegroundColor Yellow
    Invoke-SyncToRemote -LocalDir $backupRoot -RemoteUser $LxcUser -RemoteHost $LxcHost -RemotePath $LxcPath -Delete -DryRun
    Write-Host "Dry run complete." -ForegroundColor Green
    exit 0
}

Write-Host "=== Restoring backup -> ${LxcUser}@${LxcHost}:${LxcPath} ===" -ForegroundColor Cyan
Invoke-SyncToRemote -LocalDir $backupRoot -RemoteUser $LxcUser -RemoteHost $LxcHost -RemotePath $LxcPath -Delete
Write-Host "Restore complete. Hard-refresh homepage." -ForegroundColor Green
