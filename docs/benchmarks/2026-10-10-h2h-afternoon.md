# Head-to-heads and shop runs, 2026-10-10 afternoon

These runs were left in `bench/results/` and are published here late, on 2026-10-10 at 20:40 UTC.
Every one ran Haiku 5.5 at high for sleight and gpt-6.1-sol for Codex, on engine 26.1007.21159,
with the owner away. The commit named for each run is the head of `pane/auto-mode` when it started.
Codex doesn't report its model time, so only sleight's is given.

| Started (UTC) | Commit | Tasks | sleight | Codex |
|---|---|---|---|---|
| 16:35 | `979b4c2` | textedit-save, 2 runs a side ([raw](2026-10-10-h2h-save-check.json)) | 4/4 | 4/4 |
| 16:41 | `fd7392d` | calculator-click, textedit-edit, textedit-save, 2 runs a task ([raw](2026-10-10-h2h-3.json)) | 6/6, 356.7 s, 83 turns, model 215.0 s, CPU 73.9 s | 6/6, 209.2 s, 47 turns, CPU 31.6 s |
| 16:59 | `80b5abc` | the same three, 3 runs a task ([raw](2026-10-10-h2h-4.json)) | 8/9, 402.4 s, 96 turns, model 253.5 s, CPU 88.3 s | 9/9, 267.1 s, 69 turns, CPU 43.2 s |
| 19:02 | `6cfdeb7` | calculator-click, sleight only, 3 runs ([raw](2026-10-10-calculator-turns.json)) | 3/3, 18.6, 45.2 and 27.6 s | |
| 19:07 | `d575dcf` | the same three, 3 runs a task ([raw](2026-10-10-h2h-5.json)) | 9/9, 313.3 s, 79 turns, model 189.6 s, CPU 78.2 s | 9/9, 340.2 s, 83 turns, CPU 54.3 s |
| 19:47 | `35bb762` | helium-shop and safari-shop, 1 run each ([raw](2026-10-10-shop-1.json)) | helium-shop 53 s, 19 turns; safari-shop failed setup | helium-shop 82 s, 23 turns; safari-shop failed setup |
| 19:52 | `1421cf0` | safari-shop, 1 run ([raw](2026-10-10-shop-2.json)) | 95 s, 22 turns | 84.2 s, 25 turns |

The 16:59 failure is sleight's textedit-save run 1: 148.5 s and 27 turns, and the document wasn't
saved. The 19:47 safari-shop setup failed on both arms before either started ("fixture identity
unconfirmed"). `1421cf0` put the run nonce in the shop page titles so the fixture can find its
window, and the 19:52 rerun passed on both.

In the 19:07 pass Codex's 340.2 s includes one textedit-save run of 110 s and 24 turns. Its median
textedit-save run was 50.2 s, against sleight's 51.8 s.

Codex finished calculator-click in 4 turns and 14.4 to 16.1 s in all 8 of its runs. In the 19:07
pass sleight took 16.8, 24.3 and 26.4 s with 4 to 6 turns. sleight's time there went to the
model (7.6 to 13.7 s a run), the engine (5.2 to 8.8 s over 3 to 5 calls), and 7 to 13 guard reads
inside those calls (2.7 to 5.1 s). The run that took 24.3 s had 7.1 s outside the model and tool
calls, which is the only startup-sized gap of the three.
