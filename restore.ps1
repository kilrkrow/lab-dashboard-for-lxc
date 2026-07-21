<#
.SYNOPSIS
Restore the LXC webroot from the last local snapshot taken by deploy.ps1.

.DESCRIPTION
Puts backups\lxc-last-good back onto the LXC via rsync. Use when a deploy
breaks the homepage.

Usage:
  .\restore.ps1
  .\restore.ps1 -WhatIf
#>

param(
    [string]$LxcUser = $env:LXC_USER,
    [string]$LxcHost = $env:LXC_HOST,
    [string]$LxcPath = $env:LXC_PATH,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

if (-not $LxcUser -or -not $LxcHost -or -not $LxcPath) {
    Write-Host "Missing LXC connection details." -ForegroundColor Red
    Write-Host "Set LXC_USER / LXC_HOST / LXC_PATH (same as deploy.ps1)." -ForegroundColor Yellow
    exit 1
}

$backupRoot = Join-Path $PSScriptRoot "backups\lxc-last-good"
$backupMeta = Join-Path $PSScriptRoot "backups\lxc-last-good.meta.txt"
$target = "$LxcUser@$LxcHost`:$LxcPath"

if (-not (Test-Path $backupRoot)) {
    Write-Host "No backup found at $backupRoot" -ForegroundColor Red
    Write-Host "A successful .\deploy.ps1 (without -SkipBackup) creates it first." -ForegroundColor Yellow
    exit 1
}

if (Test-Path $backupMeta) {
    Write-Host "=== Backup meta ===" -ForegroundColor Cyan
    Get-Content $backupMeta
    Write-Host ""
}

if ($WhatIf) {
    Write-Host "=== DRY RUN restore ===" -ForegroundColor Yellow
    rsync -avzn --delete "$backupRoot/" $target
    Write-Host "Dry run complete." -ForegroundColor Green
    exit 0
}

Write-Host "=== Restoring backup -> $target ===" -ForegroundColor Cyan
rsync -avz --delete "$backupRoot/" $target

if ($LASTEXITCODE -eq 0) {
    Write-Host "Restore complete. Hard-refresh homepage." -ForegroundColor Green
} else {
    Write-Host "Restore failed." -ForegroundColor Red
    exit 1
}
