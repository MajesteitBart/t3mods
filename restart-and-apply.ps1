# Waits until no T3 thread is mid-run, closes T3, then runs launch.ps1, which
# re-applies the server.asar patches (editor timeout + mods) and starts T3
# again. watch.ps1 runs it after updates; run it yourself after editing a mod.
# It survives closing T3 because it runs as its own process. Progress goes to
# restart-and-apply.log next to this script.
param(
    [int]$MaxWaitMinutes = 60,
    [string]$ReportThreadId,
    [string]$TaskName
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'restart-and-apply.log'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
$t3Exe = Get-ChildItem -LiteralPath $installDir -Filter 'T3 Code*.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
$launcher = Join-Path $PSScriptRoot 'launch.ps1'
$node = (Get-Command node -ErrorAction Stop).Source

function Write-Log([string]$Message) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" | Add-Content -LiteralPath $log -Encoding utf8
}

# Runs a program and returns its output lines as text, stderr included unless
# -StdoutOnly. Windows PowerShell turns redirected stderr into errors, and with
# 'Stop' a single warning line (taskkill prints one per child it can't end)
# would abort the script between closing T3 and starting it again.
function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$InputText, [switch]$StdoutOnly) {
    $ErrorActionPreference = 'Continue'
    $lines = if ($InputText) { $InputText | & $FilePath @Arguments 2>&1 } else { & $FilePath @Arguments 2>&1 }
    foreach ($line in $lines) {
        if (-not ($StdoutOnly -and $line -is [System.Management.Automation.ErrorRecord])) { "$line" }
    }
}

function Get-T3Processes {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and ((Split-Path -Parent $_.ExecutablePath) -ieq $installDir)
    })
}

function Send-Report([string]$Text) {
    if (-not $ReportThreadId) { return }
    try {
        $until = (Get-Date).AddMinutes(3)
        while ((Get-Date) -lt $until) {
            try {
                $doctor = (Invoke-Native t3code @('--json', 'doctor') -StdoutOnly) -join "`n" | ConvertFrom-Json
                if ($doctor.data.checks.t3Server.ok) { break }
            } catch { }
            Start-Sleep -Seconds 5
        }
        $result = Invoke-Native t3code @('--json', 'threads', 'send', '--thread', $ReportThreadId, '--stdin', '--if-busy', 'queue', '--no-start-desktop') $Text
        $label = if ($LASTEXITCODE -eq 0) { 'Report' } else { "Report failed (exit $LASTEXITCODE)" }
        Write-Log "${label}: $(($result -join ' ') -replace '\s+', ' ')"
    } catch {
        Write-Log "Report failed: $($_.Exception.Message)"
    }
}

$closedT3 = $false
# One run at a time, so the watcher and a run you started never both close T3.
$lock = New-Object System.Threading.Mutex($false, 'Local\T3ModsRestartAndApply')
$locked = $false
try {
    try { $locked = $lock.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        Write-Log 'Another restart-and-apply run is already waiting; leaving it to that one.'
        return
    }
    Write-Log "Started. Waiting for T3 runs to finish (max $MaxWaitMinutes min)."
    $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)
    $quietChecks = 0
    while ($quietChecks -lt 3) {
        if ((Get-Date) -gt $deadline) { throw "T3 still had active runs after $MaxWaitMinutes minutes; left T3 running." }
        # A failed probe counts as busy: closing T3 mid-run is the worse mistake.
        $probe = ((Invoke-Native $node @((Join-Path $PSScriptRoot 'active-runs.mjs')) -StdoutOnly) -join '').Trim()
        $active = 0
        $known = ($LASTEXITCODE -eq 0) -and [int]::TryParse($probe, [ref]$active)
        if ($known -and $active -eq 0) { $quietChecks++ } else { $quietChecks = 0 }
        Start-Sleep -Seconds 10
    }

    # Force-close instead of quitting: a normal quit can start a pending update
    # install while this script patches the same files.
    $processes = Get-T3Processes
    $ids = $processes.ProcessId
    foreach ($main in ($processes | Where-Object { $ids -notcontains $_.ParentProcessId })) {
        Write-Log "No active runs. Closing T3 (pid $($main.ProcessId))."
        # A child that already exited makes taskkill print an error but the
        # rest still closes; the wait below catches what doesn't.
        Invoke-Native taskkill.exe @('/PID', "$($main.ProcessId)", '/T', '/F') |
            Where-Object { $_ -and $_ -notmatch '^SUCCESS' } | ForEach-Object { Write-Log "taskkill: $_" }
        $closedT3 = $true
    }
    $until = (Get-Date).AddSeconds(60)
    while ((Get-T3Processes).Count -gt 0) {
        if ((Get-Date) -gt $until) { throw 'T3 processes did not exit within 60 seconds.' }
        Start-Sleep -Seconds 1
    }
    Start-Sleep -Seconds 2

    Write-Log 'Running launch.ps1 (patches, then starts T3).'
    Invoke-Native powershell.exe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcher) |
        ForEach-Object { Write-Log "launcher: $_" }
    # Its errors arrive as text, so the exit code is what sends a failed
    # launch to the catch block, which starts T3 again.
    if ($LASTEXITCODE -ne 0) { throw "launch.ps1 failed (exit $LASTEXITCODE)." }
    $check = (Invoke-Native $node @((Join-Path $PSScriptRoot 'apply.mjs'), '--check')) -join ' '
    Write-Log "Mods: $check"

    Send-Report @"
[restart-and-apply.ps1] T3 was restarted at $(Get-Date -Format 'HH:mm') and the patches were re-applied.
apply.mjs --check: $check
Log: $log

Check that the mods show up in the running app, then report the result to the user.
"@
} catch {
    Write-Log "FAILED: $($_.Exception.Message)"
    if ($closedT3 -and $t3Exe -and (Get-T3Processes).Count -eq 0) {
        Write-Log 'Starting T3 again without the patch.'
        Start-Process -FilePath $t3Exe -WorkingDirectory $installDir
    }
    Send-Report "[restart-and-apply.ps1] Applying the T3 mods failed: $($_.Exception.Message) Log: $log. Look into it and report to the user."
} finally {
    if ($locked) { $lock.ReleaseMutex() }
    if ($TaskName) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
    Write-Log 'Done.'
}
