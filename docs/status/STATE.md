# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-04, after midnight)

Public: `Land-o-Clusters/sleight`, `main` green in CI, `v0.2.1` tagged, listed on the org profile
after Puddle. A fresh install from GitHub into an empty Claude config worked (0.2.0, `--doctor` ok).
The user-scope install on this Mac follows the working copy's releases. Running sessions keep the
version they started with, because `/reload-plugins` doesn't restart the server.

Desktop approvals work through sleight's panel (0.1.1). The desktop's own Claude Code is 2.1.286,
too old for the mod, so no pane there yet.

`menu_bar` and `notifications` (0.2.0, 0.2.1) cover the menu bar icons and banners the engine leaves
out, through System Events, behind sleight's approval. Live-tested with real approvals on Magnet's menu
(read, and `choose` "Settings…"), LogiJuice's SwiftUI panel (opened by a real click, then read), a
test banner (listed, then closed) and the terminal approval path (a declined elicitation refused the
call).
LogiJuice's panel buttons have no labels. The logijuice session can add `.help` or
`.accessibilityLabel`. Notification Center hung at 100% CPU once that evening (a 9-day-old process,
restarted); cause unknown, so watch for it when using `notifications`.

Benchmark (fair, Opus 5.5): sleight and LCU both 15/18, each failing only the three text drags. The
runner checks arm isolation, defaults to Sonnet 5.5 at medium, and closes what runs leave open. The
owner finds runs tedious, so run them only with a reason.

Text drag, measured with `bench/drag-probe/`: the engine's drag lasts 14 ms with two drag events,
jumping straight to the end point. Fixing it would take a drag of sleight's own (posted mouse events
with a hold and steps, behind sleight's approval). Not started, since the owner hasn't asked for it.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`), installed
  2026-10-03. Remove with `npm run watch:remove`. Log: `~/Library/Logs/sleight/watch.log`.
- LCU 0.8.8 installed runtime-only at `~/.local/share/lcu`, registered for Claude Code only in
  `.dev/lcu-arm` (untracked). `.dev/py/python3` links Homebrew Python 3.14 for it. The user-level Claude
  Code config doesn't have LCU.
- Installed by Homebrew this session: `vale`, `ffmpeg`.
- `.dev/` (untracked) holds the 2.1.288 test CLI, pseudo-terminal test harnesses (`stop_test2.py`) and
  `make-demo.sh`.
- sleight is installed at user scope from the working copy (another session did it, 2026-10-03), so
  every Claude session on this Mac starts a sleight server from `~/Projects/sleight/plugins/sleight`.
- No background jobs are running besides benchmark runs this session starts.

## Waiting on the owner

Nothing. The owner took sleight public on 2026-10-03 and skipped the LCU heads-up and any report to
Anthropic. The TextEdit approval cleanup isn't wanted. The icon source is the existing
`sleight-icon-source.webp`.

## Reading list

- `README.md`: how it works, known problems, benchmark, update watch.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
- `.dev/stop_test2.py` (untracked): driving an interactive session in a pseudo-terminal. Judge results
  from the relay trace and the session transcript, because the screen redraws too much to match on.
