<#
.SYNOPSIS
One-command build + deploy for the Haven Lab Dashboard.

.DESCRIPTION
Runs the verify gate, builds the static site, optionally backs up the live LXC
webroot into a timestamped folder (ms precision, never overwrites), then syncs dist/.

Usage:
  .\deploy.ps1
  .\deploy.ps1 -WhatIf
  .\deploy.ps1 -SkipBackup
  .\deploy.ps1 -LxcHost 192.168.1.50
  .\restore.ps1
  .\restore.ps1 -List
#>

param(
    [string]$LxcUser = $env:LXC_USER,
    [string]$LxcHost = $env:LXC_HOST,
    [string]$LxcPath = $env:LXC_PATH,
    [switch]$WhatIf,
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "RemoteSync.ps1")

function New-LxcBackupStamp {
    # Filesystem-safe, sortable, millisecond precision: 20260721-154512-123
    return (Get-Date).ToString("yyyyMMdd-HHmmss-fff")
}

function Get-UniqueBackupDir {
    param([string]$BackupsRoot)
    $stamp = New-LxcBackupStamp
    $dir = Join-Path $BackupsRoot "lxc-$stamp"
    # If same ms somehow exists, keep bumping until free
    $n = 0
    while (Test-Path -LiteralPath $dir) {
        $n++
        $dir = Join-Path $BackupsRoot ("lxc-$stamp-n{0:D2}" -f $n)
        if ($n -gt 99) { throw "Could not allocate unique backup directory under $BackupsRoot" }
    }
    return @{ Stamp = $stamp; Dir = $dir }
}

if (-not $LxcUser -or -not $LxcHost -or -not $LxcPath) {
    Write-Host "Missing LXC connection details." -ForegroundColor Red
    Write-Host "Set environment variables or pass parameters:" -ForegroundColor Yellow
    Write-Host "  `$env:LXC_USER = 'www-data'" -ForegroundColor Gray
    Write-Host "  `$env:LXC_HOST = '192.168.1.xx'" -ForegroundColor Gray
    Write-Host "  `$env:LXC_PATH = '/var/www/html'" -ForegroundColor Gray
    exit 1
}

Write-Host "=== Verify gate (npm run check) ===" -ForegroundColor Cyan
npm run check
if ($LASTEXITCODE -ne 0) {
    Write-Host "Check failed - not deploying." -ForegroundColor Red
    exit 1
}

$distPath = Join-Path $PSScriptRoot "dist"
$backupsRoot = Join-Path $PSScriptRoot "backups"
$latestPointer = Join-Path $backupsRoot "lxc-latest.txt"

Write-Host ""
if ($WhatIf) {
    Write-Host "=== DRY RUN (no backup, no files transferred) ===" -ForegroundColor Yellow
    $preview = Get-UniqueBackupDir -BackupsRoot $backupsRoot
    Write-Host "Would create new backup dir (never overwrite): $($preview.Dir)" -ForegroundColor DarkGray
    Invoke-SyncToRemote -LocalDir $distPath -RemoteUser $LxcUser -RemoteHost $LxcHost -RemotePath $LxcPath -Delete -DryRun
    Write-Host ""
    Write-Host "Dry run complete. Remove -WhatIf to perform the actual deploy." -ForegroundColor Green
    exit 0
}

$backupDir = $null
if (-not $SkipBackup) {
    New-Item -ItemType Directory -Force -Path $backupsRoot | Out-Null
    $slot = Get-UniqueBackupDir -BackupsRoot $backupsRoot
    $backupDir = $slot.Dir
    $stamp = $slot.Stamp

    Write-Host "=== Backup live LXC (timestamped, no overwrite) ===" -ForegroundColor Cyan
    Write-Host "Stamp: $stamp" -ForegroundColor DarkGray
    Write-Host "Dir:   $backupDir" -ForegroundColor DarkGray

    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    try {
        Invoke-SyncFromRemote -LocalDir $backupDir -RemoteUser $LxcUser -RemoteHost $LxcHost -RemotePath $LxcPath
    }
    catch {
        Write-Host "Backup FAILED - abort deploy. Live site not modified by deploy step." -ForegroundColor Red
        if ((Test-Path -LiteralPath $backupDir) -and -not (Get-ChildItem -LiteralPath $backupDir -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $backupDir -Force -ErrorAction SilentlyContinue
        }
        throw
    }

    $gitHead = ""
    $gitBranch = ""
    try { $gitHead = (git rev-parse HEAD 2>$null) } catch {}
    try { $gitBranch = (git rev-parse --abbrev-ref HEAD 2>$null) } catch {}

    # Meta lives BESIDE the tree so restore does not upload it to the LXC
    $metaPath = Join-Path $backupsRoot ("lxc-$stamp.meta.txt")
    @(
        "stamp=$stamp"
        "backed_up_at=$((Get-Date).ToString('o'))"
        "source=${LxcUser}@${LxcHost}:${LxcPath}"
        "local=$backupDir"
        "git_head=$gitHead"
        "git_branch=$gitBranch"
    ) | Set-Content -Path $metaPath -Encoding utf8

    # Pointer for restore.ps1 default (text file, not a second copy of the tree)
    @(
        "stamp=$stamp"
        "dir=$backupDir"
        "meta=$metaPath"
        "created_at=$((Get-Date).ToString('o'))"
    ) | Set-Content -Path $latestPointer -Encoding utf8

    Write-Host "Backup OK." -ForegroundColor Green
    Write-Host "Rollback latest: .\restore.ps1" -ForegroundColor Green
    Write-Host "Rollback pick:   .\restore.ps1 -List   then  .\restore.ps1 -Stamp $stamp" -ForegroundColor Green
}
else {
    Write-Host "=== SkipBackup set - no live snapshot ===" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Deploying to LXC ===" -ForegroundColor Cyan
Write-Host "Target: ${LxcUser}@${LxcHost}:${LxcPath}"
Invoke-SyncToRemote -LocalDir $distPath -RemoteUser $LxcUser -RemoteHost $LxcHost -RemotePath $LxcPath -Delete

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
Write-Host "Smoke: open homepage, hard-refresh, check console + tiles." -ForegroundColor Yellow
if ($backupDir) {
    Write-Host "Bad?  .\restore.ps1   (or -Stamp $($slot.Stamp))" -ForegroundColor Yellow
}
else {
    Write-Host "Bad?  no backup this run (SkipBackup). Use an older .\restore.ps1 -List" -ForegroundColor Yellow
}
