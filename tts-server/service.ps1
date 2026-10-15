# Manage the Supertonic TTS server that backs the T3 listen mod.
#   .\service.ps1 install | uninstall | status | start | stop | restart
# install registers the "T3 Supertonic TTS" scheduled task, which starts the
# server at logon. Stopping that task leaves node running, so stop finds the
# server by its port and command line.
param([ValidateSet('install', 'uninstall', 'status', 'start', 'stop', 'restart')][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$taskName = 'T3 Supertonic TTS'
$port = (Get-Content -Raw (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json).port

function Get-ServerProcess {
    $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if (-not $owner) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
    if ($process.CommandLine -like '*tts-server*server.mjs*') { return $process }
    throw "Port $port is held by another program (pid $owner): $($process.CommandLine)"
}

function Wait-Health {
    for ($i = 0; $i -lt 40; $i++) {
        try { return Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2 } catch { Start-Sleep -Milliseconds 500 }
    }
    throw "The server did not answer on port $port; see server.log."
}

function Stop-Server {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $process = Get-ServerProcess
    if ($process) { Stop-Process -Id $process.ProcessId -Force }
}

switch ($Action) {
    'install' {
        # PowerShell runs node so the server gets no console window. The paths
        # go inside single-quoted literals, where a ' is written as ''.
        $node = (Get-Command node -ErrorAction Stop).Source -replace "'", "''"
        $server = (Join-Path $PSScriptRoot 'server.mjs') -replace "'", "''"
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $PSScriptRoot `
            -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$node' '$server' --log server.log`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force `
            -Description 'Local Supertonic text-to-speech for the T3 Code listen mod.' | Out-Null
        if (-not (Get-ServerProcess)) { Start-ScheduledTask -TaskName $taskName }
        $null = Wait-Health
        'installed and running'
    }
    'uninstall' {
        Stop-Server
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        'removed'
    }
    'status' {
        $process = Get-ServerProcess
        if (-not $process) { "stopped (task: $((Get-ScheduledTask -TaskName $taskName).State))"; break }
        $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
        "running on 127.0.0.1:$port (pid $($process.ProcessId)), voice $($health.voice), model loaded: $($health.loaded)"
    }
    'start' {
        if (Get-ServerProcess) { 'already running'; break }
        Start-ScheduledTask -TaskName $taskName
        $null = Wait-Health
        'started'
    }
    'stop' { Stop-Server; 'stopped' }
    'restart' {
        Stop-Server
        Start-Sleep -Seconds 1
        Start-ScheduledTask -TaskName $taskName
        $null = Wait-Health
        'restarted'
    }
}
