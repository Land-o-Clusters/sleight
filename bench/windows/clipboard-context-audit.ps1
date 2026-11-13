& {
try {
  $ErrorActionPreference='Stop'
  $tasks = @(Get-ScheduledTask -TaskName 'sleight-wt1c-context-*' -ErrorAction SilentlyContinue | ForEach-Object {
    @{name=$_.TaskName; state=[string]$_.State; action=@($_.Actions | ForEach-Object { @{execute=$_.Execute; arguments=$_.Arguments} });
      result=(Get-ScheduledTaskInfo -TaskName $_.TaskName).LastTaskResult}
  })
  $banks = @(Get-ChildItem -LiteralPath 'C:\sleight-setup' -Directory | Where-Object { $_.Name -cmatch '^wt1c-context-[a-f0-9]{32}$' } | ForEach-Object {
    $bank=$_
    $files=@(Get-ChildItem -LiteralPath $bank.FullName -File | ForEach-Object {
      if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROBE_FILE_UNSAFE' }
      $r=@{name=$_.Name; bytes=$_.Length}
      if ($_.Name -in @('ssh.json','product-spawn.json','interactive.json','result.json','node.stdout','node.stderr','probe-error.txt') -and $_.Length -le 32768) {
        $r.data=[IO.File]::ReadAllText($_.FullName)
      }
      $r
    })
    @{bank=$bank.FullName; files=$files}
  })
  @{tasks=$tasks; banks=$banks} | ConvertTo-Json -Depth 12 -Compress
  [Console]::Out.WriteLine('SLEIGHT_GUEST_OK')
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}

