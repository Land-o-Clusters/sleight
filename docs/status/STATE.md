# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-04, before the owner's clear)

Public: `Land-o-Clusters/sleight`, `main` green in CI. CI on Linux failed from `bc81e44` to `5fb04d0`
(change-review tests used `/private/tmp`), fixed in `b1f9d0d`. Latest release `v0.4.0`
(GitHub release published, as for every release since 0.3.1). Installed on this Mac at user scope
from the local directory marketplace, now 0.4.0. Running sessions keep the version they started with,
because `/reload-plugins` doesn't restart the server. At the flush all 11 running sleight servers
predated 0.3.1, so those sessions can still show as busy after Claude finishes until restarted.

On main, unreleased: the change review (`review_changes`, Codex B, cherry-picked as `844fa60` and
`bc81e44`). Plan: release it as 0.5.0 together with the input lease once that merges.

In flight, all from the owner's Codex sessions working in their own worktrees under
`~/Projects/sleight-wt/` (prompts written by this session, run by the owner):

- `codex/input-lease` at `98dc858` (Codex A): per-window input leases. Live: two markers in 5/5
  trials without it, one marker and one refusal in 10/10 with it. It has 11 conflict hunks with the
  change review (relay, launch, document-scope, package.json). A was asked to rebase onto `origin/main`,
  keep both features, rerun its live checks and push with `--force-with-lease`. Rebase under way
  since 23:14 EDT in `~/Projects/sleight-wt/input-lease` (onto `be284c1`, 11 conflict markers left
  in package.json, relay, launch and document-scope).
- `codex/flow-rules` (Codex B, not pushed yet): user-written rules for data moving between apps, opt-in,
  enforced in the relay as a guard against mistakes. Prompt given at the flush.

Review recipe for each Codex branch: read its design note and safety paths (user-only decisions, no
auto-approval outside the benchmark allowlist), cherry-pick onto `main`, replace home paths in
published results with `~`, run `npm run check` and `npm run lint:prose`, push, release.

Branches already cherry-picked and safe to delete with their worktrees once their Codex sessions are
done: `codex/watch-api-diff` (`c058475` as `2d48e5d`), `codex/background-drag` (`32fd681` as
`ee49fd9`, prototype moved to `bench/background-drag/`), `codex/document-scope` (`9f3827a` as
`ceebdca`), `codex/change-review` (`e4e4121` as `844fa60`).

What sleight is now: the engine through a relay, plus its own tools where the engine stops short:
`menu_bar` and `notifications` (System Events), `drag` (held, stepped, foreground; text drag 3/3
against 0/9 for `app.drag`), `document_scope` (opt-in, `SLEIGHT_APPROVAL_SCOPE=document`) and
`review_changes`. The relay ends the engine's turn after 30 idle seconds (0.3.1). Background hover
and background drag were measured and don't work reliably, as the README records. The
fair benchmark tied LCU at 15/18 on Opus 5.5.

Market research (Codex, gpt-6.1-sol) is in `.dev/research/2026-10-04-competitors.md`, untracked.
Publishing it is the owner's call. Flow rules is the last of the three new-ground items on the roadmap.
The research's other gaps (exact-window targeting, reporting whether an action took effect, clipboard
ownership, more harnesses) are candidates the owner hasn't picked yet.

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

- Run the two Codex prompts (A: rebase the lease; B: flow rules), then hand the results to the next
  sleight-arch session to review and merge.
- Restart desktop sessions that started before 0.3.1 (21:17 EDT, 2026-10-03), so they stop hanging.

## Reading list

- `README.md`: how it works, known problems, benchmark, update watch.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `bench/`: tasks, the arm setup in `run.mjs`, and the approval hook only benchmark runs load.
- `.dev/stop_test2.py` (untracked): driving an interactive session in a pseudo-terminal. Judge results
  from the relay trace and the session transcript, because the screen redraws too much to match on.
