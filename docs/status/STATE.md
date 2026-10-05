# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-04, 0.6.0 released)

Public: `Land-o-Clusters/sleight`. Latest release `v0.6.0`: input leases, on by default (Codex A,
`112c878`, fast-forward). Benchmark with leases: 11/11 over two passes (Sonnet 5.5, medium);
textedit-save took 27 and 30 turns against 13, because a Save sheet stops the next action. 0.5.0
added change review and flow rules, both opt-in. Installed on this Mac at user scope from the local
directory marketplace. Running sessions keep the version they started with until restarted.

The change review was on by default on `main` from `844fa60` to `570a1ab` and was never released.
Its window guard failed both TextEdit tasks that open a file, so `570a1ab` made it opt-in.

The engine's helper wedged on 2026-10-03 at about 23:40 EDT: every `cua.getApp` timed out
(`-10005 timeoutReached`) until the owner restarted ChatGPT at 00:04. Cause unknown; it followed a
lease bench run that kills engine processes. Recorded in the README's known problems.

Codex time goes to known problems and enhancements, not benchmark runs (owner, 2026-10-04).
sleight-arch runs one `--runs 1` pass per merge that changes default behavior.

In flight, from the owner's Codex sessions in worktrees under `~/Projects/sleight-wt/` (prompts in
`.dev/prompts/`, untracked, run by the owner):

- `codex/change-review-guard` at `ea159cc` (Codex B): guard fixes, change review on by default. It
  conflicts with the lease in the shared window guard. Next: `codex-b-rebase.md` (rebase, one test
  with both on, then the live check where the owner clicks Undo and Keep).

Review recipe for each Codex branch: read its design note and safety paths (user-only decisions, no
auto-approval outside the benchmark allowlist), cherry-pick onto `main`, replace home paths in
published results with `~`, run `npm run check` and `npm run lint:prose`, push, release.

Branches already cherry-picked and safe to delete with their worktrees once their Codex sessions are
done: `codex/watch-api-diff` (`c058475` as `2d48e5d`), `codex/background-drag` (`32fd681` as
`ee49fd9`, prototype moved to `bench/background-drag/`), `codex/document-scope` (`9f3827a` as
`ceebdca`), `codex/change-review` (`e4e4121` as `844fa60`), `codex/flow-rules` (`fdd29c7`, fast-forward), `codex/input-lease` (`112c878`, fast-forward), `codex/background-drag-2` (`91cdda0` as `f4fb71a`, research in `bench/`).

What sleight is now: the engine through a relay, plus its own tools where the engine stops short:
`menu_bar` and `notifications` (System Events), `drag` (held, stepped, foreground; text drag 3/3
against 0/9 for `app.drag`), `document_scope` (opt-in, `SLEIGHT_APPROVAL_SCOPE=document`), `flow_exception` (opt-in) and
`review_changes`. The relay ends the engine's turn after 30 idle seconds (0.3.1). Background hover
and background drag were measured and don't work reliably, as the README records. The
fair benchmark tied LCU at 15/18 on Opus 5.5.

Market research (Codex, gpt-6.1-sol) is in `.dev/research/2026-10-04-competitors.md`, untracked.
Publishing it is the owner's call. Flow rules finished the three new-ground items on the roadmap.
Prompts are in `.dev/prompts/` (untracked), and the latest round is `round-4.md`. Merged to main since 0.6.0,
unreleased: #7 background drag (research, then background-first in the drag tool), #4 doubled-keys
probe, #6 drag window guards, #8 hover, #9 pre-approved apps, #10 blocked_app, B change review (opt-in
again after 0/2 TextEdit tasks on 2026-10-04). Not merged: #3 action notes. Rebasing onto `7540224`:
#1 helper stall, #2 clipboard (opt-in), #5 select_window, #6 drag raise, #11 browser surface, B re-read.
Benchmark on `5782453`: 3/6. The change review failed both TextEdit tasks. The drag tasks failed on the
test machine's state: TextEdit's window was on another Space, and four stacked Chess games were open.
0.7.0 waits for a clean pass of the drag tasks.
The marketplace installs from the default branch, so users installing now get main, not the 0.6.0 tag.

## Machine state outside the repo

- Weekly launchd job `com.landoclusters.sleight-watch` (Mondays 9:00, `scripts/watch.sh`). It now
  saves the engine's API docs (`~/Library/Logs/sleight/engine-api-26.930.31730.md` is the baseline)
  and diffs them on an engine update. Remove with `npm run watch:remove`.
- LCU 0.8.8 runtime-only at `~/.local/share/lcu`, registered only in `.dev/lcu-arm` (untracked).
  `.dev/py/python3` links Homebrew Python 3.14 for it.
- Homebrew: `vale`, `ffmpeg`, and the `codex` cask, upgraded to 0.160 on 2026-10-04 (0.153 rejected
  gpt-6.1-sol). `~/.local/bin/claude` updated to 2.1.289 on 2026-10-04.
- `.dev/` (untracked): the 2.1.288 test CLI, `sleight-arm` and `lcu-arm` bench folders,
  `DragProbe.app` (built by `bench/drag-probe/build.sh`), pseudo-terminal harnesses, research.
- No background jobs of this session are running. The `codex exec-server` process belongs to the
  owner's ChatGPT app.

## Waiting on the owner

- Paste `.dev/prompts/codex-b-rebase.md` to Codex B, then click Undo and Keep in its live check.
- Restart desktop sessions that started before 0.3.1 (21:17 EDT, 2026-10-03), so they stop hanging.

## Reading list

- `README.md`: how it works, known problems, benchmark, update watch.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
- `.dev/stop_test2.py` (untracked): driving an interactive session in a pseudo-terminal. Judge results
  from the relay trace and the session transcript, because the screen redraws too much to match on.
