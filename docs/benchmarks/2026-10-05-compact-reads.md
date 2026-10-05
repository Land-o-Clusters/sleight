# Smaller results after actions (2026-10-05)

After every `js` action, sleight's window guard reads the whole tree with diffing off, so the input
lease can check the window header. That read is also the engine's new diff baseline. Until 0.9.0 it
went to Claude whole, after whatever Claude had already read. Now the relay keeps the last full tree
Claude got for each window and sends only the lines that changed since then
(`plugins/sleight/lib/compact-reads.mjs`). A first read of a window, or a change larger than 60% of
the tree, still goes whole.

The benchmark passed 12/12 with it, two runs per task
([results](2026-10-05-compact-reads.json)). In those runs 46 guard reads were cut down, 38 of them
to one "no change" line. Median sleight result text per run, against the earlier passes the
same day:

| Task | Before (chars) | After (chars) |
|---|---|---|
| textedit-drag | 21,496 | 16,466 |
| textedit-edit | 17,776 | 16,942 |
| textedit-save | 66,747 | 66,405 |
| chess-drag | 20,991 | 20,262 |

The before column is the clean 0.7.0 pass, with three runs per task. The samples differ in size and
in what Claude chose to do. These apps have small trees, and textedit-save spends most of its text on
new windows and dialogs, which go whole. The complaint that started this came from a browser page
with a long sidebar. The savings there should be larger. No browser is on the benchmark's
allowlist, so we haven't measured it. A page that re-renders and renumbers its elements still comes
through whole, from the engine and from the guard.
