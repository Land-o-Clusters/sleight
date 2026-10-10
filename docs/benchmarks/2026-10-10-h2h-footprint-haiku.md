# Footprint head-to-head on Haiku (2026-10-10)

sleight (`d553a73`, after footprint parity in `4082ae9`) against Codex on the same engine
(26.1007.21159), calculator-click, textedit-edit and textedit-save, 2 runs each, owner away. The
Claude arm ran Haiku 5.5 at high on the API key, Codex ran gpt-6.1-sol. Load was 31 when the pass
started. Every run is in [`2026-10-10-h2h-footprint-haiku.json`](2026-10-10-h2h-footprint-haiku.json).

Both passed 6/6 in 61 turns. sleight took 263 s and Codex 257 s. sleight's textedit-edit opened its
file with `open_file`, and Codex's went through the Open panel.

CPU seconds of each arm's own processes, summed over the six runs:

| Process | sleight | Codex |
|---|---|---|
| Engine helper | 46.6 | 40.3 |
| TextEdit and Calculator | 17.5 | 13.7 |
| Engine node | 9.3 | 4.8 |
| Relay node and `osascript` | 3.1 | 1.4 |
| Total | 76.5 | 60.2 |

sleight used 27% more, against 18% at `6e21846` (45.8 and 38.7, Sonnet, different tasks). The
excess is in the engine helper and engine node, where the guard's reads land: 32 s of guard reads
in sleight's six runs, 24 s of them in textedit-save. The Claude arm also ran Claude Code (13.3 s
against Codex's 7.8 s) and the owner's own plugins (about 7 s), which aren't sleight's. The release
gate (ROADMAP 3.5) isn't met.
