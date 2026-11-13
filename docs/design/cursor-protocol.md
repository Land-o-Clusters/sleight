# Cursor protocol v1

`sleight.cursor/1` is an open event stream for cursor renderers. It uses UTF-8 JSON, one object per line.
The built-in hand keeps its existing stdin frames. Both outputs use the same planned action and geometry.
No renderer can delay, approve or change an action through this stream.

## Envelope

Every event has these fields. Objects have only the documented keys in v1. Readers ignore unknown fields.
A breaking change uses `sleight.cursor/2`.

| Field | Value |
| --- | --- |
| `v` | `"sleight.cursor/1"` |
| `seq` | Session counter, starting at 1. Gaps mean events were dropped. |
| `ts` | Milliseconds since the Unix epoch, at emission. |
| `session` | Random 128-bit lowercase hex identifier for this relay process. Never the Claude session ID. |
| `type` | `session`, `action` or `status` |

## Session

| Field | Value |
| --- | --- |
| `state` | `start` or `end` |
| `host` | `claude-code`, `codex` or `other` |
| `version` | Running sleight version |

```json
{"v":"sleight.cursor/1","seq":1,"ts":1793016000000,"session":"0022446688aaccee0022446688aaccee","type":"session","state":"start","host":"claude-code","version":"1.5.1"}
```

Start is emitted with the first public event or enabled discovery tick. A new connection receives the original start and
current status, retaining their sequence numbers. Readers merge sessions by `session` and tolerate replayed records.
End is best effort when the relay closes.

## Action

| Field | Value |
| --- | --- |
| `call` | Random opaque per-call identifier, independent of the MCP request ID |
| `index` | Action index within the call, starting at 0 |
| `phase` | `aim`, `act`, `done`, `failed`, `declined` or `skipped` |
| `kind` | `click`, `double`, `right`, `key`, `type`, `drag`, `scroll`, `select`, `navigate` or `move` |
| `source` | `native`, `turbo`, `electron` or `local` |
| `timing` | `scheduled` or `confirmed` |
| `point` | Optional `[x,y]` in global screen points, top-left origin of the main display |
| `path` | Optional drag path, at most 64 `[x,y]` points, retaining the endpoints |
| `rect` | Optional target element rectangle `[x,y,width,height]` in screen points |
| `window` | Optional object: `id`, `pid`, `app`, `bundle`, `rect`, `exposure`, Windows `appUserModelId` |
| `display` | Optional object: `id`, `scale` |
| `count` | Optional character beats, capped at 8 for `type`, or scroll steps |
| `role` | Optional known AX or ARIA role |
| `reason` | Required for `skipped`; absent for other phases |
| `label` | Optional element label, controlled by the user's setting |
| `retry` | Optional boolean: the same kind and target were planned in this window within 10 seconds |
| `transfer` | Optional `take` or `give` on a key action, from an exact Command-C, Command-X or Command-V chord |
| `say` | Optional assistant narration, at most 90 characters; see Narration |

Window exposure is `exposed`, `covered`, `offscreen`, `other-space` or `minimized`. Window rectangles use the same units as
the point. Fields within `window` and `display` are omitted when unavailable. Window titles never appear.

```json
{"v":"sleight.cursor/1","seq":3,"ts":1793016000100,"session":"0022446688aaccee0022446688aaccee","type":"action","call":"1133557799bbddff1133557799bbddff","index":0,"phase":"aim","kind":"click","source":"native","timing":"scheduled","point":[630,320],"role":"AXButton"}
```

`aim` previews a planned target. `act` marks input starting, or its native planned schedule. Native admission emits an aim for
each planned action before starting deferred geometry work. An updated aim supplies its point when that lookup completes.
Renderers update the same `(call,index)` on successive aims. The engine continues during the lookup. Native acts follow the plan's schedule
independently of approval beats. Native `done` and `failed` are confirmed call results. They do not provide a per-action engine
timestamp or prove each individual action's effect. A result confirms every action immediately and cancels future scheduled
acts. Geometry arriving after the terminal result doesn't produce another aim or act.

The stream has every planned aim of a call at plan time, so a renderer can preview the next target. sleight's own ring
gets them paced instead: the aim for the first planned action at plan time, and each later aim right after the act before it
is sent. The ring then shows one target at a time.

Turbo, Electron and local events use `confirmed` timing. Browser geometry is sampled beside input without holding it, so an
event can arrive after the input. A local drag or hover has `act` and a terminal result, with geometry omitted when the local
helper has not supplied global points. The stream never interprets screenshot pixels as screen points.

`declined` means approval was refused. `skipped` means a point could not be shown. Its reason is `covered`, `no-geometry`,
`not-found`, `unplanned`, `other-space` or `offscreen`. A skipped visualization does not cancel the underlying tool. Calls with
no fixed action plan, such as loops, use an `unplanned` record rather than inventing points or action counts.
`skipped` is terminal for that `(call,index)`. Hiding the built-in hand leaves a running call's outcome
pending until its result arrives. Closing the relay ends the session without inventing outcomes for running calls.
Browser point steps retain the hand's existing exclusion and can report `skipped:unplanned` without drawing a hand.

## Status

| Field | Value |
| --- | --- |
| `state` | `thinking`, `waiting`, `error`, `done`, `handback`, `idle` or `paused` |
| `app` | Optional app name |
| `detail` | Optional `approval`, `payment`, `page` or `handoff`, describing a known pending state |
| `say` | Optional assistant narration, at most 90 characters; see Narration |
| `call` | Optional opaque call identifier |

```json
{"v":"sleight.cursor/1","seq":4,"ts":1793016000200,"session":"0022446688aaccee0022446688aaccee","type":"status","state":"waiting","call":"1133557799bbddff1133557799bbddff"}
```

`waiting` means an approval or Always-allow card is pending. `error` means a call failed. `done` marks a successful call or
turn end. `handback` marks sign-in handoff or takeover. `thinking` marks time between calls, emitted at call results without
polling. The first status of a session is `idle` when no other status has been published. Turn end also emits `idle`.
Statuses describe the current call or turn. `done` followed by `thinking` after a call does not end the session.

`paused` is an additive state in v1. It means a person paused this relay session through its native cursor or menu control.
No new engine, turbo or local tool call is admitted. An action already sent may finish; the remaining batch stops at the next
available checkpoint. Turbo and Electron check between steps and fields. Native calls check at engine approvals and relay
continuations. A call with no further checkpoint can finish. While paused, later lifecycle statuses cannot replace it.
A person's resume emits `idle` and never replays dropped actions. Fresh native calls wait for an older paused call to return,
since the engine's approval tokens have no parent call id. The built-in host receives the same paused state. This stream
remains output-only: renderer messages cannot pause or resume sleight.

`detail: approval` marks a pending consent request. `detail: payment` marks a pending turbo payment card.
`detail: page` marks a turbo wait or navigation still pending after 2 seconds. A finished wait clears that detail.
These enums contain no amounts, keys or page text. Readers that ignore them keep parsing v1 records.
A retry mark describes repeated planning, independently of the earlier action's outcome.

The built-in sprite shows a box when a `give` follows a `take` in another window within 30 seconds.
The prop contains no clipboard data. Its placement follows the stage exclusion rules.

Sprite mode also counts completed action records per window in this turn, up to 32 windows and 999 actions per chip.
Moves and scrolls do not count. A completed native record confirms the call result, with the per-action limits described above.
A 22 pt chip sits above the content, between the 80 pt control clamps. It hides if that space intersects a target,
the person's window or a window above the target. The chip shows a count, and its tooltip includes the time. Neither
contains window titles or labels.
Tooltip availability with recording off remains unverified because the panel passes mouse events through.
It expires 10 minutes after turn end and clears when the session ends or the next turn changes a window.
With `record_runs` on, a hardware click opens the local replay in the default browser at that window's first recorded event.
The browser comes forward because the person clicked the chip.
With recording off, the chip passes clicks through and has no hand cursor. Chips use hidden capture mode. Capture holds,
lock and display sleep hide chips without clearing their records. After the hold ends, unlock or wake, the host refreshes
them through the same placement checks. Hidden records still expire 10 minutes after turn end.

## Stage qualification

The harness for stage prints its steps, a window list and estimated duration with
`node bench/hand/stage-cost.mjs --dry-run`. Live collection requires `--owner-away --out DIR`; add `--character DIR` to
measure supplied stage art. A live run follows the project's owner-away and quiet-window rules.

Receipts distinguish scripted renderer probes from runtime-selected motion. Attention ages of 0 and 8 seconds are
scripted clock labels. A size downgrade or a foreign window on the normal layer invalidates its phase while later phases
continue. Missing observations stay unmeasured. Badge dragging, consent and hint delivery need separate observations.

Before qualification, collect three runs at each size and report CPU, WindowServer, memory, decode, startup and frame
pacing, the source art hash, Mac model and macOS build. Include both capture seats' per-source pixel counts and the achieved
capture rate. The harness measures install counts, leg bounds and loader warnings. Its live costs, stage capture exclusion
and 120 Hz delivery remain unmeasured. The synthetic Codex v1 import emits one partial-character warning, which the
strict zero-extra-warnings gate refuses. The proposed CPU and RSS limits await the owner's stage-study decision.

## Narration

`narration` in `hand.json` is `off` (default), `bubbles` or `voice`. Action and status records can include `say`.
The Claude Code mod caches assistant text from its own message events, bound to the tool ID and agent loop.
It doesn't fetch a transcript or retain media. The existing `turbo-state` reply supplies the narration mode at each user prompt,
without another subprocess or a settings read from the mod. Unavailable settings or missing message events omit narration. Native receivers need a recognized acquisition since
narration was enabled or the session was compacted. The cache holds at most 16 loops and 128 calls per loop.

The cutter examines at most 1,024 UTF-8 bytes before regex work, discarding a partial final token. It keeps the first
sentence, at most 90 characters, after removing code, quoted strings, URLs, paths and email addresses.
Input calls omit narration. Echo checks suppress a sentence only when it repeats a whole word of at least four characters from text,
values, paste content or search queries, excluding enums and control labels.

The cutter also strips tokens with key prefixes beginning with `sk-`, `sk-ant-`, `ghp_`, `gho_`, `xox` or `AKIA`, long base64
or hex runs, long mixed letter/digit tokens, and Luhn-valid card numbers of 13 to 19 digits with spaces or hyphens.
These shape checks can remove ordinary identifiers and cannot identify every secret. Assistant prose can paraphrase
screen text or repeat personal names and short, unrecognized secrets. Narration is opt-in. Turn it off for sensitive work.

Public `say` requires a nonce-bound native secure-input check. The check contains a random token without prose.
A missing host, a 100 ms timeout, a malformed reply or queue overflow removes `say` while delivering the bare event.
The tool proceeds without waiting for the check. Connection replay and deferred delivery omit `say`.
Stream-only sessions without the built-in host omit `say` too. Third-party renderers must hide parked narration
when secure input changes because the native check cannot control another renderer's window.

`voice` is optional. Its `id` selects an installed system voice and its optional `rate` defaults to 0.5 (range 0.1 to 0.6).
`sleight-mcp cursor status` prints the narration mode and requested voice. The compiled host's `--narration-voices`
mode lists installed IDs without a window. With no explicit ID, the host prefers the system language, then quality.
The host skips speech when the selected ID is missing. It doesn't download voices or request Personal Voice authorization.

Voice fails closed for secure input, muted or zero-volume output, unreadable output metadata, or a process using audio input.
Main-element mute and volume fall back to per-channel properties. Process-property reads run on a utility queue,
at most once per 500 ms while needed. Voice waits for the first background check before playback. One trace line explains
unreadable audio metadata. The host reads metadata without opening an input device and treats running input as
a conservative call proxy, so recordings silence voice too and a call that has stopped input can be missed.
Live device behavior remains unverified.

Only one utterance plays, with one replaceable queued line. Immediate duplicates are ignored; the same sentence may
speak again after 10 seconds. Cancellation clears the queue. A missing finish callback times out after 15 seconds,
stopping speech, removing its bubble and ending its watcher.

## Discovery and delivery

The stream is off by default. A version 1 `hand.json` can include `"stream":true` and
`"labels":"off"`, `"role"` or `"title"`. Drawing's `enabled` switch is separate. `SLEIGHT_HAND=0` disables both outputs.
The file remains user-owned, mode 0600, without symlinks. Claude's write guard protects the entire file.
The owner can put this configuration in `~/Library/Application Support/sleight/hand.json` with mode 0600:

```json
{"version":1,"enabled":false,"stream":true,"labels":"off"}
```

There is no hand CLI subcommand for `stream` in this version. Hot-path settings reads share a 250 ms cache; file identity,
mtime, size, owner and permissions are checked when it refreshes. Disabled streaming builds no public action record.

A renderer listens on its own Unix socket under
`~/Library/Application Support/sleight/cursor/renderers/`. The directory must be owned by the user with mode 0700. Its path
must resolve without symlinks. sleight doesn't create directories or sockets there. Discovery accepts only user-owned sockets
ending in `.sock`, with mode 0600 exactly, checked again after connection.
Symlinks, regular files, subdirectories and sockets belonging to another user are skipped. Discovery and connection checks
also reject a socket replaced during connection. `SLEIGHT_CURSOR_STREAM_DIR` selects a fixture directory in tests.

The relay connects as a client and sends events. It discards incoming bytes without interpreting them. Discovery is deferred
and occurs at most once every 2 seconds, including an unreferenced timer while the stream is enabled. Disabled streaming has
no discovery timer. Dead sockets are removed and rediscovered on that schedule.
Writes never wait for connection or drain, and socket errors don't affect tool results. Each socket has a 256-event limit
including writes awaiting socket callbacks. The sink counts events dropped beyond that limit. Renderers should clear abandoned sessions after
disconnect, tolerate sequence gaps and merge simultaneous relay sessions. A renderer keeps its listener open across relay sessions.

Renderer windows must be click-through and should set `sharingType = .none` to stay out of captures. sleight has no v1 renderer
PID exclusion list. Every other window can count as cover for a drag or hover, including a renderer that intercepts input.

## Windows

The stream is off by default. A private Windows `hand.json` with `"stream":true` enables it independently of drawing.
`SLEIGHT_HAND=0` suppresses both outputs. Native owner, DACL and reparse checks protect file reads.
Windows compilation, ACL enforcement and live delivery still need VM checks.

The version stays `sleight.cursor/1`. Windows adds `window.appUserModelId`. Named pipes use
`\\.\pipe\sleight-cursor-<current-user-sid>-<name>`, with 1 to 32 ASCII letters, digits, `_` or `-` in the name.
Discovery reads values under `HKCU\Software\sleight\cursor\renderers`, never the shared pipe namespace.
Each REG_SZ value is JSON with `name`, `sid`, `pipe`, `pid` and a random 32-hex `token` for that listener incarnation.
The registry key is owned by the current user, with inheritance disabled and one full-control ACE for that SID.
At most 16 values are considered per scan. A listener removes only its own matching token on exit.
A failed pipe verification prunes only the matching registry token, so stale values can make room for newer listeners.
The registry DACL doesn't grant access to SYSTEM or Administrators on this key.

The pipe descriptor is `O:<sid>D:P(A;;GA;;;<sid>)`: current-user owner, protected DACL, one allow ACE for that user.
As with Unix mode `0600`, access belongs to the current user, and the SID in a name does not prove ownership. The writer checks the registry
token, pipe owner, DACL and server PID before sending, then repeats the check after connection. A failed connection
check drops that peer. Node does not expose the connected pipe handle. The native check opens the pipe by name.
The sealed DACL and PID check protect against other users. Processes running as the same user are outside this boundary,
as with Unix mode `0600`.

Run listeners from a normal, unelevated shell. An elevated listener whose pipe owner is Administrators is refused,
even when its DACL grants access only to the current user. sleight requires the current user's SID as owner.
The kit seals the pipe before publishing it and discards pre-publication connections. Before sealing, Node's default DACL
may admit connections that occupy slots, and the listener discards their bytes without parsing them.
Whether later libuv pipe instances retain the sealed DACL needs a Windows check.

The Windows sink uses the platform interface in `plugins/sleight/lib/platform/`. It loads the transport only during
Windows discovery. One persistent PowerShell 5.1 worker runs SHA-256-pinned `windows-security.ps1` bytes through
`-EncodedCommand`, takes JSONL requests on stdin and compiles its Add-Type helper once before announcing readiness.
No execution-policy flag is passed. A policy that blocks Add-Type or PowerShell causes startup to fail closed.
The worker uses the packages included with Windows. Startup has a separate 15-second budget, followed by a 4-second
deadline per request. Worker failures, including exits after readiness, back off for 1 second, 5 seconds and 30 seconds, then stop after the fourth failure
and report the reason. A successful security request resets the failure count. Restarting the session permits another attempt.
Discovery stays asynchronous, with the same 2-second interval and 256-event backpressure limit. A scan has one 4-second
deadline across identity, registry reads and verification. Only new or changed listener incarnations need a discovery
verification. Scans skip verification for connected peers. The sink checks a connection before sending events.
A failed or timed-out scan retains connected peers. Windows qualification must measure startup time and check native ACL enforcement.

Windows `point`, `path`, `rect` and `window.rect` use physical desktop pixels, with `(0,0)` at the primary monitor's
top-left. Producers must use per-monitor-v2 awareness to supply physical coordinates without DPI virtualization.
Monitors to its left or above have negative coordinates. `display.scale` is that monitor's DPI divided by 96.
A per-monitor-DPI-aware Win32 renderer places the point directly in physical pixels, without multiplying it by scale.
A renderer drawing in monitor-local DIPs obtains the monitor's physical origin `(ox,oy)` from the OS, then maps
`(x,y)` to `((x-ox)/scale,(y-oy)/scale)`. Divide rectangle sizes by scale too. Split paths at monitor boundaries and
use each monitor's scale. Never divide the global origin by scale. The sample scales its ring size, not its point. Built-in Windows ring art, stroke widths, chip text and sprite cells
are measured in DIPs. The built-in host converts physical frame geometry around the target monitor origin before
planning and applies the target HWND DPI when drawing. A window spanning monitors uses its HWND DPI; a monitor or DPI
change clears the old plan before the next frame binds. Geometry must keep its physical desktop location at every scale.

`window.app` is the executable path's basename, such as `notepad.exe`. `window.appUserModelId` contains the AUMID when
known. Windows omits `bundle`. Executable paths and window titles remain private. Windows overlays request
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` and stay click-through and nonactivating. That request needs a
live capture check on the Windows version and capture API in use.

## Privacy

Action geometry excludes typed and pasted text, setValue values, page text, URLs, file paths and window titles.
Opt-in assistant narration has the limits described above. `app` and `bundle`
identify the application only. Labels default to `off`, which omits the `label` key entirely.

`role` labels use generic nouns from a fixed table, such as `button`, `text field` and `menu item`. `title` labels use a control's
title or description, truncated to 40 characters. Text content roles and strings resembling URLs or paths are excluded.
Input actions omit title labels. Unknown roles omit labels too.
An opted-in control title can still contain personal text, such as an email address. Use `off` or `role` to omit it.

Secure fields, identified by `AXSecureTextField` or password input type, omit label and count. Their `type` becomes `key`.
Unknown typing focus also takes this conservative form. The native drawing host retains its secure-input check, while the
relay uses the field's role without a new host call.
