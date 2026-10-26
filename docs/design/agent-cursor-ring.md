# Agent cursor ring

The hand host accepts `--cursor-style=glove|ring|seam|sprite`. Glove stays the default until the setting changes.
`ring` is Split Seam+ (design D2), the default ring. `seam` is plain Split Seam, kept for comparison.
`prepareHandHost().spawn({ cursorStyle })` validates the value and passes it before `--menu` or `--consent`.

Both rings are themes of one state machine. `RingTheme` holds the palette, timings and which moves a theme has.
`RingPlanner` has one planner per state, over state values named by the `RingKey` enum. Each move is a value tween.
When a frame arrives the planner samples every tween at 25 ms steps (75 ms in plans longer than 1 s) plus each tween's
ends, and emits one keyframe track per layer property that changes.
The host installs one animation, or one animation group, per layer. Core Animation alone runs the motion, and every animation ends.

## States (Split Seam+)

| State | Motion | Time |
| --- | --- | --- |
| Entrance | Seeded per appearance: clasp (the halves close in), assemble (pixels) or pop (the spark) | 180, 220 or 200 ms |
| Glide | Bezier bow, wind-up, stretch and lean from the curve's velocity, overshoot up to 4 pt, ribbon | 160 to 320 ms by route length |
| Glide start | Reach line from the cool half and the spark's glance, both in the first 70 ms | Inside the glide |
| Settle | Back onto the point with a squash, alongside the next move | 150 ms |
| Early action | A frame that lands mid-glide finishes it from where the ring is | 60 ms |
| Aim | Wrap the rect with wide gaps, or widen the gaps on the circle, then breathe through `holdMs` | 140 ms, 120 ms |
| Click | Gaps snap shut, squeeze, seeded spark and rebound; a wrapped frame flashes a warm-to-cool tint | 210 ms |
| Double | Two snaps, the second spark turned 45 degrees | 250 ms |
| Right | Gaps twist a quarter lap and back, a corner mark | 220 ms |
| Type | Wrap the field, halves tap one after the other, the bottom gap follows the caret | 140 ms, 60 ms per key |
| Scroll | Wrap the list, the halves tread one step per tick (at most 4) | 140 ms, 120 ms per tick, 120 ms exit |
| Drag | Grab wraps the card, the carry follows the path, drop opens wide with the tint | 120 ms, at most 420 ms, 200 ms |
| Thinking | Gaps fray, 6 pixels orbit at mixed speeds, the spark glances, then it parks | 140 ms, 3 x 1.6 s, 160 ms |
| Waiting | 12 pixels, every other one dim, one step per 800 ms with a hollow spark's nod, then it parks | 160 ms, 6 x 800 ms |
| Leaving thinking, waiting, error | Halves come back, pixels go, red clears | 120, 140, 160 ms |
| Error | Red halves recoil on the diagonal, a cross, one shake | 240 ms |
| Done with `ok: true` | A 6-pixel burst from the spark | 220 ms, then the dissolve |
| Done, handback | Pixels drift apart on the diagonal | 380 ms |

The click's spark angle, flare and rebound, the overshoot and the entrance come from the session seed and the
frame's `seq`. The same seed and seq always give the same plan. The host draws a seed at launch. The dump takes `--seed=N`.

## Data and fallbacks

| Move | Needs | Without it |
| --- | --- | --- |
| Wrap | `rect` on aim, or on a type, scroll or drag act, or an earlier aim rect that holds the act's point | A circle at the point |
| Caret ride | `caretX` on a type or key act | The halves tap one after the other, the spark stays off |
| Burst | A done status with `ok: true` | No burst |
| Thinking, waiting | Those statuses | The ring fades 1.2 s after the last act |

The bottom gap starts at the known caret x and moves an estimated 5.5 pt per key. The host gets one caret x per act.
The spark always marks the exact point, also when the halves wrap a rect.

## Scheduling

`RingRuntime` holds the rules, and the host and the dump both drive it:

- An act waits out its `delayMs`. Aim, thinking and waiting that arrive meanwhile queue behind it in arrival order.
- Error, done, handback and hide cancel waiting acts. Error, done and handback then draw at once.
- A status without `at` plays at the last plan's destination. Mid-glide, a 60 ms snap finishes the glide first.
- A status with no point to use (nothing placed yet, or another window) is dropped. The ring and waiting acts stay as they are.
- A repeat of the shown status at the same point, inside that plan, is ignored.
- A frame during a done or handback dissolve, or after a fade, starts with an entrance.
- Every plan parks when its motion ends: its animations come off and the layers keep their final values.
- Then the ring fades after 1.2 s of silence (220 ms) and releases its panel. Thinking fades the same way.
- Waiting parks still and stays up until the next frame or a hide, for at most 120 s, then fades.
- Done and handback release when the dissolve ends.
- A target window that can't be found hides the ring at once.
- The host keeps one one-shot wake-up for the earliest pending act or timer.

## Layers and budget

The halves are two 2.6 pt strokes on one 3-lap rounded-rect path, each over a 5 pt ink keyline. A circle and a rect have
the same 28 segments. A wrap interpolates the path. Strokes start and end at the gaps. Other layers are the
halves container, tint (gradient and mask), spark, cross, corner mark, 4 pixel layers of 6 squares each, 2 reach line
layers, 2 ribbon layers, and the chip with its tether. The budget is 30 layers per plan, 14 shown at once and 9
animations during a click. Each dump plan reports these counts in `budget`.

With reduced motion, a wrap or a glide is a crossfade (70 ms out, 70 ms in). Momentum, the dashed line to the target, ribbon,
breathing, orbit, steps, shake and burst are off. Under secure input the host hides labels and doesn't show type or key
taps or the caret.

## Frames and labels

`aim` and `status` share the nonce and increasing `seq` with `act`, so the relay must take all three from one counter.
Each accepts only its declared keys. New optional keys: `rect` and `caretX` (type and key only) on `act`, `ok` (done
only) on `status`. Glove mode accepts and drops all of them. Labels lose control, format (bidi overrides included) and
separator characters, then keep 40 characters and at most 80 scalars. The chip fades in only when the label changes.
A changed label fades the old chip and tether out in 60 ms.

## Dump

`--ring-plan-dump --cursor-style=ring|seam` reads frames and prints one JSON line per effect (draw, drop, hide, park,
fade, release), then an `end` line with `idle`, `pending` and `timers`. It builds no application, panel or layer.
Only a `{"dumpClock": seconds}` line moves the simulated clock. Frames between two clock lines arrive at the same moment.
Flags: `--reduce-motion`, `--secure-input`, `--clip=X,Y,W,H`, `--seed=N`, `--gone=W1,W2` (windows whose bounds lookup fails),
and `--time-plans`, which prints each draw's planning time instead of the plan. In the host's own build (`swiftc` without
`-O`) a thinking frame plans in about 1.5 ms and a waiting frame in about 2 ms (median of 100, 2026-10-26).
`tests/hand-ring.test.mjs` drives every state, fallback and scheduling rule through it.
Appearance, capture exclusion, idle CPU and WindowServer cost still need VC7's live checks.

## Sprite

`--cursor-style=sprite` adds a character beside Split Seam+, off until the user picks that style. The ring keeps the exact
target point. The character's cell box sits 18 pt below and to the right of that point and never covers it: near the
target window's right or bottom edge the box moves to the left of or above the point. In v1 the hotspot leaves the box
where it is. Moving the box never mirrors the artwork. Only a resolved entry's `flip` mirrors it.
Without a loaded character the host draws the ring alone.

One `CALayer` draws the character. Its `contents` is the decoded sheet, and a discrete keyframe animation of
`contentsRect` steps through cells. A state on the extra sheet switches `contents` at its boundary. Every track's key
times run from 0 to 1. Before a late first stage (a drag's grab starts after the entrance) the first pose shows.
Position follows the ring's planned positions without its stretch or rotation. Its track also samples just before
each pose, so a flip or scale change jumps instead of sliding. Opacity copies the ring cursor's entrance, crossfades and
dissolve, and the ring's fade, park and release cover the character too. Loops stop stepping at 4.8 s and rest on their
first cell until the ring fades. A one-shot with a follow-up (handoff, then idle) plays it once. Reduced motion shows
each state's first cell. Under secure input, type and key show idle art. Core Animation does all of this from the
installed animations, without sprite timers or frame callbacks. Downscaled cells filter linearly, and each
`contentsRect` is inset by half a texel so a neighbor cell never bleeds in.

When the style is sprite, the relay's hand client (`hand/client.mjs`) loads the setting's character with
`loadCharacter(folder, { installed: true })` from `hand/character.mjs` and builds
`characterFrame(character, { nonce, seq, resolve: resolveCharacterStates })` from `hand/character-frame.mjs` before it
spawns the host. It sends the frame once, after the menu and before any queued act, on the act sequence counter.
`characterFrame` throws for cells over 192 by 208 or sheets over 1536 by 2288, which the host would refuse. With no
character set, one VC3 refuses, or one too large, the client spawns the ring instead and traces one
`hand-sprite-fallback` line (`CHARACTER_NOT_SET` or `CHARACTER_INVALID`). A later character frame replaces the earlier
one, even when the new one fails to load.

The frame's keys are exactly `hand`, `nonce`, `seq`, `id`, `sheet`, `extra` (a path or null), `cell` and `table`, plus
`perch`, `perchSheet` and `lines` for perch mode (below). Table
entries have exactly `sheet`, `row`, `frames`, `ms`, `loop`, `flip` and `hotspot`, and may add `size`, `scale` and `then`.
`frames` is a count from column 0 or an array of columns 0 to 7. The adapter sends arrays, which keep a state's start
column and the doubled double-click fallback. `ms` is one number or one per column. `size` is the expected sheet's
`[width,height]` and `scale` is the manifest's. The adapter always sends both. Without `size`, the host checks cell
alignment and the image header only. `then` names the state that follows a one-shot.

The table holds VC3's 19 resolved states. `move@N`, `aim@N` and `drag-carry@N` (N 0 to 15, clockwise from up) override
them where a direction changes the art, and `move-far@N` and `drag-carry-far@N` where a glide over 60 pt changes it
(R3 1.4: a Codex pet's horizontal glides play its running rows). A glide picks the nearest direction, and a stage
without movement uses the base entry. The host picks entries from the table and never resolves states itself. A state
missing from the table uses idle. A scroll state without its own art shows the look pose up or down. Scroll frames have
no direction field, and the host shows scroll-down for both. Drag shows grab, carry and drop at the ring's phase
boundaries.

A character frame may be 32 KiB, and other frames keep the 8 KiB limit. Unknown keys, malformed values, a wrong nonce
or a sequence that doesn't increase take the existing exit-65 fault path. The consent channel keeps its isolation rule.

The host opens images only from below `~/Library/Application Support/sleight/characters/<id>/`. Each path must equal
its realpath. Files must be regular, single-link, owned by the user, mode 0600 and at most 8 MiB. The bank and the
character folder must be owned by the user, with no group or world write. The open uses `O_NOFOLLOW_ANY`, which refuses
a symlink in any component, and `F_GETPATH` must give back the checked path. The host reads the PNG or WebP header
itself (an animated WebP is refused there) and compares the size with the cap of 1536 by 2288 pixels, the cell grid and
the adapter's `size`. The extra sheet loads only when an entry uses it.

The host itself never passes character art to ImageIO. It starts a child of its own binary, `consent-host --decode-sheet
W H png|webp`, with the checked file as stdin, a pipe as stdout, `/dev/null` as stderr and no other descriptor
(`POSIX_SPAWN_CLOEXEC_DEFAULT` keeps the consent channel out). The child starts with an empty signal mask and default
signal actions. It first decodes built-in 1x1 PNG and WebP images. Then it sets hard limits of 8 descriptors and 2 s of
CPU and enters a deny-default sandbox. Only after that does it read the file. It
decodes one image (an APNG's two refuse) at the validated size into sRGB premultiplied RGBA and writes the bytes. On
macOS 27 `sandbox_init` kills the process when given `kSBXProfilePureComputation` by name. The child passes the same
rule as SBPL, `(version 1)(deny default)`. Without the warm-up, ImageIO crashed inside that sandbox. macOS 27 refuses
`RLIMIT_AS`, `RLIMIT_DATA` and `RLIMIT_RSS` at any value (EINVAL), so the child has no memory limit beyond the parent's
deadline. The parent reads exactly W*H*4 bytes within 2 s, then gives the child 0.5 s to exit before SIGKILL. That
deadline and reap are the real bound. The CPU limit is a second line for a buggy decoder: macOS only sends SIGXCPU at
it, which compromised code can ignore. A test with the deadline lengthened to 8 s sees a spinning child end at about
2.1 s. The host keeps the live children's pids and kills them from `atexit` and on SIGTERM and SIGHUP, so a host that
exits mid-load leaves none. A host killed with SIGKILL still orphans its child, since macOS has no parent-death signal.
A timeout, a crash, a short read or a refusal exit means no character. A refused limit or sandbox has its own reason,
`sandbox`, apart from a crash (`child`). The parent wraps the bytes in a `CGImage` without a
copy and checks at least 50 visible pixels and under 95 percent fully opaque pixels in every used cell. Chroma fringe
in a used cell and ink in an unused cell of a referenced row are warnings. The host knows resolved columns, not each
row's declared frame count, so it can't refuse unused ink safely. Row 0, column 6 is Codex's neutral pose and never
warns. Premultiplied bytes have zero RGB wherever alpha is zero, which leaves hidden RGB unchecked.

A load writes one stderr line on refusal or warning, and in hand mode one nonce-bound line on the hand channel's stdout,
`{"hand":"character","nonce","id","loaded","reason","warnings"}`. The hand client traces it as `hand-character` or
`hand-character-refused`. `consent-host --check-character` reads one character frame on stdin, runs the same checks and
decode child, and prints `{"id","loaded","reason","warnings"}`. `prepareHandHost()` returns `checkCharacter(frame)` for
it, so `sleight-mcp cursor check <id>` can show the user why the ring shows alone.

The decode runs on a background queue (`SpriteLoader`). Until it finishes the ring draws alone, and acts never wait for
it. The sprite joins at the next frame after. A later character frame or a change away from sprite style cancels a
load in flight: the read loop polls in 50 ms slices, kills the child and drops the result. In the dump, a character
line cost the dump's thread under 50 ms while the child took a slowed 1 s.

Each full-size sheet costs the host its 13.4 MiB of decoded bytes, freed on a replacement, a style other than sprite, or
exit. The cost pass's peak RSS budget is 64 MiB for a run with `--cursor-style sprite` (`budgetFor` in
`bench/hand/cost-pass.mjs`, which scores both of its reports). The ring and the glove keep 50 MiB. In the dump mode on 2026-10-26 (three runs each, spread under 0.1 MiB) the host's own
peak after loading was 8.3 MiB with no character, 23.2 MiB with a full-size sheet and 36.6 MiB with a full-size extra
sheet as well. The decode child peaked at 41.7 MiB and ran 0.02 s for a full-size PNG. Loading a full-size sheet took
about 0.25 s, mostly the unoptimized ink check, now on the loader's queue. The live figures are VC7's.

The test bank override, `SLEIGHT_CURSOR_CHARACTERS_ROOT`, and the decode child's fault switch,
`SLEIGHT_CURSOR_DECODE_FAULT`, work only with `SLEIGHT_CURSOR_TEST=1`, and the bank only below `/private/tmp/`. The
relay starts the host with `PATH`, `LANG` and the icon path only. Tests draw synthetic PNG and WebP sheets. sleight
includes no character artwork.

`--ring-plan-dump --cursor-style=sprite` decodes real images and runs the same sprite planner, with no application,
panel or window. Each draw record gains a `sprite` object with the cell poses, every track's key times and the box
positions. An offscreen `CALayer.render(in:)` check of the host's layer tree (unflipped panel layer, flipped ring root,
sprite layer) drew the sheet upright, with `contentsRect` y 0 at row 0. The window server's rendering, appearance,
capture exclusion and live cost need VC7.

### Perch mode

With `perch: true` (`sleight-mcp cursor style sprite <id> --perch`), the character is drawn on the target window's top
edge instead of trailing the ring (art direction A2). The ring still marks the exact point. The character frame adds `perch`
(the seat point in cell pixels and a 14-entry table: the nine perch states, `jumping`, both runs, `error` and `handoff`,
each resolved by `resolvePerchStates` so a Codex pet perches on its feet), the third sheet's path in `perchSheet`, and
the pack's `lines`. A picker frame, `{"op":"options","perch","lines"}`, follows the character frame and every change of
either setting. The host decodes the perch sheet through the same child and pixel checks as the other two.

`PerchRuntime` (`BEGIN PERCH` in `consent-host.swift`) reacts to the ring's draws, so act delays and queueing stay the
ring's. It places the box on the edge nearest the target, 80 pt from the window's sides (40 under 256 pt wide, centered
under 176), 72 pt off a target within 56 pt under the edge, and on the uncovered span nearest the target after every
window in front has cut the edge. A new aim on the same window moves the seat only past 60 pt. Under 96 pt wide, or with
less headroom than the seat line, it peeks: the cell is masked at the edge, at most 48 pt above it. It hides under 48 pt
wide, under 40 pt of headroom, when covered, in full screen and when the window is gone. Moves are a 280 ms drop on
arrival, a 240 ms hop per 120 pt, a run past 360 pt (at most 600 ms), a parabola between windows on one display (60 pt
above the higher edge, `320 + 0.5 * distance` ms up to 520), and a fade and pop over 400 pt or onto another display.
Reduced motion makes every move a 150 ms crossfade and shows each state's first cell. Reactions follow A2's table: aim
points toward the target's side, a click bumps 3 pt, typing, scrolling and dragging peek, waiting holds the card up to
120 s, and an error winces. Each call's done with `ok` gets a nod (a 3 pt bump and the hop's settle cells) and the ring's
usual burst at the point. The high-five plays once a turn, at the relay's turn-end done, when the turn's last call
succeeded, and only then does the ring's burst play at the palm (`RingRuntime.dissolveAt`). Otherwise the turn's end
hands back.
After 20 s without a frame it sleeps for 3 cycles under three rising z glyphs (one replicated layer), then stills with
one z. The next frame startles it with a 6 pt bump. A person dragging or resizing the window hides it, and it returns
500 ms after the frame stops changing.

The host rereads the window list every 0.5 s while perched and awake, every 2 s asleep and every 0.25 s while the window
moves. One read took 0.28 ms median over 200 calls (2026-10-26, load 11). Each plan is one set of keyframe animations
built when the frame arrives. A leap animates position, contents and contentsRect, sleep's loop animates the cell and the
z group, and a park removes them all.

Lines are a pack's own short sentences (`lines` in `character.json`), shown in a white comic bubble over the box. The nine
moments are `start` (a turn's first aim), `first-click` (its first done with `ok`), `typing`, `long-wait` (12 s of
thinking or waiting), `approval`, `error`, `done` (a turn that ends after a success), `handback` and `wake`. A turn ends at the relay's done without `ok`, a hand back
or sleep. At most one line shows per 8 s (error, approval and done may replace one), and never on two consecutive acts.
Picks avoid that moment's last `min(6, count - 1)` lines, seeded from the session seed, and a moment with one line says
it once a turn. Lines wait for a narration bubble to fade, and one already up fades in 60 ms when narration arrives
(the narration lane calls `PerchRuntime.narration`). The bubble has its own small nonactivating panel, the only part of
the overlay that takes a click. A person's fresh mouse click (`personActivation`, mouse only) dismisses it, and other
input is refused. `lines: off` turns them off.

`--perch-dump [--reduce-motion] [--seed=N]` drives `RingRuntime` and `PerchRuntime` on a simulated clock with window lists
from `{"dumpWorld": ...}` lines, plus `dumpNarration`, `dumpPaused` and `dumpClick`. It builds no panel or layer and
decodes nothing. `tests/hand-perch.test.mjs` drives the seat rules, moves, reactions, sleep, hide rules and the lines' caps
through it (19 tests). Appearance, the mask's direction in the flipped layer tree and live CPU need VC7.
