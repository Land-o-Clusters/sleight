# Background drag product checks

Branch `codex/background-drag-product`, worktree `~/Projects/sleight-wt/background-drag-product`,
2026-10-04. Started from `origin/main` at `5782453`. The architect's rebase dispatch confirmed
`codex/drag-polish` merged. Its `2e0e607` is an ancestor of main. Research `91cdda0` merged as `f4fb71a`.

## TextEdit

[Product trials](2026-10-04-background-drag-product-text.json) passed 3/3. Each exact
temporary document began with `alpha beta gamma`, with `alpha` selected through AX. The destination
was three points beyond the final glyph, at the glyph's vertical midpoint. Each result named
`background`, confirmed changed text and repaired the space. Exact-window readback was
`beta gamma alpha`. TextEdit stayed inactive, and front PID 81898 was unchanged throughout.

Pointer sampling covered 6.5 s per call: 263, 261 and 262 observations. During trial one the owner
was using the pointer. It changed position while the front app was unchanged. The last two trials
kept the pointer unchanged throughout. Source code posts only to the target PID and performs no
activation or warp in this path. Pointer variation alone cannot attribute input to a person or a
helper. The owner could keep working during the drag. A fixed pointer was measured in 2/3 trials.
All three documents closed by exact file URL. The trial script exited 0 and released the live lock.

The [sandbox attempt](2026-10-04-background-drag-product-sandbox.json) exited 1. Launch Services
could not resolve TextEdit, and AppleScript cleanup could not reach it. No document opened or drag
ran. The unchanged command was then allowed host access. The benchmark hook approved only TextEdit.

## Bridge and review

The [attempt receipt](2026-10-04-background-drag-product-attempts.json) preserves bridge failures:
an opaque NSEvent CGEvent reference produced type 0, direct casting crashed with exit 139, and named
point types bound as scalars. A typed `objc_msgSend` and field-encoded CGPoint passed a no-posting
round trip with event type 1, screen point `(120,130)` and local point `(20,30)`.
The product repeats that check for every prepared event before mouse-down.

Tests first failed for five missing path-choice behaviors, then passed after the code changes.
A launcher test first failed because background cleanup restored focus, then passed after the guard.
Review found two further hazards: replacing the snapshot during foreground settling and hiding a
failed emergency release. Both regressions failed before their fixes and passed afterward.
The focused suite passed 31/31 at that stage. Later tests cover an unchanged foreground result,
Chess fixture geometry and recovery without another drag. All attempts, including fixture failures,
are published.

The production bridge test also creates events without posting and checks their native type, screen
point, local point, chosen window and modifier. It passed after correcting an assertion for JXA's
string serialization of uint64 fields. Fixture tests cover boxed process metadata, exclusion of
Chess's auxiliary renderer and refusal of coincident AX windows.

## Chess

Read-only engine discovery passed after a sandbox failure. The failure was
`sandbox_apply: Operation not permitted`, retained in the
[sandbox receipt](2026-10-04-background-drag-product-chess-sandbox.json). The
[host read](2026-10-04-background-drag-product-chess-read.json) used the benchmark's Chess approval.

Setup attempts [one](2026-10-04-background-drag-product-chess-1.json),
[two](2026-10-04-background-drag-product-chess-2.json),
[three](2026-10-04-background-drag-product-chess-3.json) and
[four](2026-10-04-background-drag-product-chess-4.json) failed before dragging. Boxed process metadata,
an auxiliary rendering window and the engine's refusal of `getApp({windowId})` caused those failures.
Attempts two and three each created a benchmark game. Later trials resumed the exact window 240196
recorded in attempt three, using native AX geometry and readback.

The [Command trial](2026-10-04-background-drag-product-chess-5.json) and
[unmodified trial](2026-10-04-background-drag-product-chess-6.json) each posted one background
sequence. Neither moved the pawn from e2. Pointer and front app were unchanged in all 262 and 263
observations. The tool correctly reported unverified delivery and did not repeat through foreground.
The unmodified trial followed a unit test that first failed for the Command flag. These failures
used reversed AX coordinates. They do not establish a background delivery limit.

The first [engine control](2026-10-04-background-drag-product-chess-control.json) refused because
the recorded window disappeared while another session held the lock. A new game had another
auxiliary renderer, causing [control setup](2026-10-04-background-drag-product-chess-control-2.json)
to refuse. A fixture regression exposed that case, then passed after the title filter.
The [engine control at AX points](2026-10-04-background-drag-product-chess-control-3.json)
also left e2 unchanged. Its pointer and front app varied during sampling.

An exact-window [screenshot receipt](2026-10-04-background-drag-product-chess-image.json) exposed
the geometry error. AX reported white e2 near `(677,318)`. The screenshot placed it at `(680,699)`.
The measured e4 destination was `(677,548)` in the 1269 × 984 window. The image identifies the player,
so its pixels remain private and the receipt publishes only its hash. The measured plan is
[`bench/background-drag-product-chess-points.json`](../../bench/background-drag-product-chess-points.json).

The [corrected product post](2026-10-04-background-drag-product-chess-measured.json) used those
points and completed through `background`. AX readback failed while the board was updating, so
the script exited 1 without another drag. An [engine read](2026-10-04-background-drag-product-chess-readback.json)
confirmed white e4, empty e2 and black's e7-e6 reply. A harness branch skipped save and close on that
first recovery. The next [recovery](2026-10-04-background-drag-product-chess-readback-2.json)
confirmed the same move, but stopped at the save panel. Its test now requires a verified save button
and destination before clicking. A [sandbox retry](2026-10-04-background-drag-product-chess-readback-3.json)
hit the engine's sandbox denial before app access.
The [host retry](2026-10-04-background-drag-product-chess-readback-4.json) refused before input
because the engine saw only the save dialog, which did not match the game window. Recovery now
checks that dialog's recorded folder and game name. Native fixture output includes the Chess app
identity so publication redacts its titles even when the engine reads only a dialog.
The [next recovery](2026-10-04-background-drag-product-chess-readback-5.json) found another
session's game in the engine and refused input. The [final recovery](2026-10-05-background-drag-product-chess-readback-6.json)
set `AXMain` and performed `AXRaise` on the exact owned window, then again found another game
in the engine. Native readback still confirmed white e4 and empty e2 in window 240864.
The script sent no further drag or engine input, exited 1 and released the lock. The game remained
open at the last read. Save and close are unverified, recorded in README Known problems.

The corrected post had 265 pointer/front samples. Both varied while the owner was working.
It proves one e2-e4 move at screenshot coordinates, but does not qualify quiet Chess delivery.
The local tool reports unverified delivery for apps without a text snapshot; callers must read
the board. It does not repeat the drag automatically. The engine's `app.drag` remains the skill's
first choice for Chess.

## Verification

`npm run check` exited 0: 307 unit tests, both manifest validations and 8 mod tests passed.
`npm run lint:prose` exited 0 after correcting the report's punctuation.
The attempt receipt retains earlier test and lint failures, including the unchanged host retry
after an existing process-group test hit `EPERM` in the sandbox. No full benchmark ran.
App-driving runs used the shared live lock and the benchmark's app allowlist.
