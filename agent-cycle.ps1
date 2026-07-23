<#
.SYNOPSIS
Agent iteration loop: check, deploy, optional broker ship, smoke, auto-restore on critical fail.

.DESCRIPTION
Enables AI agents to ship integration work to the live LXC without asking the human
to run shell QA each cycle. Requires deploy.env (see deploy.env.example).

Usage:
  .\agent-cycle.ps1
  .\agent-cycle.ps1 -WhatIf
  .\agent-cycle.ps1 -SkipBroker
  .\agent-cycle.ps1 -StrictApi
  .\agent-cycle.ps1 -NoRestore
#>

param(
    [switch]$WhatIf,
    [switch]$SkipBroker,
    [switch]$StrictApi,
    [switch]$NoRestore
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Load-DeployEnv {
    $p = Join-Path $root "deploy.env"
    if (-not (Test-Path $p)) {
        Write-Host "Missing deploy.env - copy deploy.env.example and fill LXC_*/HAVEN_URL/LXC_SSH_KEY." -ForegroundColor Red
        exit 1
    }
    Get-Content $p | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]
            $v = $Matches[2].Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
            Set-Item -Path "env:$k" -Value $v
        }
    }
}

function Require-Env([string[]]$names) {
    foreach ($n in $names) {
        $val = (Get-Item "env:$n" -ErrorAction SilentlyContinue).Value
        if (-not $val) {
            Write-Host "Missing env $n (set in deploy.env)" -ForegroundColor Red
            exit 1
        }
    }
}

Load-DeployEnv
Require-Env @("LXC_USER", "LXC_HOST", "LXC_PATH", "LXC_SSH_KEY", "HAVEN_URL")

if (-not (Test-Path $env:LXC_SSH_KEY)) {
    Write-Host "LXC_SSH_KEY file not found: $($env:LXC_SSH_KEY)" -ForegroundColor Red
    exit 1
}

Write-Host "=== agent-cycle ===" -ForegroundColor Cyan
Write-Host "Host: $($env:LXC_USER)@$($env:LXC_HOST):$($env:LXC_PATH)" -ForegroundColor DarkGray
Write-Host "Smoke: $($env:HAVEN_URL)" -ForegroundColor DarkGray

Write-Host ""
Write-Host "[1/4] npm run check" -ForegroundColor Cyan
npm run check
if ($LASTEXITCODE -ne 0) {
    Write-Host "Check failed - abort (live untouched)." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[2/4] deploy static" -ForegroundColor Cyan
if ($WhatIf) {
    & "$root\deploy.ps1" -WhatIf
    Write-Host "WhatIf done - no live change." -ForegroundColor Green
    exit 0
}

& "$root\deploy.ps1"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Deploy failed - live may be partial; try .\restore.ps1" -ForegroundColor Red
    exit 1
}

if (-not $SkipBroker -and $env:BROKER_REMOTE_DIR) {
    Write-Host ""
    Write-Host "[3/4] ship broker -> $($env:BROKER_REMOTE_DIR)" -ForegroundColor Cyan
    . "$root\RemoteSync.ps1"
    $remoteDir = $env:BROKER_REMOTE_DIR.TrimEnd("/")
    $base = @(Get-SshBaseArgs)
    $user = $env:LXC_USER
    $rhost = $env:LXC_HOST

    $mk = Invoke-NativeExit -FilePath "ssh" -ArgumentList ($base + @(
        "${user}@${rhost}",
        "mkdir -p '$remoteDir/server' '$remoteDir/dist-server' 2>/dev/null; true"
    ))
    if ($mk -ne 0) {
        Write-Host "WARN: could not mkdir broker dir (exit $mk)" -ForegroundColor Yellow
    }

    $scp1 = Invoke-NativeExit -FilePath "scp" -ArgumentList ($base + @(
        (Join-Path $root "server\broker.ts"),
        "${user}@${rhost}:${remoteDir}/server/broker.ts"
    ))
    if ($scp1 -ne 0) {
        Write-Host "Broker scp failed (exit $scp1)" -ForegroundColor Red
        if (-not $NoRestore) {
            Write-Host "Restoring static..." -ForegroundColor Yellow
            & "$root\restore.ps1"
        }
        exit 1
    }

    if (Test-Path (Join-Path $root "dist\index.html")) {
        Write-Host "Sync dist/ into broker remote..." -ForegroundColor DarkGray
        $localDist = Join-Path $root "dist"
        Invoke-SyncToRemote -LocalDir $localDist -RemoteUser $user -RemoteHost $rhost -RemotePath "$remoteDir/dist" -Delete
    }

    if ($env:BROKER_RESTART_CMD) {
        Write-Host "Restart: $($env:BROKER_RESTART_CMD)" -ForegroundColor DarkGray
        $rst = Invoke-NativeExit -FilePath "ssh" -ArgumentList ($base + @(
            "${user}@${rhost}",
            $env:BROKER_RESTART_CMD
        ))
        if ($rst -ne 0) {
            Write-Host "WARN: broker restart exit $rst" -ForegroundColor Yellow
        }
        Start-Sleep -Seconds 2
    }
    else {
        Write-Host "No BROKER_RESTART_CMD - broker code copied; restart manually if needed." -ForegroundColor Yellow
    }
}
else {
    Write-Host ""
    Write-Host "[3/4] skip broker ship (set BROKER_REMOTE_DIR in deploy.env to enable)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "[4/4] smoke" -ForegroundColor Cyan
$smokeArgs = @()
if ($StrictApi) { $smokeArgs += "-StrictApi" }
& "$root\smoke.ps1" @smokeArgs
$smokeCode = $LASTEXITCODE

if ($smokeCode -eq 1) {
    Write-Host "Critical smoke fail." -ForegroundColor Red
    if (-not $NoRestore) {
        Write-Host "Auto-restore last backup..." -ForegroundColor Yellow
        & "$root\restore.ps1"
        Write-Host "Restored. Re-smoke:" -ForegroundColor Yellow
        & "$root\smoke.ps1"
    }
    exit 1
}

if ($smokeCode -eq 2) {
    Write-Host "API strict fail (homepage left as deployed)." -ForegroundColor Red
    exit 2
}

Write-Host ""
Write-Host "CYCLE OK" -ForegroundColor Green
exit 0
