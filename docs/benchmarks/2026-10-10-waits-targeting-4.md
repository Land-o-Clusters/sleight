# Waits, window targeting and stop: merge

sleight-arch squashed `codex/waits-targeting` at `2968a10` onto `pane/auto-mode` at `a8602dc`,
because Codex was out of quota. The conflicts were in the relay, the launcher, the mod, the app
health probe and the footprint sampler, against "Always allow", `open_file`, turn receipts,
verified results and the guard's cached setup. Each was resolved by keeping both sides.

A confirmed stop now also drops the verified-results and guard bookkeeping of the stopped calls
and writes the stopped turn's receipt, with the stopped call recorded as an error that may have
run. The next engine gets a fresh compactor, and its first call installs the guard again. A test
covers the receipt, and it fails without the change.

`npm run check` passed 1,410 of 1,411 tests (one skipped), exit 0. `npm run lint:prose` exit 0.
`npm run typecheck` couldn't run, because `tsc` isn't installed in this checkout or the main one.
The mod's 28 tests load `register.tsx` and pass.

Identity cost on Calculator with one window, loaded, one-minute load 12.2 to 14.2, 8 actions an
arm, 2 repetitions
([raw](2026-10-10-waits-targeting-measure-1791646930746.json)):

| Identity | Median ms per action | Warm CPU ms per action |
|---|---|---|
| on | 482, 484 | 231, 240 |
| off | 492, 515 | 250, 285 |

With one window the identity check is skipped, so equal cost is the expected result. The idle run
needs load under 3 and hasn't run.

The sleight arm passed 6/6 on calculator-click, textedit-edit and textedit-save at `6291251`, 2 runs
each, 2026-10-10 15:44 UTC, Haiku 5.5 at high
([raw](2026-10-10-waits-targeting-4-tasks.json)). Those runs cover the turn ends the branch changed,
not a stop.

Esc during a turn, `/sleight stop` followed by a new message in a real Claude Code session,
TextEdit Cmd+S with `waitFor`, and two equal-title TextEdit windows still need a live check. The
script's live mode (`node bench/waits-targeting-live.mjs live --owner-away`) asks for the owner to
be away.

The live attempts between 16:11 and 16:14 UTC, one-minute load 7.3 to 7.9, all failed setup
before reaching a stop or a save. Calculator passed its 7*8 step. The Chess board was 667 by 532
points, and the recorded move points were for 1223 by 949, so no drag was sent
([raw](2026-10-10-waits-targeting-live-1791648688709.json)). TextEdit was already running with an
Open panel up, which the script leaves alone. In the next attempt the fixture couldn't list
TextEdit's documents ([raw](2026-10-10-waits-targeting-live-1791648741525.json)), and in the one
after, the fixture didn't see a new document after Cmd+N
([raw](2026-10-10-waits-targeting-live-1791648832672.json)). One attempt found the live lock held
and didn't start ([raw](2026-10-10-waits-targeting-live-1791648821872.json)). `fbc179c` then
launched TextEdit without restored windows, as it already launched Chess. No live run since that
change is recorded.
