# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-04, after midnight)

Public: `Land-o-Clusters/sleight`, `main` green in CI, `v0.4.0` tagged, listed on the org profile
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

Text drag is fixed in 0.3.0 by sleight's own `drag` tool (`lib/drag.js`): hold 500 ms, 25 steps,
real mouse events in the foreground, pointer and front app restored, and no press if another app's
window covers the start point. Benchmark text drag 3/3 on Sonnet 5.5 (`docs/benchmarks/2026-10-04-drag-tool.json`),
against 0/9 for `app.drag`. A press right after the engine acts doesn't take, so it waits 1.5 s first.
Background drag (Codex A, merged as research only): a private `CGEventSetWindowLocation` path
delivered full drag sequences to the probe app in 5/5 quiet trials, 2/5 during real use and 1/1 with
a longer hold, with the pointer unmoved, but moved TextEdit text 0/10. The prototype is in
`bench/background-drag/`, outside the plugin, and the `drag` tool keeps the foreground path. The
report is `docs/benchmarks/2026-10-03-background-drag.md`.

Market research (Codex on gpt-6.1-sol, 2026-10-04) is in `.dev/research/2026-10-04-competitors.md`,
untracked, with its GitHub evidence. Publishing it is the owner's call. The biggest finding is that
Anthropic has its own computer use, in the Claude desktop app (background on macOS 15+, per-app
approval) and in the Claude Code CLI (`/mcp computer-use`, Pro/Max, interactive only). Its
shortcomings for the owner are the reason sleight exists, so there's no benchmark against it. The
README compares the two from Anthropic's own docs instead. Other gaps it names: other harnesses (LCU covers Codex CLI and Pi), exact-window
targeting, reporting whether an action took effect, finer approval scopes, clipboard ownership, and
input leases across sessions. LCU moved to `amontlabs/lcu`. The owner picked the research's new-ground
items for the roadmap. Document scope is in 0.4.0 (built by Codex B, opt-in, a guard against mistakes). The change
review (Codex B, `review_changes`, file-backed documents, undo only on the user's decision) is on main,
unreleased. The input lease (Codex A, `codex/input-lease`) conflicts with it in the relay and waits for
A to rebase. Both go out together as 0.5.0. Next for Codex B: rules for data moving between apps.

Owner's plan (2026-10-04), after the drag: work through every item in Known problems, and research
the market for what sleight can do better.
Codex is researching competitors in the background, and the owner runs Codex for build work from
prompts this session writes. Linux is a headless box and there's no Windows machine, so both wait.

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
