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

Esc during a turn, `/sleight stop` followed by a new message in a real Claude Code session,
TextEdit Cmd+S with `waitFor`, and two equal-title TextEdit windows still need a live check. The
script's live mode (`node bench/waits-targeting-live.mjs live --owner-away`) asks for the owner to
be away.
