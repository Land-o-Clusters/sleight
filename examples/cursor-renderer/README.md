# Build a cursor renderer

Node 24 runs these examples without packages. The optional Swift example needs macOS and its SDK.
The [cursor protocol](../../docs/design/cursor-protocol.md) defines `sleight.cursor/1`, its privacy rules and field values.
This kit includes a plain circle and synthetic events, without character packs or vendor art.

## Five steps

1. Choose a renderer name, such as `my-ring`. Create a listening Unix socket named `<name>.sock` in
   `~/Library/Application Support/sleight/cursor/renderers/`. The directory must be owned by your user, mode `0700`,
   without a symlink. Both readers and replay require socket mode `0600` exactly, with no extra permission bits.
   The socket must be owned by your user and must not be a symlink. If a bind reports `EADDRINUSE`, probe the existing
   socket by connecting. Only `ECONNREFUSED` permits unlinking it and retrying once. Refuse an active socket or an
   inconclusive probe. Remove your socket on exit only while you still own its identity.
   `SLEIGHT_CURSOR_STREAM_DIR` selects a different directory for fixtures. macOS socket paths allow 103 UTF-8 bytes.
2. Accept multiple connections. Each relay session connects as a client and sends UTF-8 JSON objects, one per line.
   Several sessions can use one connection. Closing it removes views that have no other connection. Key your view by
   `session`, a random 128-bit hex id, and keep its
   last `point`, action `phase` and `status` state. Sequence gaps can occur when a writer drops events under pressure.
3. Read `v` before interpreting fields. Drop other versions with one warning, ignore unknown fields and unknown event
   types, and discard malformed records. The reference reader bounds a line at 65,536 bytes and resumes at the next newline.
   Points are global screen points from the main display's top-left corner. Native `scheduled` phases predict action timing.
   `confirmed` phases report it. Do not interpret a prediction as proof that an input happened.
4. Draw without taking control. Every overlay must be click-through and never take focus. Use `sharingType = .none`
   as a capture exclusion request, then verify it on your macOS version. Use a non-activating panel with `ignoresMouseEvents = true`,
   `.canJoinAllSpaces`, and `canBecomeKey = false`. Any window outside sleight's own host counts as cover for sleight's
   drag checks, including a third-party renderer window. A ring left over a drag's start or drop point makes sleight
   refuse the drag as covered. Hide at the drag's `aim`, or `act` if no aim arrived, through that action's `done`, `failed`,
   `declined` or `skipped`. Match both `call` and `index`. The examples track overlapping drags per session. Event delivery is asynchronous and may
   drop records. This kit cannot guarantee that hiding precedes a drag check. Hide the renderer entirely
   if you need to rule out its cover. This lane did not measure live drags.
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
Replay waits for each write, unlike sleight's fire-and-forget emitter, so a slow renderer can delay replay.
The 24-event sample covers a button click with window, display and label fields, eight-character type, 12-point drag,
covered skip, waiting, done, failure, decline, idle, handback and session end. Its points and identifiers are invented;
it contains no typed text, titles, URLs or file paths.

For a JS renderer, reuse the reader and close it when your renderer exits:

```js
import { createCursorListener } from './listen.mjs';

const listener = await createCursorListener({
  name: 'my-renderer',
  onEvent(event, view) {
    // Draw only when view.visible is true. Otherwise hide this session's ring.
    console.log(event.session, view.visible, view.point, view.phase, view.status);
  },
  onRemove(session) { /* Hide and release this session's drawing resources. */ },
});
process.once('SIGTERM', () => listener.close());
process.once('SIGINT', () => listener.close());
process.once('SIGHUP', () => listener.close());
```

`createCursorListener` returns a promise for `{ path, sessions, close }`. `sessions` is a Map. Its entries also keep the
last `seq`, session `state` and `visible` flag. `onEvent(event, view)` sees every accepted event, including terminal ones.
`onRemove(session, view)` signals that drawing resources must be hidden and released. Callback exceptions produce warnings
without stopping the listener. `close()` disconnects clients, prunes views and removes the socket.

Both examples keep at most 4 sessions, dropping the oldest, and accept at most 16 connections. A session is removed on
status `done`, `handback`, `idle` or `error`, on session end, when its last connection closes, or after 3 seconds without
an accepted event. Expiry uses local receipt time, never the event's `ts`. A missed drag completion leaves that session's
ring hidden until expiry or another terminal event. A JS renderer must honor `visible` and `onRemove` for this to work.

## Optional Swift circle

```sh
swiftc examples/cursor-renderer/RingOverlay.swift -o /tmp/ring-overlay
```

`/tmp/ring-overlay --name ring` is intended to draw a plain blue circle at each action point. It uses `.accessory` and
passive panels, with at most 4 panels. Skipped, failed and declined actions hide their session's panel, as do drag calls.
The lifecycle rules above release panels. SIGINT, SIGTERM and SIGHUP remove its socket.
One serial reader queue services nonblocking connections. A queue of at most 128 lines drops the oldest under pressure.
Regular main-thread batches contain at most 32 lines. A disconnect flushes that connection's remaining queued lines
before removing its views. Each connection's partial line is limited to 65,536 bytes.
Run it only when you intend to show an overlay. The automated test checks the safety properties in source and runs
`swiftc -typecheck` only when `xcode-select -p` succeeds. It never launches the overlay.

Visibility, capture exclusion, focus behavior, Spaces, multiple displays and drag cover still need live qualification on
your Mac. Merge this kit after VC1 supplies the linked protocol document; integration must confirm its emitter uses
lowercase 32-hex session ids and requires sockets at mode `0600` exactly.

## Windows

Node 24 uses named pipes on Windows. Run these commands from `cmd.exe` in the repository root:

```bat
node examples\cursor-renderer\listen.mjs --name reference
```

In another terminal:

```bat
node examples\cursor-renderer\replay.mjs examples\cursor-renderer\sample-session.jsonl --speed 4
```

Windows uses `\\.\pipe\sleight-cursor-<user-sid>-<name>` and discovers listeners in
`HKCU\Software\sleight\cursor\renderers`. `SLEIGHT_CURSOR_STREAM_DIR` applies only to Unix sockets.
The shared adapter at `plugins/sleight/lib/hand/windows-transport.mjs` and its `windows-security.ps1` helper are
required for these Windows commands. Keep both beside their existing imports when copying the kit.
The helper uses Windows PowerShell 5.1 and .NET Framework, with no added packages or execution-policy changes.
It checks the helper's SHA-256 before every worker start and runs those bytes through `-EncodedCommand`, without an
execution-policy flag. It receives JSON data on stdin. A policy that blocks PowerShell or Add-Type causes startup to fail closed.
The registry key and pipe require current-user ownership
and protected DACLs with one full-control ACE for that SID. Startup refuses an unsafe existing registry key.
The listener binds, seals its pipe, then publishes its registry value. It never unlinks a Windows pipe.
Writers verify the registry token, owner, ACL and server PID before delivery and again after connecting.
Worker startup and Add-Type have a separate 15-second budget, followed by a 4-second deadline per security request.
Worker failures, including exits after readiness, back off for 1 second, 5 seconds and 30 seconds, then stop after the fourth failure and report the reason. A successful security request resets the count.
Windows replay allows 5 seconds for connection and validation after discovery has started the worker.
Replay still allows at most 1 second per write. The relay's event writes never await these checks.

The relay's stream is off by default. A private Windows `hand.json` can opt in with `"stream":true`.
`SLEIGHT_HAND=0` suppresses both the stream and drawing. Native ACL enforcement and relay delivery need VM checks.
The commands above exchange fixture events independently of the relay's setting.

`RingOverlay.cs` draws a plain circle from the listener's stdout. Compile it in `cmd.exe` with the in-box .NET Framework
4.8 compiler, then run it only when you intend to show an overlay:

```bat
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /out:RingOverlay.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll examples\cursor-renderer\RingOverlay.cs
node examples\cursor-renderer\listen.mjs --name ring | RingOverlay.exe
```

The example requires Windows 10 2004 or later. It requests per-monitor-v2 DPI awareness before creating a window.
Incoming coordinates are physical pixels. Its 48-DIP ring size uses `display.scale`. A renderer using local DIPs
subtracts the monitor's physical origin before dividing by scale, as specified in the protocol.
The window uses `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` and requests
`WDA_EXCLUDEFROMCAPTURE` before showing. A rejected affinity call stops the example. It keeps at most 4 session
windows, 64 tracked drags per session and 128 queued records, with 32 records per UI tick. Lines are capped at
65,536 UTF-8 bytes. Rings hide for drags and terminal events and expire after 3 seconds without an accepted event.
Ending stdin exits the overlay. Stop the listener separately if it is still running.

The Mac tests use mock pipes and check the C# safety properties in source. They do not compile C#, execute the
PowerShell helper or prove Windows ACL enforcement. Compilation, focus, click-through behavior, capture exclusion,
mixed-DPI placement and x64/ARM64 operation need a Windows session. Replay does not qualify Windows app driving.
