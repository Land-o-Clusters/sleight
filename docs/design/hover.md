# Local hover

Background mouse-moved events do not trigger hover (measured 2026-10-04). The skill tries Help text,
secondary actions, right-click and keys first. When those fail, `hover` takes the real pointer for
one observation. Tell the user first that it moves their pointer and brings the app forward for the
dwell plus capture and restoration, about two seconds with the default dwell. The owner's away
window is a rule for our live trials on their Mac.

The launcher advertises `hover` unless `SLEIGHT_HOVER=0`. Its arguments are an app name, bundle ID or
path, `at: [x, y]` relative to the selected window, and optional `waitMs` from 100 to 4000 (default 1500).
With one normal window on screen, its title is optional. With several, `windowTitle` must match
exactly one title. Unnamed, missing and duplicate matches refuse before activation or pointer input.

The relay resolves one running app and takes its app lease before approval. Hover has its own
per-app approval key, with the relay's session memory. A drag approval does not approve hover.
Declines and cancels do not grant anything. Document scope leaves hover out and refuses calls to it.
The benchmark hook approves hover only for Calculator, TextEdit and Chess, on its existing servers.

The native script checks the point before activation, after activation and before capture. An
overlapping window from another app or a different window of the same app stops the call. Do not
retry unchanged. Screen Recording preflight must pass before app lookup or takeover, using
`CGPreflightScreenCaptureAccess` without requesting permission. The engine's pointer overlay is excluded,
as in drag. It saves the pointer and front app before activation. After 100 ms it posts one real
mouse move, dwells, and captures the app rectangle. Cleanup attempts both restorations even if one
fails. Success returns a PNG plus the dwell and `takeoverMs`. Failures report duration and errors.

The screenshot is taken before restoration, so it can show ephemeral hover UI, but tooltips and menus
outside the app rectangle are clipped. Input leases cover other sleight sessions, while tools outside
sleight can still interfere with this observation. There is no user-input
cancellation monitor, and forced process termination can prevent cleanup. Restoration brings the
previous app forward without reproducing the full window order. The bounded dwell limits ordinary
takeover, but capture and activation can take longer.

Hover's script output allows up to 16 MiB, since a Chess PNG exceeded the default 1 MiB buffer.
Other scripts retain the default. Tests accept a 2 MiB response and refuse a 17 MiB response.

Unit tests cover validation, covered points, capture ordering, cleanup failures, duration, approval
denial, the allowlist and app lease contention. [Attempt log](../benchmarks/2026-10-04-hover-attempts.json)
records failures too. The owner confirmed an away window for the locked live trials on 2026-10-04.
The first batch failed to establish a delay. A later batch showed Calculator's sidebar tooltip
at 1500 ms, after captures at 400 and 1000 ms showed none. Chess's green-button hover menu appeared
in 400 and 1500 ms captures. The default remains 1500 ms based on these observations.
[Live report](../benchmarks/2026-10-04-local-hover.md) records every attempt, including privacy rejection.
`bench/hover-live.mjs` runs a small JSON plan under the shared live lock. It uses `bench/approve.mjs`
for every approval, redacts Chess titles, player names and home-folder labels before writing text,
and saves Calculator PNGs beside the results. Chess and TextEdit PNGs are omitted with hashes because
their titles and Save sheets can identify the user. Historical Chess plans use title placeholders.
Hover's own pointer and front-app restoration remains unmeasured separately from the fixture's cleanup.
