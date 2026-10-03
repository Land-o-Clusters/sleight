# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-03, late evening)

Private repo `Land-o-Clusters/sleight`, `main` green in CI. `v0.1.1` is tagged (desktop
approvals), and the user-scope install on this Mac is updated to it. Nothing is public.

App approvals now work in the desktop app's Code tab (`a5f8f37`). The Code tab (Claude 2.19675.0)
declines MCP prompts unseen, so under `CLAUDE_CODE_ENTRYPOINT=claude-desktop` the relay asks with
`lib/ask.js`, a Liquid Glass panel. Proven live with a real click (accept),
and the engine's repeat request came from session memory. The engine waited 60 s and 120 s for an answer. The owner approved
the panel's look. The Code tab's own Claude Code is 2.1.286, too old for the mod, so no pane there.

The drag rabbit hole is closed for now. Launching TextEdit with `-NSDragAndDropTextDelay 0` (the shell
can't write TextEdit's sandboxed prefs) still failed the drag task, 0/2. We don't know whether the
engine sends any mouse-drag events between press and release; finding out needs a probe app on the
allowlist (owner's call). Cut and paste stays the documented workaround.

Chess is on the benchmark allowlist (owner, 2026-10-03), with a `chess-drag` task that kills Chess
before each run. All runs are in `docs/benchmarks/2026-10-03-chess-drag.json`. With Chess restarted,
LCU passed 3/3 and sleight 2/3, then 3/3 once the sleight arm ran from an empty folder (set D,
traced). Until set D the sleight arm ran inside this repo and read the project memory, which LCU's
arm never did. The published 12/15 table has the same confound.

Next: rerun the full benchmark on both arms from their empty folders (about $15 at today's costs, the
owner's call) and replace the table. Then follow the owner's rule in LAWS, with LCU as the
competitor. LCU's adapter passes the engine's instructions through untouched and doesn't add guidance
of its own. The desktop approval prompt and the pane are already things LCU lacks.

The benchmarks this session cost $15.19 in all.

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
- `~/.local/bin/claude` is 2.1.278 and fails `claude plugin validate` on the mod. Checks pass with
  `PATH=$PWD/.dev/cli/node_modules/.bin:$PATH` (2.1.288, what CI pins). Updating it is the owner's call.
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
