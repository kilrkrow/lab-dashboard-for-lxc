<#
.SYNOPSIS
Smoke-test the live Haven dashboard (static + optional broker APIs).

.DESCRIPTION
Used by agents after deploy. Exit 0 = critical checks passed.
Exit 1 = homepage or static broken (should restore).
Exit 2 = homepage OK but broker/API soft-fail (report only unless -StrictApi).

Usage:
  .\smoke.ps1
  .\smoke.ps1 -BaseUrl http://192.168.86.4
  .\smoke.ps1 -StrictApi
#>

param(
    [string]$BaseUrl = $env:HAVEN_URL,
    [string]$BrokerUrl = $env:BROKER_URL,
    [switch]$StrictApi
)

$ErrorActionPreference = "Continue"

function Load-DeployEnv {
    $p = Join-Path $PSScriptRoot "deploy.env"
    if (-not (Test-Path $p)) { return }
    Get-Content $p | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
            Set-Item -Path "env:$k" -Value $v
        }
    }
}

Load-DeployEnv
if (-not $BaseUrl) { $BaseUrl = $env:HAVEN_URL }
if (-not $BrokerUrl) { $BrokerUrl = $env:BROKER_URL }
if (-not $BaseUrl) { $BaseUrl = "http://127.0.0.1" }
$BaseUrl = $BaseUrl.TrimEnd("/")
$apiBase = if ($BrokerUrl) { $BrokerUrl.TrimEnd("/") } else { $BaseUrl }

Write-Host "=== Smoke: $BaseUrl (api: $apiBase) ===" -ForegroundColor Cyan

$failedCritical = $false
$failedApi = $false

function Test-Http {
    param([string]$Url, [string]$Label, [switch]$Critical, [scriptblock]$Validate)
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 -Headers @{ "Cache-Control" = "no-store" }
        $ok = $r.StatusCode -ge 200 -and $r.StatusCode -lt 300
        $extra = ""
        if ($ok -and $Validate) {
            $extra = & $Validate $r
            if ($extra -is [hashtable] -and $extra.ok -eq $false) { $ok = $false; $extra = $extra.msg }
            elseif ($extra -is [string]) { }
            else { $extra = "" }
        }
        if ($ok) {
            Write-Host "  OK  $Label  ($($r.StatusCode)) $extra" -ForegroundColor Green
            return $true
        }
        Write-Host "  BAD $Label  ($($r.StatusCode)) $extra" -ForegroundColor Red
        if ($Critical) { $script:failedCritical = $true } else { $script:failedApi = $true }
        return $false
    }
    catch {
        Write-Host "  BAD $Label  $($_.Exception.Message)" -ForegroundColor Red
        if ($Critical) { $script:failedCritical = $true } else { $script:failedApi = $true }
        return $false
    }
}

# Critical: static shell
[void](Test-Http -Url "$BaseUrl/" -Label "GET /" -Critical -Validate {
    param($r)
    if ($r.Content -notmatch 'root|Haven|lab|script') {
        return @{ ok = $false; msg = "HTML missing expected markers" }
    }
    return "html ok"
})

[void](Test-Http -Url "$BaseUrl/index.html" -Label "GET /index.html" -Critical)

# APIs (soft by default - need broker/nginx)
[void](Test-Http -Url "$apiBase/api/health" -Label "GET /api/health" -Validate {
    param($r)
    try {
        $j = $r.Content | ConvertFrom-Json
        return "ok=$($j.ok) unifi=$($j.unifi.site)"
    } catch { return "json?" }
})

[void](Test-Http -Url "$apiBase/api/dr7" -Label "GET /api/dr7" -Validate {
    param($r)
    try {
        $j = $r.Content | ConvertFrom-Json
        if ($j.ok -and $j.data) {
            return "wan=$($j.data.wan.status) down=$([math]::Round($j.data.wan.down_mbps,1))"
        }
        return "ok=$($j.ok) stale=$($j.stale) err=$($j.error)"
    } catch { return "json?" }
})

[void](Test-Http -Url "$apiBase/api/repos?refresh=1" -Label "GET /api/repos?refresh=1" -Validate {
    param($r)
    try {
        $j = $r.Content | ConvertFrom-Json
        $n = 0
        if ($j.data) { $n = @($j.data).Count }
        return "ok=$($j.ok) repos=$n stale=$($j.stale)"
    } catch { return "json?" }
})

Write-Host ""
if ($failedCritical) {
    Write-Host "SMOKE FAIL (critical - restore recommended)" -ForegroundColor Red
    exit 1
}
if ($failedApi) {
    if ($StrictApi) {
        Write-Host "SMOKE FAIL (API strict)" -ForegroundColor Red
        exit 2
    }
    Write-Host "SMOKE PARTIAL (homepage OK; API soft-fail - broker/nginx?)" -ForegroundColor Yellow
    exit 0
}
Write-Host "SMOKE PASS" -ForegroundColor Green
exit 0
