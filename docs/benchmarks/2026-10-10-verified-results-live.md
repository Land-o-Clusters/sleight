# Verified results, first live run

sleight-arch ran the sleight arm at `f3d2790` (verified results merged) on calculator-click,
textedit-edit and textedit-save, 2 runs each, Haiku 5.5 at high, 2026-10-10 15:05 to 15:10 UTC.
The owner may have been at the Mac. One-minute load was about 9.5. Raw results:
[2026-10-10-verified-results-live.json](2026-10-10-verified-results-live.json).

| Task | Passed | Seconds | Turns | js calls | Relay ms |
|---|---|---|---|---|---|
| calculator-click | 2/2 | 73.1, 23.7 | 5, 4 | 4, 3 | 23, 110 |
| textedit-edit | 2/2 | 31.3, 22.1 | 8, 6 | 6, 4 | 612, 26 |
| textedit-save | 2/2 | 66.7, 57.4 | 15, 13 | 11, 11 | 69, 58 |

calculator-click run 1 spent 55.1 s in the engine, 18.8 s of it in guard reads, while the engine
returned `0 unknown` roots for Calculator. The relay's own time was 23 ms. Earlier runs on
2026-10-10 made 5 to 12 js calls on textedit-edit and 7 to 40 on textedit-save. These runs fall
inside those ranges, and a sample this small can't rule out a small effect.

What Claude was told, counted from the relay traces:

- textedit-edit, both runs. Cmd+S on the saved file gave `saved: not confirmed (no document save
  state change seen)`, because TextEdit's header doesn't expose an Edited state there. Claude made
  one more call in both runs, then finished. The file was saved both times.
- textedit-save, both runs. The Save panel's Save gave `UI changed (window); saved: not confirmed
  (different document)`. Naming a file through the panel's own field, not Go to Folder, isn't a
  named path the feature resolves.
- textedit-save, both runs. Each had 3 `UI unverified (degraded read)` lines, and two of each were
  false. The lost-URL rule compared against any window of the app, so switching from a leftover "Untitled 9"
  (with a URL) to the task's "Untitled 10", and Cmd+S opening the Save sheet, both counted as a
  lost URL. Fixed after this run: the rule now applies only to the same window title, with a
  regression test from these two cases.
- calculator-click run 1. One `degraded read` for a real `0 unknown` root.

textedit-save read a leftover "Untitled 9" window from an earlier failed run, which the
benchmark's cleanup doesn't close because it doesn't hold a reference to it. Chess and Safari-form
runs with the new lines wait for the owner to be away.
