# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-03, late evening)

Private repo `Land-o-Clusters/sleight`, `main` green in CI. `v0.2.0` is tagged, and the user-scope
install on this Mac is updated to it. Nothing is public. Running sessions keep the version they started
with, because `/reload-plugins` doesn't restart the server.

App approvals now work in the desktop app's Code tab (`a5f8f37`). The Code tab (Claude 2.19675.0)
declines MCP prompts unseen, so under `CLAUDE_CODE_ENTRYPOINT=claude-desktop` the relay asks with
`lib/ask.js`, a Liquid Glass panel. Proven live with a real click (accept),
and the engine's repeat request came from session memory. The engine waited 60 s and 120 s for an answer. The owner approved
the panel's look. The Code tab's own Claude Code is 2.1.286, too old for the mod, so no pane there.

The drag rabbit hole is closed for now. Launching TextEdit with `-NSDragAndDropTextDelay 0` (the shell
can't write TextEdit's sandboxed prefs) still failed the drag task, 0/2. We don't know whether the
engine sends any mouse-drag events between press and release; finding out needs a probe app on the
allowlist (owner's call). Cut and paste stays the documented workaround.

Benchmark, fair at last (2026-10-03, Opus 5.5): sleight and LCU both passed 15/18. Each failed only
the three text drags. The README table and `docs/benchmarks/2026-10-03-fair-rerun.json` have it. Two
confounds are fixed: the sleight arm runs from an empty folder (it used to read this repo's memory),
and `bench/settings.json` turns off the user-installed sleight, which had leaked into the LCU arm. The
runner checks arm isolation before every run. From now on it defaults to Sonnet 5.5 at medium
(owner), and it records the model each run used. The owner finds the runs tedious, so don't run more
without a reason.

0.2.0 adds `menu_bar` and `notifications` (owner's scope call), because the engine leaves out Control
Center and Notification Center. They run `lib/menubar.js` through System Events with the host app's
Accessibility permission, behind sleight's approval per app and once for notifications. Tested live
with real approvals on Magnet's menu (read, then closed) and a test banner (listed, then closed by its
Close button). A repeat call came from session memory. Not yet tried: `choose`
on a real menu item, a popover window (`press`), the terminal's elicitation path live (unit tests
only), and LogiJuice's Snooze button.

Benchmark costs here are what Claude Code reports at API prices. Runs log in through the owner's
claude.ai plan, so they use plan limits, not money.

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

- Whether to add a probe app to the benchmark allowlist, to learn if the engine's drag sends
  intermediate mouse events. Without it we can't tell why text drags fail.
- Whether to report the desktop app declining MCP prompts to Anthropic (outward-facing).
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
