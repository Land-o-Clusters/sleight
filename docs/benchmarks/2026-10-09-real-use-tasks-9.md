# Office harness corrections, 2026-10-09

sleight-arch qualified `4323a41` and `b284b05` with the owner away, one trial per task.
The [full results](2026-10-09-real-use-tasks-9.json) retain both passes, failures included.
Their terminal exit codes were not supplied. Sol didn't run live tasks for this revision.
Mail and Mimestream wait until the owner can watch them.

The first pass completed safari-form, then stopped when cleanup rejected Safari's missing
AXDocument. The architect's `b284b05` correction accepts the nonce title on that retained window.
It is included here. The second pass passed all 11 web tasks once each. These cover Safari form,
grid, editor and dense, Helium dense, and Safari and Helium SPA, nested and infinite tasks.

Word completed its edits and saved, but the ZIP checker rejected an entry without identifying it.
The offending file was removed during cleanup, so its flags and size remain unknown. Word was
already running and was preserved by design. Excel's cold setup retried AX errors for 15,002 ms,
ending on `-25205`, then failed to confirm normal quit. The pass stopped before PowerPoint.

## Changes

- ZIP deflate entries accept option bits 1 and 2, including their combination with data descriptors
  and UTF-8 names. Stored entries still reject deflate options. Encryption and compression methods
  other than stored and deflate remain refused. The limits remain 16 MiB per file, 2 MiB per entry,
  8 MiB total uncompressed and 256 entries, with bounded inflation. Entry failures include the
  entry, flags, method, compressed size and uncompressed size, including CRC and inflate failures.
- Cold Office setup polls for the matching fixture window for at most 30 seconds. Both `-25204`
  and `-25205` mean not ready during this wait. Unsupported optional attributes, including
  AXDocument and AXSheets, mean absent. They no longer consume an attribute's retry budget.
  Diagnostics retain the last AX code, attribute, elapsed time and whether readiness or the
  deadline ended the wait. The harness waits without fixture input. Other errors stop immediately.
- The old quit path accepted an ordinary quit request but waited only five seconds for exit.
  It now waits up to 30 seconds, advances the native run loop and rechecks the exact PID and bundle.
  The parent allows 35 seconds to collect that result. A receipt records acceptance, elapsed time,
  launch completion and exit or deadline. It sends one normal quit request, never forces quit and
  never answers a dialog. The retained evidence cannot say why Excel remained running after five seconds.
  The architect's rerun will record whether Excel exits within the longer wait.

## Verification

Test-built ZIPs cover Word, Excel and PowerPoint saves with deflate option bits and descriptors,
entry diagnostics, encryption refusal, unsupported methods, size limits and bounded inflation.
Fake-clock startup cases cover both AX errors, a first window at 12 seconds, a missing window,
slow reads, a 30-second deadline and immediate stops for other errors. Native setup tests retain
the failed launch PID without taking an action. Quit tests cover delayed exit, persistent processes
and process replacement. Parent tests retain startup and quit receipts.

The [result file](2026-10-09-real-use-tasks-9.json) records development failures and final checks.
`npm run check` exited 0 with 900 unit tests, two plugin validations and 11 mod tests passing.
`npm run lint:prose` exited 0 across 53 files. The ordinary sandbox check exited 1 on localhost
listener and fixture-output denials before the scoped host check passed. Earlier regression and
prose failures remain in the result file. Review didn't find Critical or Important issues in the code
and tests, or accuracy or privacy issues in the published evidence.

Live qualification of these corrections remains for sleight-arch, who also owns review and merge.
