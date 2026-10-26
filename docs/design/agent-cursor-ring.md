# Agent cursor ring

The hand host accepts `--cursor-style=glove|ring|seam|sprite`. Glove stays the default until the setting changes.
`ring` is Split Seam+ (design D2), the default ring. `seam` is plain Split Seam, kept for comparison.
`prepareHandHost().spawn({ cursorStyle })` validates the value and passes it before `--menu` or `--consent`.

Both rings are themes of one state machine. `RingTheme` holds the palette, timings and which moves a theme has.
`RingPlanner` has one planner per state. Each move is a value tween. When a frame arrives the planner samples
every tween at 25 ms steps plus each tween's ends, and emits one keyframe track per layer property.
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

- An act waits out its `delayMs`. Aim, thinking and waiting never cancel a waiting act. Error, done, handback and hide do.
- Every plan parks when its motion ends: its animations come off and the layers keep their final values.
- Then the ring fades after 1.2 s of silence (220 ms) and releases its panel. Thinking and waiting fade the same way.
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
A `{"dumpClock": seconds}` line moves the simulated clock. Otherwise each frame lands when the last plan's motion ends.
Flags: `--reduce-motion`, `--secure-input`, `--clip=X,Y,W,H`, `--seed=N`, `--gone=W1,W2` (windows whose bounds lookup fails).
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

The relay calls `loadCharacter(folder, { installed: true })` from VC3's `hand/character.mjs`, then
`characterFrame(character, { nonce, seq, resolve: resolveCharacterStates })` from `hand/character-frame.mjs`, and sends
the result once after spawn on the act sequence counter. `characterFrame` throws for cells over 192 by 208 or sheets
over 1536 by 2288, which the host would refuse. A later character frame replaces the earlier one, even when the new one
fails to load. VC4 adds the adapter and the host side. Integration adds the relay call.

The frame's keys are exactly `hand`, `nonce`, `seq`, `id`, `sheet`, `extra` (a path or null), `cell` and `table`. Table
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
(`POSIX_SPAWN_CLOEXEC_DEFAULT` keeps the consent channel out). The child decodes built-in 1x1 PNG and WebP images,
enters a deny-default sandbox, and only then reads the file. It decodes one image (an APNG's two refuse) at the
validated size into sRGB premultiplied RGBA and writes the bytes. On macOS 27 `sandbox_init` kills the
process when given `kSBXProfilePureComputation` by name. The child passes the same rule as SBPL, `(version 1)(deny default)`. Without the warm-up, ImageIO crashed inside that sandbox. The parent reads exactly W*H*4 bytes within 2 s. A
timeout, a crash, a short read or a refusal exit means no character. The parent wraps the bytes in a `CGImage` without a
copy and checks at least 50 visible pixels and under 95 percent fully opaque pixels in every used cell. Chroma fringe
in a used cell and ink in an unused cell of a referenced row are warnings. The host knows resolved columns, not each
row's declared frame count, so it can't refuse unused ink safely. Row 0, column 6 is Codex's neutral pose and never
warns. Premultiplied bytes have zero RGB wherever alpha is zero, which leaves hidden RGB unchecked.

A load writes one stderr line on refusal or warning, and in hand mode one nonce-bound line on the hand channel's stdout,
`{"hand":"character","nonce","id","loaded","reason","warnings"}`. The hand client traces it as `hand-character` or
`hand-character-refused`. `consent-host --check-character` reads one character frame on stdin, runs the same checks and
decode child, and prints `{"id","loaded","reason","warnings"}`. `prepareHandHost()` returns `checkCharacter(frame)` for
it, so `sleight-mcp cursor check <id>` can show the user why the ring shows alone.

Each full-size sheet costs the host its 13.4 MiB of decoded bytes, freed on a replacement, a style other than sprite, or
exit. The live host's peak RSS budget is 64 MiB in sprite style (`budgetFor('sprite')` in `bench/hand/cost-pass.mjs`).
The ring and the glove keep 50 MiB. In the dump mode on 2026-10-26 (three runs each, spread under 0.1 MiB) the host's own
peak after loading was 8.3 MiB with no character, 23.2 MiB with a full-size sheet and 36.6 MiB with a full-size extra
sheet as well. The decode child peaked at 41.7 MiB and ran 0.02 s for a full-size PNG. Loading a full-size sheet took
about 0.25 s on the host's main thread, mostly the unoptimized ink check. The live figures are VC7's.

The test bank override, `SLEIGHT_CURSOR_CHARACTERS_ROOT`, and the decode child's fault switch,
`SLEIGHT_CURSOR_DECODE_FAULT`, work only with `SLEIGHT_CURSOR_TEST=1`, and the bank only below `/private/tmp/`. The
relay starts the host with `PATH`, `LANG` and the icon path only. Tests draw synthetic PNG and WebP sheets. sleight
includes no character artwork.

`--ring-plan-dump --cursor-style=sprite` decodes real images and runs the same sprite planner, with no application,
panel or window. Each draw record gains a `sprite` object with the cell poses, every track's key times and the box
positions. An offscreen `CALayer.render(in:)` check of the host's layer tree (unflipped panel layer, flipped ring root,
sprite layer) drew the sheet upright, with `contentsRect` y 0 at row 0. The window server's rendering, appearance,
capture exclusion and live cost need VC7.
