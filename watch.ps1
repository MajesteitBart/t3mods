# Re-applies the T3 patches (mods + editor timeout) after T3 Code updates
# itself. The scheduled task "T3 Mods Watcher" runs this at logon; install or
# remove that task with -Install / -Uninstall.
#
# Every 30 seconds it compares server.asar's size and write time with the last
# check. After a change (and once at start) it asks apply.mjs whether the
# installed build carries the mods. When it doesn't:
#   - T3 is closed: patch only (launch.ps1 -PatchOnly).
#   - T3 is running: restart-and-apply.ps1 waits until no run is active,
#     closes T3, patches and starts it again.
# A build that carries older mods is left alone, so editing a mod never
# restarts T3 by surprise; run restart-and-apply.ps1 yourself for that.
#
# Optional config.json next to this script:
#   { "reportThreadId": "<T3 thread id>" }
# makes restart-and-apply.ps1 post its result into that thread.
param(
    [switch]$Install,
    [switch]$Uninstall,
    # One check, then exit. For testing.
    [switch]$Once,
    [int]$IntervalSeconds = 30
)

$ErrorActionPreference = 'Stop'
$taskName = 'T3 Mods Watcher'
$log = Join-Path $PSScriptRoot 'watch.log'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
$asar = Join-Path $installDir 'resources\server.asar'
$updaterDir = Join-Path $env:LOCALAPPDATA 't3code-updater'
$launcher = Join-Path $PSScriptRoot 'launch.ps1'
$restartAndApply = Join-Path $PSScriptRoot 'restart-and-apply.ps1'
$apply = Join-Path $PSScriptRoot 'apply.mjs'
# A failed attempt waits this long before the same build is tried again.
$retryDelay = New-TimeSpan -Minutes 10

if ($Install) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $PSScriptRoot `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
        -Description 'Re-applies the T3 Code mods in ~/.t3/mods after T3 updates itself. See watch.ps1.' | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output "Registered and started '$taskName'. Log: $log"
    return
}

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed '$taskName'."
    return
}

function Write-Log([string]$Message) {
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
        $tail = Get-Content -LiteralPath $log -Tail 200
        Set-Content -LiteralPath $log -Value $tail -Encoding utf8
    }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" | Add-Content -LiteralPath $log -Encoding utf8
}

# Runs a program and returns its stdout and stderr lines as text. Windows
# PowerShell turns redirected stderr into errors, and with 'Stop' one warning
# line would abort the check and kill the program mid-patch.
function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    foreach ($line in (& $FilePath @Arguments 2>&1)) { "$line" }
}

function Test-ProcessUnder([string]$Directory) {
    $prefix = $Directory.TrimEnd('\') + '\'
    @(Get-CimInstance Win32_Process -Property ExecutablePath | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
}

function Get-ArchiveStamp {
    $item = Get-Item -LiteralPath $asar -ErrorAction SilentlyContinue
    if ($item) { "$($item.Length)|$($item.LastWriteTimeUtc.Ticks)" }
}

# Returns 'current', 'older' (patched with other mods), or 'missing'.
function Get-ModsState {
    $output = ((Invoke-Native $node @($apply, '--check')) -join "`n").Trim()
    if ($LASTEXITCODE -eq 0) { return 'current' }
    if ($output -match ': not patched') { return 'missing' }
    if ($output -match 'patched with older mods') { return 'older' }
    throw "apply.mjs --check failed: $output"
}

function Get-ReportThreadId {
    $config = Join-Path $PSScriptRoot 'config.json'
    if (-not (Test-Path -LiteralPath $config)) { return $null }
    try { (Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).reportThreadId } catch { $null }
}

# One pass. Returns $true when the build was handled (or needs nothing), so the
# caller remembers its stamp; $false to look again next round.
function Invoke-Check {
    if (Test-ProcessUnder $updaterDir) { return $false }  # an update is installing
    $state = Get-ModsState
    if ($state -ne 'missing') { return $true }

    if (-not (Test-ProcessUnder $installDir)) {
        Write-Log 'New build without mods, T3 closed: patching.'
        $result = (Invoke-Native powershell.exe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher, '-PatchOnly')) -join ' '
        Write-Log "launcher -PatchOnly: $($result.Trim())"
    } else {
        Write-Log 'New build without mods, T3 running: restart-and-apply.ps1 (waits for idle, logs to restart-and-apply.log).'
        $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$restartAndApply`"")
        $thread = Get-ReportThreadId
        if ($thread) { $arguments += @('-ReportThreadId', $thread) }
        # A separate process rather than a pipeline: an error in a pipeline
        # makes PowerShell kill the program in it, which once stopped this run
        # after it had closed T3 and before it started T3 again.
        $run = Start-Process -FilePath powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
        $run.WaitForExit()
    }

    $after = Get-ModsState
    Write-Log "Mods after apply: $after"
    return $after -eq 'current'
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\T3ModsWatcher')
if (-not $mutex.WaitOne(0)) {
    if ($Once) { throw 'Another watcher is running.' }
    return
}

try {
    $node = (Get-Command node -ErrorAction Stop).Source
    Write-Log "Watching $asar every $IntervalSeconds s."
    $handled = $null
    $retryAt = [DateTime]::MinValue
    while ($true) {
        $stamp = Get-ArchiveStamp
        if ($stamp -and $stamp -ne $handled -and (Get-Date) -ge $retryAt) {
            $ok = $false
            try {
                $ok = Invoke-Check
            } catch {
                Write-Log "Check failed: $($_.Exception.Message)"
            }
            if ($ok) { $handled = $stamp }
            elseif (-not (Test-ProcessUnder $updaterDir)) { $retryAt = (Get-Date) + $retryDelay }
        }
        if ($Once) { break }
        Start-Sleep -Seconds $IntervalSeconds
    }
} finally {
    $mutex.ReleaseMutex()
}
