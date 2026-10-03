# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-03, end of session)

Private repo `Land-o-Clusters/sleight`, `main` green in CI (relay tests, plugin validation, mod tests,
Vale prose lint). `v0.1.0` is tagged. Nothing is public.

Verified live on Claude Code 2.1.288 with ChatGPT engine 26.930.31730: background control, one approval
per app per session, per-turn cleanup, the pane and status line, `/sleight stop` mid-turn, and
`/sleight <text>`. The Chess demo is in the README.

Benchmark against LCU 0.8.8 (2026-10-03, published in full in `docs/benchmarks/`): both arms passed
12/15. Both failed the TextEdit drag task 0/3 the same way.

## Next session's first job: the drag rabbit hole (owner's call, 2026-10-03)

Dragging selected text fails because the engine's macOS `drag` presses, moves and releases at once,
and text views only start a text drag after a hold. The macOS engine's `drag` takes only a start and an end
point, while its Linux build offers a press-hold-release drag handle. Calling the native helper directly
is ruled out because it skips the engine's per-app approval.

The fix to test is the `NSDragAndDropTextDelay` preference (milliseconds before selected text becomes
draggable). It's undocumented, so prove it before relying on it.

1. Ask the owner first: it changes an app setting on their Mac.
2. `defaults write com.apple.TextEdit NSDragAndDropTextDelay -int 0`, then quit and reopen TextEdit.
3. `CLAUDE_BIN=$PWD/.dev/cli/node_modules/.bin/claude node bench/run.mjs --arm sleight --tasks textedit-drag --runs 1`
4. Undo either way unless the owner keeps it: `defaults delete com.apple.TextEdit NSDragAndDropTextDelay`.

If it works, build an opt-in `/sleight fix-drag <app>` command and a README note, and rerun the drag
task on both arms. A failure means checking whether the engine's drag sends intermediate mouse-move
events at all, because without them no delay setting can help. Posting our own mouse events outside the
engine is the last resort, and I recommend against it: the engine's per-app approval wouldn't cover them.

Also open: adding Chess to the benchmark allowlist, for a drag task that passes (owner's call under
LAWS). The skill and README already give the cut-and-paste workaround.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`), installed
  2026-10-03. Remove with `npm run watch:remove`. Log: `~/Library/Logs/sleight/watch.log`.
- LCU 0.8.8 installed runtime-only at `~/.local/share/lcu`, registered for Claude Code only in
  `.dev/lcu-arm` (untracked). `.dev/py/python3` links Homebrew Python 3.14 for it. The user-level Claude
  Code config doesn't have LCU.
- Installed by Homebrew this session: `vale`, `ffmpeg`.
- `.dev/` (untracked) holds the 2.1.288 test CLI, pseudo-terminal test harnesses (`stop_test2.py`) and
  `make-demo.sh`.
- No background jobs are running.

## Waiting on the owner

- The NSDragAndDropTextDelay test above.
- Chess on the benchmark allowlist (yes or no).
- The icon's original PNG from ChatGPT as `docs/assets/sleight-icon-source.png`, and optionally a
  small-size version.
- Before going public: read ChatGPT's terms on the bundled computer-use engine, give LCU's author a
  heads-up about the comparison, then flip the repo and add sleight to the org profile README
  (`Land-o-Clusters/.github`, `profile/README.md`, matching the Floati and Puddle entries).
- Optional: remove `com.apple.TextEdit` from the engine's global approvals file
  (`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`).

## Reading list

- `README.md`: how it works, known problems, benchmark, update watch.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
- `.dev/stop_test2.py` (untracked): driving an interactive session in a pseudo-terminal. Judge results
  from the relay trace and the session transcript, because the screen redraws too much to match on.
