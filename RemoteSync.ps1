# Shared remote file sync for deploy.ps1 / restore.ps1
# Prefers native rsync; falls back to Windows OpenSSH (ssh + tar).
#
# Safety: deploy never wipes the whole webroot. It only replaces files that
# ship in dist/ (index.html, assets/, icons, etc.) and leaves config.json,
# .git, broker files, and other host state alone.
#
# ssh-tar uses temp .tar files (not pipes) so SSH failures cannot be masked
# by a successful empty tar extract.

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-SyncBackend {
    # Prefer native tools. WSL rsync is opt-in only (can hang on some Windows setups).
    if (Test-CommandExists "rsync") { return "rsync" }
    if ((Test-CommandExists "ssh") -and (Test-CommandExists "tar")) { return "ssh-tar" }
    if ($env:HAVEN_USE_WSL_RSYNC -eq "1" -and (Test-CommandExists "wsl")) {
        $wslRsync = & wsl bash -lc "command -v rsync" 2>$null
        if ($LASTEXITCODE -eq 0 -and $wslRsync) { return "wsl-rsync" }
    }
    return $null
}

function ConvertTo-WslPath {
    param([string]$WindowsPath)
    $full = (Resolve-Path -LiteralPath $WindowsPath).Path
    if ($full -match '^([A-Za-z]):\\(.*)$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = ($Matches[2] -replace '\\', '/')
        return "/mnt/$drive/$rest"
    }
    return $full -replace '\\', '/'
}

function Get-DistTopLevelNames {
    param([string]$LocalDir)
    Get-ChildItem -LiteralPath $LocalDir -Force | ForEach-Object { $_.Name }
}

function Get-RemotePrepRemoveManaged {
    param(
        [string]$Dest,
        [string[]]$Names
    )
    $quoted = ($Names | ForEach-Object {
        $n = $_ -replace "'", "'\''"
        "'$Dest/$n'"
    }) -join " "
    return "mkdir -p '$Dest' && for p in $quoted; do rm -rf `"`$p`"; done"
}

function Get-SshIdentityPath {
    # Prefer explicit deploy identity (existing root key), else default files.
    foreach ($c in @($env:LXC_SSH_KEY, $env:LXC_IDENTITY_FILE)) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    return $null
}

function Get-SshBaseArgs {
    param([switch]$ForScp)
    $args = @(
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "PreferredAuthentications=publickey"
    )
    $id = Get-SshIdentityPath
    if ($id) {
        $args += @("-i", $id, "-o", "IdentitiesOnly=yes")
        if (-not $script:HavenSshIdentityLogged) {
            Write-Host "SSH identity: $id" -ForegroundColor DarkGray
            $script:HavenSshIdentityLogged = $true
        }
    }
    return $args
}

function Invoke-NativeExit {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [switch]$PassThruOutput
    )
    # Prefer direct call (no cmd.exe) so remote "&&" is not eaten by cmd.
    # CRITICAL: do not let stdout become the function's return value (e.g. "ok"),
    # or callers treat success as failure: if ($code -ne 0) with $code = @("ok", 0).
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($PassThruOutput) {
            & $FilePath @ArgumentList
            return [int]$LASTEXITCODE
        }
        # Discard stdout/stderr streams from pipeline output; keep only exit code
        & $FilePath @ArgumentList 1>$null 2>$null
        if ($null -eq $LASTEXITCODE) { return 0 }
        return [int]$LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $old
    }
}

function Write-SshHint {
    param(
        [string]$RemoteHost,
        [string]$RemoteUser = "root",
        [string]$Detail = ""
    )
    Write-Host "" -ForegroundColor Red
    Write-Host "SSH to ${RemoteUser}@${RemoteHost} failed (publickey / BatchMode)." -ForegroundColor Red
    if ($Detail) { Write-Host $Detail.Trim() -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "Password login works for you, but deploy cannot type a password." -ForegroundColor Yellow
    Write-Host "Point deploy at your EXISTING root private key:" -ForegroundColor Yellow
    Write-Host "  `$env:LXC_SSH_KEY = 'C:\path\to\your_root_key'   # private key file, not .pub" -ForegroundColor Gray
    Write-Host "Or add to ~\.ssh\config:" -ForegroundColor Yellow
    Write-Host "  Host 192.168.86.4" -ForegroundColor Gray
    Write-Host "    User root" -ForegroundColor Gray
    Write-Host "    IdentityFile C:\path\to\your_root_key" -ForegroundColor Gray
    Write-Host "    IdentitiesOnly yes" -ForegroundColor Gray
    Write-Host "Prove (no password prompt):" -ForegroundColor Yellow
    Write-Host "  ssh -o BatchMode=yes -i C:\path\to\your_root_key ${RemoteUser}@${RemoteHost} `"echo ok`"" -ForegroundColor Gray
    Write-Host "List keys in agent:  ssh-add -l" -ForegroundColor DarkGray
}

function Invoke-SshCapture {
    param(
        [string[]]$SshArgs,
        [string]$StdoutFile,
        [string]$StderrFile
    )
    # Call ssh in-process so Windows OpenSSH agent / user env match the shell.
    $oldErr = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $stderr = & ssh @SshArgs 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
        # When redirecting binary, callers should use Invoke-SshBinaryOut instead.
        if ($StdoutFile) {
            # text-oriented capture for preflight / remote commands
            $stdoutLines = $stderr  # mixed if 2>&1; split carefully below
        }
        # Re-run with native redirects for clean split when files requested
        if ($StdoutFile -or $StderrFile) {
            $argLine = ($SshArgs | ForEach-Object {
                if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
            }) -join ' '
            $outPart = if ($StdoutFile) { "> `"$StdoutFile`"" } else { "> NUL" }
            $errPart = if ($StderrFile) { "2> `"$StderrFile`"" } else { "2> NUL" }
            cmd.exe /c "ssh $argLine $outPart $errPart"
            return $LASTEXITCODE
        }
        return $code
    }
    finally {
        $ErrorActionPreference = $oldErr
    }
}

function Invoke-SshBinaryOut {
    param(
        [string[]]$SshArgs,
        [string]$StdoutFile,
        [string]$StderrFile
    )
    # Binary-safe: cmd redirect (PowerShell pipeline corrupts tar streams)
    $argLine = ($SshArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
    }) -join ' '
    cmd.exe /c "ssh $argLine > `"$StdoutFile`" 2> `"$StderrFile`""
    return $LASTEXITCODE
}

function Invoke-ProcessFile {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$StdoutFile = $null,
        [string]$StderrFile = $null
    )
    $argLine = ($ArgumentList | ForEach-Object {
        if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
    }) -join ' '
    $outPart = if ($StdoutFile) { "> `"$StdoutFile`"" } else { "> NUL" }
    $errPart = if ($StderrFile) { "2> `"$StderrFile`"" } else { "2> NUL" }
    cmd.exe /c "`"$FilePath`" $argLine $outPart $errPart"
    return $LASTEXITCODE
}

function Test-SshHost {
    param(
        [string]$RemoteUser,
        [string]$RemoteHost
    )
    $code = Invoke-NativeExit -FilePath "ssh" -ArgumentList (@(Get-SshBaseArgs) + @(
        "${RemoteUser}@${RemoteHost}",
        "echo ok"
    ))
    if ($code -ne 0) {
        Write-SshHint -RemoteHost $RemoteHost -RemoteUser $RemoteUser -Detail "ssh preflight exit $code"
        throw "SSH preflight failed (exit $code)"
    }
}

function Invoke-SyncToRemote {
    param(
        [Parameter(Mandatory = $true)][string]$LocalDir,
        [Parameter(Mandatory = $true)][string]$RemoteUser,
        [Parameter(Mandatory = $true)][string]$RemoteHost,
        [Parameter(Mandatory = $true)][string]$RemotePath,
        # Means "replace managed dist paths", NOT wipe webroot.
        [switch]$Delete,
        [switch]$DryRun,
        [switch]$WipeRemote
    )

    if (-not (Test-Path -LiteralPath $LocalDir)) {
        throw "Local path not found: $LocalDir"
    }

    $backend = Get-SyncBackend
    if (-not $backend) {
        throw "No sync tool found. Install OpenSSH client (ssh/tar) or rsync, or enable WSL with rsync."
    }

    $managed = @(Get-DistTopLevelNames -LocalDir $LocalDir)
    if ($managed.Count -eq 0) {
        throw "Local dist is empty: $LocalDir"
    }

    $target = "${RemoteUser}@${RemoteHost}:${RemotePath}"
    Write-Host "Sync backend: $backend" -ForegroundColor DarkGray
    Write-Host "Local -> remote: $LocalDir -> $target" -ForegroundColor DarkGray
    Write-Host "Managed paths (only these are replaced): $($managed -join ', ')" -ForegroundColor DarkGray
    Write-Host "Protected examples left alone: config.json, .git, .env, anything else not in dist/" -ForegroundColor DarkGray

    switch ($backend) {
        "rsync" {
            $args = @("-avz")
            if ($DryRun) { $args += "-n" }
            if ($WipeRemote) {
                throw "WipeRemote is blocked for rsync path. Refusing to wipe whole webroot."
            }
            if ($Delete -and -not $DryRun) {
                $dest = $RemotePath.TrimEnd('/')
                $prep = Get-RemotePrepRemoveManaged -Dest $dest -Names $managed
                $err = Join-Path $env:TEMP ("haven-rsync-prep-{0}.err" -f [guid]::NewGuid().ToString("n"))
                $out = Join-Path $env:TEMP ("haven-rsync-prep-{0}.out" -f [guid]::NewGuid().ToString("n"))
                try {
                    $code = Invoke-SshCapture -SshArgs (@(Get-SshBaseArgs) + @("${RemoteUser}@${RemoteHost}", $prep)) -StdoutFile $out -StderrFile $err
                    if ($code -ne 0) {
                        Write-SshHint -RemoteHost $RemoteHost -RemoteUser $RemoteUser -Detail ((Get-Content -Raw $err -ErrorAction SilentlyContinue))
                        throw "remote managed cleanup failed (exit $code)"
                    }
                }
                finally { Remove-Item -Force -ErrorAction SilentlyContinue $err, $out }
            }
            elseif ($Delete -and $DryRun) {
                Write-Host "DRY RUN: would replace only: $($managed -join ', ')" -ForegroundColor Yellow
                Write-Host "DRY RUN: would NOT wipe whole $RemotePath" -ForegroundColor Green
            }
            $local = ($LocalDir.TrimEnd('\', '/') + "/")
            & rsync @args $local $target
            if ($LASTEXITCODE -ne 0) { throw "rsync failed (exit $LASTEXITCODE)" }
        }
        "wsl-rsync" {
            if ($WipeRemote) { throw "WipeRemote blocked." }
            $wslLocal = (ConvertTo-WslPath $LocalDir).TrimEnd('/') + "/"
            if ($Delete -and -not $DryRun) {
                $dest = $RemotePath.TrimEnd('/')
                $prep = Get-RemotePrepRemoveManaged -Dest $dest -Names $managed
                $err = Join-Path $env:TEMP ("haven-wsl-prep-{0}.err" -f [guid]::NewGuid().ToString("n"))
                $out = Join-Path $env:TEMP ("haven-wsl-prep-{0}.out" -f [guid]::NewGuid().ToString("n"))
                try {
                    $code = Invoke-SshCapture -SshArgs (@(Get-SshBaseArgs) + @("${RemoteUser}@${RemoteHost}", $prep)) -StdoutFile $out -StderrFile $err
                    if ($code -ne 0) {
                        Write-SshHint -RemoteHost $RemoteHost -RemoteUser $RemoteUser -Detail ((Get-Content -Raw $err -ErrorAction SilentlyContinue))
                        throw "remote managed cleanup failed (exit $code)"
                    }
                }
                finally { Remove-Item -Force -ErrorAction SilentlyContinue $err, $out }
            }
            elseif ($Delete -and $DryRun) {
                Write-Host "DRY RUN: would replace only: $($managed -join ', ')" -ForegroundColor Yellow
                Write-Host "DRY RUN: would NOT wipe whole $RemotePath" -ForegroundColor Green
            }
            $args = @("bash", "-lc", "rsync -avz $(if ($DryRun) { '-n ' })`"$wslLocal`" `"$target`"")
            & wsl @args
            if ($LASTEXITCODE -ne 0) { throw "wsl rsync failed (exit $LASTEXITCODE)" }
        }
        "ssh-tar" {
            $dest = $RemotePath.TrimEnd('/')
            if ($WipeRemote) {
                throw "WipeRemote is blocked. Refusing to clear entire webroot."
            }

            if ($DryRun) {
                Write-Host "DRY RUN: would stream tar of $LocalDir to ${RemoteUser}@${RemoteHost}:$dest" -ForegroundColor Yellow
                if ($Delete) {
                    Write-Host "DRY RUN: would remove/replace ONLY these top-level paths:" -ForegroundColor Yellow
                    foreach ($n in $managed) { Write-Host "  - $dest/$n" -ForegroundColor Yellow }
                    Write-Host "DRY RUN: would KEEP everything else (e.g. config.json, .git)" -ForegroundColor Green
                }
                else {
                    Write-Host "DRY RUN: overlay extract only (overwrite same names, no pre-delete)" -ForegroundColor Yellow
                }
                Get-ChildItem -LiteralPath $LocalDir -Force | Select-Object -First 30 Name, Mode, Length | Format-Table | Out-String | Write-Host
                Write-Host "DRY RUN: SSH preflight (BatchMode)..." -ForegroundColor DarkGray
                Test-SshHost -RemoteUser $RemoteUser -RemoteHost $RemoteHost
                Write-Host "DRY RUN: SSH preflight OK" -ForegroundColor Green
                return
            }

            Test-SshHost -RemoteUser $RemoteUser -RemoteHost $RemoteHost

            $localFull = (Resolve-Path -LiteralPath $LocalDir).Path
            $tmpTar = Join-Path $env:TEMP ("haven-deploy-{0}.tar" -f [guid]::NewGuid().ToString("n"))
            $remoteTmp = "/tmp/haven-deploy-$([guid]::NewGuid().ToString('n')).tar"
            $base = @(Get-SshBaseArgs)

            try {
                Write-Host "Creating local archive..." -ForegroundColor DarkGray
                $tarCode = Invoke-NativeExit -FilePath "tar" -ArgumentList @("-cf", $tmpTar, "-C", $localFull, ".")
                if ($tarCode -ne 0) { throw "local tar create failed (exit $tarCode)" }
                if (-not (Test-Path $tmpTar) -or ((Get-Item $tmpTar).Length -lt 1)) {
                    throw "local tar create produced empty archive"
                }
                Write-Host ("Archive size: {0} bytes" -f (Get-Item $tmpTar).Length) -ForegroundColor DarkGray

                Write-Host "Uploading archive via scp..." -ForegroundColor DarkGray
                $scpCode = Invoke-NativeExit -FilePath "scp" -ArgumentList ($base + @(
                    $tmpTar,
                    "${RemoteUser}@${RemoteHost}:$remoteTmp"
                ))
                if ($scpCode -ne 0) {
                    Write-SshHint -RemoteHost $RemoteHost -RemoteUser $RemoteUser -Detail "scp exit $scpCode"
                    throw "scp deploy archive failed (exit $scpCode)"
                }

                Write-Host "Verifying remote archive..." -ForegroundColor DarkGray
                $verifyCode = Invoke-NativeExit -FilePath "ssh" -ArgumentList ($base + @(
                    "${RemoteUser}@${RemoteHost}",
                    "test -s '$remoteTmp' && ls -la '$remoteTmp'"
                ))
                if ($verifyCode -ne 0) {
                    throw "remote archive missing after scp (exit $verifyCode): $remoteTmp"
                }

                if ($Delete) {
                    $remotePrep = Get-RemotePrepRemoveManaged -Dest $dest -Names $managed
                }
                else {
                    $remotePrep = "mkdir -p '$dest'"
                }
                # Single remote argv element — do NOT pass through cmd.exe (it splits on &&)
                $remoteCmd = "set -e; $remotePrep; tar -xf '$remoteTmp' -C '$dest'; rm -f '$remoteTmp'; echo DEPLOY_OK"

                Write-Host "Extracting on remote..." -ForegroundColor DarkGray
                $sshCode = Invoke-NativeExit -FilePath "ssh" -ArgumentList ($base + @(
                    "${RemoteUser}@${RemoteHost}",
                    $remoteCmd
                ))
                if ($sshCode -ne 0) {
                    throw "remote extract failed (exit $sshCode)"
                }
            }
            finally {
                Remove-Item -Force -ErrorAction SilentlyContinue $tmpTar
            }
        }
    }
}

function Invoke-SyncFromRemote {
    param(
        [Parameter(Mandatory = $true)][string]$LocalDir,
        [Parameter(Mandatory = $true)][string]$RemoteUser,
        [Parameter(Mandatory = $true)][string]$RemoteHost,
        [Parameter(Mandatory = $true)][string]$RemotePath,
        [switch]$Delete,
        [switch]$DryRun
    )

    New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
    $backend = Get-SyncBackend
    if (-not $backend) {
        throw "No sync tool found. Install OpenSSH client (ssh/tar) or rsync, or enable WSL with rsync."
    }

    $source = "${RemoteUser}@${RemoteHost}:${RemotePath}"
    Write-Host "Sync backend: $backend" -ForegroundColor DarkGray
    Write-Host "Remote -> local: $source -> $LocalDir" -ForegroundColor DarkGray

    switch ($backend) {
        "rsync" {
            $args = @("-avz")
            if ($DryRun) { $args += "-n" }
            if ($Delete) { $args += "--delete" }
            $remote = ($RemotePath.TrimEnd('/') + "/")
            $src = "${RemoteUser}@${RemoteHost}:$remote"
            $local = ($LocalDir.TrimEnd('\', '/') + "/")
            & rsync @args $src $local
            if ($LASTEXITCODE -ne 0) { throw "rsync backup failed (exit $LASTEXITCODE)" }
        }
        "wsl-rsync" {
            $wslLocal = (ConvertTo-WslPath $LocalDir).TrimEnd('/') + "/"
            $remote = ($RemotePath.TrimEnd('/') + "/")
            $src = "${RemoteUser}@${RemoteHost}:$remote"
            $args = @("bash", "-lc", "rsync -avz $(if ($DryRun) { '-n ' })$(if ($Delete) { '--delete ' })`"$src`" `"$wslLocal`"")
            & wsl @args
            if ($LASTEXITCODE -ne 0) { throw "wsl rsync backup failed (exit $LASTEXITCODE)" }
        }
        "ssh-tar" {
            $srcPath = $RemotePath.TrimEnd('/')
            if ($DryRun) {
                Write-Host "DRY RUN: would download tar from ${RemoteUser}@${RemoteHost}:$srcPath to $LocalDir" -ForegroundColor Yellow
                Test-SshHost -RemoteUser $RemoteUser -RemoteHost $RemoteHost
                Write-Host "DRY RUN: SSH preflight OK" -ForegroundColor Green
                return
            }

            Test-SshHost -RemoteUser $RemoteUser -RemoteHost $RemoteHost

            if ($Delete) {
                Get-ChildItem -LiteralPath $LocalDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            }

            $localFull = (Resolve-Path -LiteralPath $LocalDir).Path
            $tmpTar = Join-Path $env:TEMP ("haven-backup-{0}.tar" -f [guid]::NewGuid().ToString("n"))
            $errFile = Join-Path $env:TEMP ("haven-backup-{0}.err" -f [guid]::NewGuid().ToString("n"))
            $outNull = Join-Path $env:TEMP ("haven-backup-{0}.out" -f [guid]::NewGuid().ToString("n"))

            try {
                $base = @(Get-SshBaseArgs)
                # Prefer scp of a remote-created tar (clearer than binary ssh redirects on Windows)
                $remoteTmp = "/tmp/haven-backup-$([guid]::NewGuid().ToString('n')).tar"
                $packCode = Invoke-NativeExit -FilePath "ssh" -ArgumentList ($base + @(
                    "${RemoteUser}@${RemoteHost}",
                    "set -e; tar -C '$srcPath' -cf '$remoteTmp' .; test -s '$remoteTmp'; ls -la '$remoteTmp'"
                ))
                if ($packCode -ne 0) {
                    throw "remote tar create for backup failed (exit $packCode)"
                }

                $scpCode = Invoke-NativeExit -FilePath "scp" -ArgumentList ($base + @(
                    "${RemoteUser}@${RemoteHost}:$remoteTmp",
                    $tmpTar
                ))
                if ($scpCode -ne 0) {
                    throw "scp backup download failed (exit $scpCode)"
                }

                # best-effort remote cleanup
                [void](Invoke-NativeExit -FilePath "ssh" -ArgumentList ($base + @(
                    "${RemoteUser}@${RemoteHost}",
                    "rm -f '$remoteTmp'"
                )))

                if (-not (Test-Path $tmpTar) -or ((Get-Item $tmpTar).Length -lt 1)) {
                    throw "backup archive empty after scp"
                }

                $tarCode = Invoke-NativeExit -FilePath "tar" -ArgumentList @("-xf", $tmpTar, "-C", $localFull)
                if ($tarCode -ne 0) { throw "local tar extract of backup failed (exit $tarCode)" }
            }
            finally {
                Remove-Item -Force -ErrorAction SilentlyContinue $tmpTar, $errFile, $outNull
            }
        }
    }
}
