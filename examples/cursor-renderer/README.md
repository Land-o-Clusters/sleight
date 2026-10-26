# Build a cursor renderer

Node 24 runs these examples without packages. The optional Swift example needs macOS and its SDK.
The [cursor protocol](../../docs/design/cursor-protocol.md) defines `sleight.cursor/1`, its privacy rules and field values.
This kit includes a plain circle and synthetic events, without character packs or vendor art.

## Five steps

1. Choose a renderer name, such as `my-ring`. Create a listening Unix socket named `<name>.sock` in
   `~/Library/Application Support/sleight/cursor/renderers/`. The directory must be owned by your user, mode `0700`,
   without a symlink. The socket must be owned by your user, mode `0600`. Refuse existing sockets, and remove yours on exit.
   `SLEIGHT_CURSOR_STREAM_DIR` selects a different directory for fixtures. macOS socket paths allow 103 UTF-8 bytes.
2. Accept multiple connections. Each relay session connects as a client and sends UTF-8 JSON objects, one per line.
   Connections are independent of session lifetimes. Key your view by `session`, a random 128-bit hex id, and keep its
   last `point`, action `phase` and `status` state. Sequence gaps can occur when a writer drops events under pressure.
3. Read `v` before interpreting fields. Drop other versions with one warning, ignore unknown fields and unknown event
   types, and discard malformed records. The reference reader bounds a line at 65,536 bytes and resumes at the next newline.
   Points are global screen points from the main display's top-left corner. Native `scheduled` phases predict action timing.
   `confirmed` phases report it. Do not interpret a prediction as proof that an input happened.
4. Draw without taking control. Every overlay must be click-through and never take focus. Use `sharingType = .none`
   to exclude it from the agent's screenshots. Use a non-activating panel with `ignoresMouseEvents = true`,
   `.canJoinAllSpaces`, and `canBecomeKey = false`. Any window outside sleight's own host counts as cover for sleight's
   drag checks, including a third-party renderer window. Capture exclusion does not exempt your window from those checks.
   Keep the stream read-only: sleight never reads from the socket. Do not send acknowledgments, commands or input events.
5. Test with the sample replay below. Enable sleight's opt-in cursor stream separately when you want real events.
   The renderer does not change sleight settings. Treat labels, when enabled, as private data. Avoid persisting them.

## Read and replay without sleight

In one terminal, run these commands from the repository root. The reference listener prints one compact JSON line per event.

```sh
export SLEIGHT_CURSOR_STREAM_DIR="$(mktemp -d /tmp/cursor-kit-XXXXXX)"
echo "$SLEIGHT_CURSOR_STREAM_DIR"
node examples/cursor-renderer/listen.mjs --name reference
```

In another terminal, set `SLEIGHT_CURSOR_STREAM_DIR` to that printed directory, then run:

```sh
node examples/cursor-renderer/replay.mjs examples/cursor-renderer/sample-session.jsonl
node examples/cursor-renderer/replay.mjs examples/cursor-renderer/sample-session.jsonl --speed 4
```

Replay preserves the JSON lines and their timestamp gaps, divided by `--speed` when supplied. It discovers sockets at
startup and skips symlinks, foreign owners, sockets outside mode `0600`, and directories outside mode `0700`.
A dead or stalled socket gets at most one second per connection or write. Replay never starts sleight or a Mac app.
The 21-event sample covers a button click, eight-character type, 12-point drag, covered skip, waiting, done, failure,
handback and session end. Its points and identifiers are invented; it contains no typed text, titles, URLs or file paths.

For a JS renderer, reuse the reader and close it when your renderer exits:

```js
import { createCursorListener } from './listen.mjs';

const listener = await createCursorListener({
  name: 'my-renderer',
  onEvent(event, view) {
    // view.point, view.phase and view.status belong to event.session.
    console.log(event.session, view.point, view.phase, view.status);
  },
});
process.once('SIGTERM', () => listener.close());
process.once('SIGINT', () => listener.close());
```

`createCursorListener` returns a promise for `{ path, sessions, close }`. `sessions` is a Map. Its entries also keep the
last `seq` and session `state`. `close()` disconnects clients and removes the socket. Renderers should coalesce drawing work
and prune old session views if they run indefinitely. A session end remains available in this reader's
Map for inspection.

## Optional Swift circle

```sh
swiftc examples/cursor-renderer/RingOverlay.swift -o /tmp/ring-overlay
```

Running `/tmp/ring-overlay --name ring` listens in the same directory and opens a plain blue circle at each action point.
It draws one panel per session and hides skipped or failed actions. Session end closes that session's panel.
It never activates the app or sends input. SIGINT and SIGTERM remove its socket.
Run it only when you intend to show an overlay. The automated test compiles it and never runs it.

Capture exclusion, focus behavior, Spaces, multiple displays and drag cover still need live qualification on your Mac.
