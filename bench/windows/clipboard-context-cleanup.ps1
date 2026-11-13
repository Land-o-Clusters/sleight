& {
try {
  $ErrorActionPreference='Stop'
  $tasks = @(Get-ScheduledTask -TaskName 'sleight-wt1c-context-*' -ErrorAction SilentlyContinue)
  # The cooperative Mac lock is held by the maintenance caller. A running probe
  # is never stopped here; completed tasks require their exact owned action.
  foreach ($task in $tasks) {
    $actions = @($task.Actions)
    if ($task.TaskName -cnotmatch '^sleight-wt1c-context-[a-f0-9]{32}$' -or $task.State -ne 'Ready' -or $actions.Count -ne 1 -or
        $actions[0].Execute -cnotmatch '^C:\\sleight-setup\\wt1c-context-[a-f0-9]{32}\\context.exe$') { throw 'PROBE_CLEANUP_IDENTITY_UNPROVED' }
    $bank = Split-Path $actions[0].Execute -Parent
    if ($actions[0].Arguments -cne ('launch "' + $bank + '"')) { throw 'PROBE_CLEANUP_IDENTITY_UNPROVED' }
    $file = Get-Item -LiteralPath $actions[0].Execute
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROBE_FILE_UNSAFE' }
  }
  foreach ($task in $tasks) { Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false }
  $remaining = @(Get-ScheduledTask -TaskName 'sleight-wt1c-context-*' -ErrorAction SilentlyContinue)
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -cmatch '^C:\\sleight-setup\\wt1c-context-[a-f0-9]{32}\\context.exe$' -or
    $_.Name -ieq 'node.exe' -and $_.CommandLine -cmatch 'C:\\sleight-setup\\wt1c-context-[a-f0-9]{32}\\context.mjs'
  })
  @{ removedTasks=$tasks.Count; remainingTasks=$remaining.Count; probeProcesses=$processes.Count } | ConvertTo-Json -Compress
  if ($remaining.Count -or $processes.Count) { throw 'PROBE_CLEANUP_UNPROVED' }
  [Console]::Out.WriteLine('SLEIGHT_GUEST_OK')
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}

