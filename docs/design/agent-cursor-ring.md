# Agent cursor ring

The hand host accepts `--cursor-style=glove|ring|seam`. Glove stays the default until the setting changes.
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
Flags: `--reduce-motion`, `--secure-input`, `--clip=X,Y,W,H`, `--seed=N`, `--gone=W1,W2` (windows whose bounds lookup fails).
`tests/hand-ring.test.mjs` drives every state, fallback and scheduling rule through it.
Appearance, capture exclusion, idle CPU and WindowServer cost still need VC7's live checks.
