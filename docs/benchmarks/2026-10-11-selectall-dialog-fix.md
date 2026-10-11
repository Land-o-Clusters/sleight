# Select-all check: the dialog false positive, 2026-10-11

The select-all check (`node bench/small-fixes-textedit.mjs --quick`) refused in all 7 recorded runs
and completed no trial, from [2026-10-09](2026-10-09-exact-text-1791588276994.json) through
[2026-10-11](2026-10-11-exact-text-1791680045503.json), with no input sent in any of them. The
message was "TextEdit has a dialog; no action will be sent" in each refusal but one, which read
"Requires already-running TextEdit in the background". An engine read right after each dialog
refusal showed one TextEdit window, the check's own document, with no sheet or dialog.

The old dialog test swept every window of the TextEdit instance. A window with subrole AXDialog or
AXSystemDialog, or with AXModal true, refused the run, and so did a window with a direct child of
role AXSheet. Metadata it could not read refused the run too. The sweep included windows that were
not the check's document, and it ran about 0.5 s after `open` in two of the refusals and on a read
with no input between reads in another, so launch-time transients and unrelated windows could stop
a run the engine read contradicted.

The fix, in `bench/small-fixes-textedit.js`, `bench/small-fixes-textedit.mjs` and
`bench/small-fixes-textedit-lib.mjs`:

- The scan covers only the check's owned document window, and a signal refuses only when a second
  scan 0.3 s later confirms it. The main and focused window identity checks still refuse when input
  would land anywhere else.
- When no TextEdit runs, the check launches its own background instance with
  `-ApplePersistenceIgnoreState YES -NSShowAppCentricOpenPanelInsteadOfUntitledFile NO`, so
  restoration and the iCloud open panel stay off and the instance shows only the check's document.
  It identifies its launch by absent-at-preflight plus launch time and quits only that instance,
  first by request and then by force. When TextEdit already runs in the background, the check
  attaches to it and closes only its own document, as before. A foreground TextEdit still refuses
  without activation.
- Launch races (process registration, document open, a busy -25204 read) retry for 8 s at attach,
  and reads retry three times, so a busy read between engine actions no longer ends a run.
- A failed fixture request records each TextEdit window the instance had at that moment: title,
  subrole, identifier, document, modal state and child roles, through Accessibility when attached
  and a CG window list before that. In the already-running case these records can include other
  windows' titles (file names). Publication scrubs home paths and the owner name, nothing else.
- `/tmp/sleight-live.lock` releases on exit unless a TextEdit instance this run launched is not
  confirmed gone. Each dialog refusal kept the lock over a document close that the same false
  positive had blocked, stalling the chain behind it.

12 tests in `tests/selectall-check.test.mjs` cover these decisions hermetically, with no app
driving. All 12 fail against the pre-fix code, which had none of these paths.

Not verified live: whether the owned window itself ever reports a dialog signal, and a completing
pass of the check. For the live check, sleight-arch runs `node bench/small-fixes-textedit.mjs
--quick` with `/tmp/sleight-hold` absent and `/tmp/sleight-live.lock` free. A pass is exit 0,
exactCount and completedCount both 18, `lockReleased` true, `report.launch` recording the two
defaults-off flags when no TextEdit ran, and `ownedInstanceQuit.gone` true. A refusal must come
with the per-window records in `report.records`. "TextEdit has a dialog" without them repeats this
bug.
