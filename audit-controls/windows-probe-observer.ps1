param([Parameter(Mandatory)][ValidateSet('control', 'formatter')][string]$Mode)
$ErrorActionPreference = 'Stop'
$probeOutput = Join-Path (Get-Location).Path '.audit/windows-probe-diagnostic'
$probeControls = $PSScriptRoot
$probeEvents = [System.Collections.Generic.List[object]]::new()
$probeIds = @('damadama-probe-start', 'damadama-probe-stop')
$probeOutcome = @{ mode = $Mode; kind = 'incomplete'; observer = 'unverified'; handle = 'not-needed'; missingChildrenNotRuledOut = $true }
$probeExit = 1

function Drain-ProbeEvents {
  foreach ($probeId in $probeIds) {
    foreach ($probeQueued in @(Get-Event -SourceIdentifier $probeId -ErrorAction SilentlyContinue)) {
      $probeNative = $probeQueued.SourceEventArgs.NewEvent
      $probeKind = 'start'
      if ($probeId -eq 'damadama-probe-stop') { $probeKind = 'stop' }
      $probeEntry = [ordered]@{
        kind = $probeKind
        nativeFileTime = [string]$probeNative.TIME_CREATED
        nativeUtc = [DateTime]::FromFileTimeUtc([long]$probeNative.TIME_CREATED).ToString('O')
        collectorUtc = [DateTime]::UtcNow.ToString('O')
        pid = [int]$probeNative.ProcessID
        ppid = [int]$probeNative.ParentProcessID
        basename = [string]$probeNative.ProcessName
      }
      if ($probeKind -eq 'stop') { $probeEntry.exitStatus = [uint32]$probeNative.ExitStatus }
      $probeEvents.Add([pscustomobject]$probeEntry)
      Remove-Event -EventIdentifier $probeQueued.EventIdentifier
    }
  }
}

function Get-ProbeLineage([object[]]$Events, [hashtable]$Identity) {
  $probeLineage = [System.Collections.Generic.HashSet[int]]::new()
  $probeScoped = [System.Collections.Generic.List[object]]::new()
  $probeRootClaimed = $false
  foreach ($probeEvent in @($Events | Sort-Object { [long]$_.nativeFileTime })) {
    if ($probeEvent.kind -eq 'start') {
      # JavaScript Date truncates the root entry timestamp to milliseconds.
      $probeIsRoot = -not $probeRootClaimed -and $Identity.rootPid -and $Identity.rootEntryUtc -and $probeEvent.pid -eq $Identity.rootPid -and $probeEvent.ppid -eq $Identity.observerPid -and $probeEvent.basename -ieq $Identity.bunBasename -and [DateTime]$probeEvent.nativeUtc -ge [DateTime]$Identity.invocationUtc -and [DateTime]$probeEvent.nativeUtc -le ([DateTime]$Identity.rootEntryUtc).AddMilliseconds(1)
      if ($probeIsRoot -or $probeLineage.Contains($probeEvent.ppid)) {
        [void]$probeLineage.Add($probeEvent.pid)
        $probeScoped.Add($probeEvent)
        if ($probeIsRoot) { $probeRootClaimed = $true }
      } else {
        [void]$probeLineage.Remove($probeEvent.pid)
      }
    } elseif ($probeLineage.Contains($probeEvent.pid)) {
      $probeScoped.Add($probeEvent)
      [void]$probeLineage.Remove($probeEvent.pid)
    }
  }
  [pscustomobject]@{ lineage = @($probeScoped); nativeRootStartObserved = $probeRootClaimed }
}

function Test-ProbeOwnedScope([string]$CasePath, [string]$Owner, [string]$ScopeMode) {
  $probePrefix = 'case'
  if ($ScopeMode -eq 'formatter') { $probePrefix = 'format' }
  $probeFixture = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($CasePath))
  [IO.Path]::GetDirectoryName($probeFixture).Equals([IO.Path]::GetFullPath($Owner), [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($probeFixture) -cmatch '^fixture-[a-zA-Z0-9]+$' -and [IO.Path]::GetFileName($CasePath) -cmatch "^$probePrefix-[a-zA-Z0-9]+$"
}

try {
  Register-CimIndicationEvent -Namespace root/cimv2 -ClassName Win32_ProcessStartTrace -SourceIdentifier $probeIds[0] -OperationTimeoutSec 5 | Out-Null
  Register-CimIndicationEvent -Namespace root/cimv2 -ClassName Win32_ProcessStopTrace -SourceIdentifier $probeIds[1] -OperationTimeoutSec 5 | Out-Null
  $probeOutcome.registeredUtc = [DateTime]::UtcNow.ToString('O')
  $probeCalibrationInfo = [System.Diagnostics.ProcessStartInfo]::new($env:ComSpec)
  $probeCalibrationInfo.UseShellExecute = $false
  $probeCalibrationInfo.CreateNoWindow = $true
  foreach ($probeArgument in @('/d', '/c', 'exit 0')) { $probeCalibrationInfo.ArgumentList.Add($probeArgument) }
  $probeCalibration = [System.Diagnostics.Process]::Start($probeCalibrationInfo)
  $probeCalibrationId = $probeCalibration.Id
  if (-not $probeCalibration.WaitForExit(2000)) { throw 'Observer calibration child did not retire within two seconds. No fixture started.' }
  if ($probeCalibration.ExitCode -ne 0) { throw 'Observer calibration child failed. No fixture started.' }
  $probeCalibrationDeadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    Drain-ProbeEvents
    $probeCalibrationEvents = @($probeEvents | Where-Object pid -eq $probeCalibrationId)
    if (@($probeCalibrationEvents | Where-Object kind -eq 'start').Count -and @($probeCalibrationEvents | Where-Object kind -eq 'stop').Count) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $probeCalibrationDeadline)
  if (-not @($probeCalibrationEvents | Where-Object kind -eq 'start').Count -or -not @($probeCalibrationEvents | Where-Object kind -eq 'stop').Count) { throw 'Observer did not capture the calibration start and stop. No fixture started.' }
  $probeOutcome.observer = 'calibration-start-and-stop-observed'
  $probeOutcome.readyUtc = [DateTime]::UtcNow.ToString('O')
  $probeOutcome.calibration = $probeCalibrationEvents
  $env:DAMADAMA_PROBE_ROLE = 'test'
  $probeOutcome.observerPid = $PID
  $probeOutcome.observerBasename = [IO.Path]::GetFileName([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  $probeOutcome.bunBasename = [IO.Path]::GetFileName((Get-Command bun -CommandType Application -ErrorAction Stop).Source)
  if ($probeOutcome.bunBasename -ine 'bun.exe') { throw 'Expected the known Bun executable basename.' }
  $probeOutcome.invocationUtc = [DateTime]::UtcNow.ToString('O')
  & bun --no-env-file test scripts/doctor-docker.test.ts 2>&1 | Tee-Object -FilePath (Join-Path $probeOutput 'diagnostic.log')
  $probeExit = $LASTEXITCODE
  $probeOutcome.testExit = $probeExit
  $probeOutcome.completedUtc = [DateTime]::UtcNow.ToString('O')
  $probeOutcome.kind = 'observed'
  $probeEventPath = Join-Path $probeOutput 'events-test.jsonl'
  if (-not (Test-Path -LiteralPath $probeEventPath)) { throw 'The diagnostic test root did not identify itself.' }
  $probeJsEvents = @(Get-Content -LiteralPath $probeEventPath | ForEach-Object { $_ | ConvertFrom-Json })
  $probeRootEvents = @($probeJsEvents | Where-Object kind -eq 'test-root')
  if ($probeRootEvents.Count -ne 1) { throw 'Expected exactly one diagnostic test root.' }
  $probeOutcome.rootPid = $probeRootEvents[0].pid
  $probeOutcome.rootEntryUtc = $probeRootEvents[0].utc
  if ([DateTime]$probeOutcome.readyUtc -ge [DateTime]$probeOutcome.rootEntryUtc) { throw 'Observer was not ready before the diagnostic root entered.' }

  $probeFailedCases = @($probeJsEvents | Where-Object { $_.kind -eq 'case-cleanup-failed' -and $_.code -eq 'EBUSY' })
  if ($probeFailedCases.Count -gt 1) { throw 'Unexpected number of failed case paths.' }
  if ($probeFailedCases.Count -eq 1) {
    $probeOutcome.handle = 'unknown'
    $probeCase = [IO.Path]::GetFullPath([string]$probeFailedCases[0].scope)
    $probeOwner = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path '.audit/doctor-docker'))
    if (-not (Test-ProbeOwnedScope $probeCase $probeOwner $Mode)) { throw 'Refuse handle query outside the exact owned failed scope for this mode.' }
    try {
      $probeToolDirectory = Join-Path $probeOutput 'handle-tool'
      New-Item -ItemType Directory -Path $probeToolDirectory | Out-Null
      $probeArchive = Join-Path $probeToolDirectory 'Handle.zip'
      Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/Handle.zip' -OutFile $probeArchive -TimeoutSec 10
      Expand-Archive -LiteralPath $probeArchive -DestinationPath $probeToolDirectory
      $probeHandle = Join-Path $probeToolDirectory 'handle64.exe'
      $probeSignature = Get-AuthenticodeSignature -LiteralPath $probeHandle
      if ($probeSignature.Status -ne 'Valid' -or $probeSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'Handle lacks a valid Microsoft Authenticode signature.' }
      @{ kind = 'verified'; url = 'https://download.sysinternals.com/files/Handle.zip'; sha256 = (Get-FileHash -LiteralPath $probeHandle -Algorithm SHA256).Hash.ToLowerInvariant(); signer = $probeSignature.SignerCertificate.Subject; observedUtc = [DateTime]::UtcNow.ToString('O'); casePath = $probeCase } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probeOutput 'handle-tool.json') -Encoding utf8
      & node (Join-Path $probeControls 'windows-probe-handle.mjs') $probeHandle $probeCase $probeOutput $Mode
      if ($LASTEXITCODE -ne 0) { throw 'Handle query failed or reached its bound.' }
      $probeOutcome.handle = 'query-completed-owner-requires-review'
    } catch {
      @{ kind = 'unknown'; reason = 'tool-unavailable-or-query-failed'; observedUtc = [DateTime]::UtcNow.ToString('O') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $probeOutput 'handle-unavailable.json') -Encoding utf8
    }
  }
} catch {
  $probeOutcome.kind = 'instrumentation-failure'
  $probeOutcome.failure = $_.Exception.Message
  $probeExit = 1
} finally {
  $probeDrainDeadline = [DateTime]::UtcNow.AddSeconds(2)
  do { Drain-ProbeEvents; Start-Sleep -Milliseconds 50 } while ([DateTime]::UtcNow -lt $probeDrainDeadline)
  foreach ($probeId in $probeIds) { Unregister-Event -SourceIdentifier $probeId -ErrorAction SilentlyContinue }
  $probeFiltered = Get-ProbeLineage @($probeEvents) $probeOutcome
  $probeScoped = $probeFiltered.lineage
  $probeOutcome.nativeRootStartObserved = $probeFiltered.nativeRootStartObserved
  if ($probeOutcome.rootPid -and -not $probeOutcome.nativeRootStartObserved) { $probeExit = 1; $probeOutcome.kind = 'incomplete-native-root-coverage' }
  $probeOutcome.observerStoppedUtc = [DateTime]::UtcNow.ToString('O')
  @{ lineage = @($probeScoped); calibration = @($probeOutcome.calibration); coverage = 'event subscription with one observed short calibration; lost events cannot be excluded' } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $probeOutput 'native-events.json') -Encoding utf8
  $probeOutcome | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $probeOutput 'observer.json') -Encoding utf8
}
exit $probeExit
