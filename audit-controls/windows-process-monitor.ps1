param([string]$RootPidFile, [string]$StopFile, [string]$Output, [string]$Receipt)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(100)
$observed = @{}
$rootObserved = $false
$snapshots = 0
$stopReason = 'deadline'
try {
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $StopFile)) {
    if (Test-Path -LiteralPath $RootPidFile) {
        $rootIdentity = Get-Content -Raw -LiteralPath $RootPidFile | ConvertFrom-Json
        $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, Name)
        $rootProcess = $processes | Where-Object { $_.ProcessId -eq $rootIdentity.pid }
        if ($rootProcess -and -not $observed.ContainsKey([string]$rootProcess.ProcessId)) {
            $observed[[string]$rootProcess.ProcessId] = $rootProcess.CreationDate.ToUniversalTime().ToString('o')
            $rootObserved = $true
        }
        foreach ($pass in 1..8) {
            foreach ($process in $processes) {
                if ($observed.ContainsKey([string]$process.ParentProcessId)) {
                    $parent = $processes | Where-Object { $_.ProcessId -eq $process.ParentProcessId }
                    $parentCreated = [DateTime]::Parse($observed[[string]$process.ParentProcessId]).ToUniversalTime()
                    if ($process.CreationDate.ToUniversalTime() -ge $parentCreated -and (-not $parent -or $observed[[string]$parent.ProcessId] -eq $parent.CreationDate.ToUniversalTime().ToString('o'))) {
                        $observed[[string]$process.ProcessId] = $process.CreationDate.ToUniversalTime().ToString('o')
                    }
                }
            }
        }
        $snapshot = @($processes | Where-Object {
            $observed.ContainsKey([string]$_.ProcessId) -and $observed[[string]$_.ProcessId] -eq $_.CreationDate.ToUniversalTime().ToString('o')
        } | ForEach-Object {
            @{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o'); name = $_.Name }
        })
        @{ at = [DateTime]::UtcNow.ToString('o'); processes = $snapshot } | ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath $Output
        $snapshots++
    }
    Start-Sleep -Milliseconds 200
}
if (Test-Path -LiteralPath $StopFile) { $stopReason = 'stop-file' }
} catch {
    $stopReason = 'query-error'
    throw
} finally {
    $status = 'unverified'
    if ($rootObserved -and $snapshots -gt 0 -and $stopReason -eq 'stop-file') { $status = 'observed-candidates' }
    @{ status = $status; rootObserved = $rootObserved; snapshotCount = $snapshots; stopReason = $stopReason; deadlineSeconds = 100; pollDelayMs = 200; ancestryDepthPasses = 8; limitation = 'Read-only ancestry candidates. Parent PID reuse between polls and processes between snapshots can be missed. These rows do not prove a directory handle owner.' } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Receipt
}
