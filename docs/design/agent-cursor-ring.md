# Agent cursor ring

The hand host accepts `--cursor-style=glove|ring`. Glove remains the default.
Split Seam is the ring style: a 14 pt warm lower-left half and cool upper-right half,
with diagonal seams and a white spark. The host draws without answering an action frame.

| State | Motion | Time |
| --- | --- | --- |
| Glide | Quadratic bow and two seam ribbons | 160 to 320 ms by distance |
| Aim | Open seams, or one rounded frame on `rect` | 120 ms, 140 ms with a rect |
| Click | Close seams, spark, spring return | 210 ms |
| Double | Repeated snap and spark | 250 ms |
| Right | Quarter twist and menu tick | 220 ms |
| Type | Small ring, alternating half taps | 120 ms entry, 60 ms per key |
| Key | One tap | 60 ms |
| Scroll | Turn seams sideways, nudge per tick | 120 ms entry, 120 ms per tick, 120 ms exit |
| Drag | Close on spark, carry with ribbons, open on drop | 90 ms grab, distance glide, 200 ms drop |
| Waiting | Wide seams, one repeating opacity breath | 160 ms entry, 1.6 s breath until the next action or status |
| Error | Red recoil, white cross, one shake, then fade | 90 ms recoil within a 240 ms shake |
| Done or handback | Warm and cool square pixels dissolve along the diagonal | 380 ms |
| Thinking | Static dim at the last point | No animation |

Colors are warm `#ff7a3d`, cool `#5b8dff`, spark white and error `#ff3d60`.
A `rgba(11,13,20,.55)` ink keyline backs the strokes. Error and menu marks use a zero-blur
ink backing on one CAShapeLayer. The label is an ink pill with 8 pt white text and
a tether from the cool side. It flips horizontally and vertically inside the target window.
Text truncates at 40 Swift characters. A changed label fades out in 60 ms and in over 90 ms.
Secure input suppresses labels and type taps.

`aim` and `status` share the existing nonce and increasing sequence admission with `act`.
They accept only their declared keys. `holdMs` defaults to zero and validates from 0 to 600.
The host does not wait for it. An optional label on `act` also validates as plain text.
Glove mode accepts and drops aim, status and labels. A status without `at` uses the last
point only when both pid and window match. Hide and panel release clear that memory.

The ring reuses the glove's click-through, nonactivating panel, target-window clipping,
capture sharing setting and capture-hold suppression. Ordinary states fade after 1.2 s
of silence using the existing 300 ms fade, then release the panel and layers. Waiting
holds until the next action or status. Reduced motion uses a 70 ms opacity glide and
omits shakes, breaths, scale pulses, type stepping and dissolve particles.
Motion uses Core Animation without a repeating timer or display link.

`RingStyle` owns paths, colors, chip geometry and animation timings. `RingStyling.plan`
returns layer specifications and `RingAnimation` values. `RingSession` owns only target
memory. A second concept supplies another type that adopts `RingStyling`. `HandHost` handles
admission, clipping, capture and panel lifetime.

`--ring-plan-dump --cursor-style=ring` reads JSON lines and prints one plan per frame
before creating `NSApplication`. The dump runs without a panel or layer. Tests can inject
`--reduce-motion`, `--secure-input` and `--clip=X,Y,W,H`. An animation record has its layer,
key path, from/to values, begin time and duration. The adapter installs the same plans.
`tests/hand-ring.test.mjs` compiles the host into a temporary directory and tests this mode.
Visible rendering, capture exclusion and idle CPU still need VC7's live checks.
