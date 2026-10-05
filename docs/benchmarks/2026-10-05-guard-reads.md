# Fewer reads per call (2026-10-05)

Until 0.11.0 the window guard read the whole tree again after every `js` call, so the lease could
check the window header, even when Claude's code had just read the window itself. Now a read Claude
makes is a full read the relay turns into changed lines, and the guard reuses it. It reads again
only when the call acted after Claude's last read. A new call always reads fresh.

Time added on top of the work inside a call ([raw numbers](2026-10-05-guard-reads.json)):

| App | Before | After |
|---|---|---|
| Calculator | 46 to 88 ms | 6 to 11 ms |
| CNN front page in Helium | 242 to 332 ms | 10 to 14 ms |

The CNN page had loaded more by the second run (48,123 to 56,096 characters against 31,494 to
45,587), and the reads inside those calls took longer. The saving is the guard's extra read,
which grows with the page.

An untitled document that autosave gives a URL mid-call now
counts as the same window, outside document scope and change review. The TextEdit benchmark had
12 refusals for a changed window after that change against 14 and 20 in the two passes before, and median
turns didn't move (textedit-save 17, against 16.5 to 22.5), so we can't show a gain from it. The
skill now tells Claude not to set TextEdit text with `setValue`, after three hangs that followed it.

Benchmark runs for this release ([results](2026-10-05-release-0.11.0.json)): 12/12 after the read
reuse, 0/9 and 7/9 in two TextEdit-only reruns, and 12/12 in the final full pass. The 0/9 came from
one TextEdit hang, after `setValue` and Cmd+S, that every later TextEdit run met. The 7/9 lost its
first two runs to the state TextEdit was left in after we force-quit it.
