<# 
.SYNOPSIS
One-command build + deploy for the Haven Lab Dashboard.

.DESCRIPTION
Builds the static site and deploys it directly to the Proxmox LXC via rsync over SSH.
This is the preferred method for fast agent-driven iteration.

Usage:
  .\deploy.ps1
  .\deploy.ps1 -WhatIf          # Dry run (show what would happen)
  .\deploy.ps1 -LxcHost 192.168.1.50
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
    Write-Host "Set environment variables or pass parameters:" -ForegroundColor Yellow
    Write-Host "  `$env:LXC_USER = 'www-data'" -ForegroundColor Gray
    Write-Host "  `$env:LXC_HOST = '192.168.1.xx'" -ForegroundColor Gray
    Write-Host "  `$env:LXC_PATH = '/var/www/html'" -ForegroundColor Gray
    exit 1
}

Write-Host "=== Building dashboard ===" -ForegroundColor Cyan
npm run build

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed." -ForegroundColor Red
    exit 1
}

$distPath = Join-Path $PSScriptRoot "dist"
$target = "$LxcUser@$LxcHost`:$LxcPath"

Write-Host ""
if ($WhatIf) {
    Write-Host "=== DRY RUN (no files will be transferred) ===" -ForegroundColor Yellow
    rsync -avzn --delete "$distPath/" $target
    Write-Host ""
    Write-Host "Dry run complete. Remove -WhatIf to perform the actual deploy." -ForegroundColor Green
} else {
    Write-Host "=== Deploying to LXC ===" -ForegroundColor Cyan
    Write-Host "Target: $target"

    rsync -avz --delete "$distPath/" $target

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Deploy complete." -ForegroundColor Green
        Write-Host "Site should be updated at https://home.lan.monkiesaresm.art/" -ForegroundColor Yellow
    } else {
        Write-Host "Deploy failed." -ForegroundColor Red
        exit 1
    }
}