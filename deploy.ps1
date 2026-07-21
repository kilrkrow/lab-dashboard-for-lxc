<#
.SYNOPSIS
One-command build + deploy for the Haven Lab Dashboard.

.DESCRIPTION
Runs the verify gate, builds the static site, optionally backs up the live LXC
webroot, then rsyncs dist/ over SSH.

Usage:
  .\deploy.ps1
  .\deploy.ps1 -WhatIf              # Dry run (no backup, no transfer)
  .\deploy.ps1 -SkipBackup          # Deploy without snapshot (not recommended)
  .\deploy.ps1 -LxcHost 192.168.1.50
  .\restore.ps1                     # Roll live site back to last backup
#>

param(
    [string]$LxcUser = $env:LXC_USER,
    [string]$LxcHost = $env:LXC_HOST,
    [string]$LxcPath = $env:LXC_PATH,
    [switch]$WhatIf,
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"

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
    Write-Host "Check failed — not deploying." -ForegroundColor Red
    exit 1
}

$distPath = Join-Path $PSScriptRoot "dist"
$target = "$LxcUser@$LxcHost`:$LxcPath"
$backupRoot = Join-Path $PSScriptRoot "backups\lxc-last-good"
$backupMeta = Join-Path $PSScriptRoot "backups\lxc-last-good.meta.txt"

Write-Host ""
if ($WhatIf) {
    Write-Host "=== DRY RUN (no backup, no files transferred) ===" -ForegroundColor Yellow
    rsync -avzn --delete "$distPath/" $target
    Write-Host ""
    Write-Host "Dry run complete. Remove -WhatIf to perform the actual deploy." -ForegroundColor Green
    exit 0
}

if (-not $SkipBackup) {
    Write-Host "=== Backup live LXC -> backups\lxc-last-good ===" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    # Mirror current live tree locally so restore.ps1 can put it back.
    rsync -avz --delete "$target/" "$backupRoot/"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Backup failed — abort deploy. Live site untouched by this script." -ForegroundColor Red
        exit 1
    }
    @(
        "backed_up_at=$(Get-Date -Format o)"
        "source=$target"
        "local=$backupRoot"
        "git_head=$(git rev-parse HEAD 2>$null)"
        "git_branch=$(git rev-parse --abbrev-ref HEAD 2>$null)"
    ) | Set-Content -Path $backupMeta -Encoding utf8
    Write-Host "Backup OK. Rollback: .\restore.ps1" -ForegroundColor Green
} else {
    Write-Host "=== SkipBackup set — no live snapshot ===" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Deploying to LXC ===" -ForegroundColor Cyan
Write-Host "Target: $target"
rsync -avz --delete "$distPath/" $target

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Deploy complete." -ForegroundColor Green
    Write-Host "Smoke: open homepage, hard-refresh, check console + tiles." -ForegroundColor Yellow
    Write-Host "Bad?  .\restore.ps1" -ForegroundColor Yellow
} else {
    Write-Host "Deploy failed." -ForegroundColor Red
    if (-not $SkipBackup) {
        Write-Host "Live may be partial. Try: .\restore.ps1" -ForegroundColor Yellow
    }
    exit 1
}
