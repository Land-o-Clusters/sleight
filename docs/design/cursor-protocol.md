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
| `window` | Optional object: `id`, `pid`, `app`, `bundle`, `rect`, `exposure` |
| `display` | Optional object: `id`, `scale` |
| `count` | Optional character beats, capped at 8 for `type`, or scroll steps |
| `role` | Optional known AX or ARIA role |
| `reason` | Required for `skipped`; absent for other phases |
| `label` | Optional element label, controlled by the user's setting |
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
| `state` | `thinking`, `waiting`, `error`, `done`, `handback` or `idle` |
| `app` | Optional app name |
| `say` | Optional assistant narration, at most 90 characters; see Narration |
| `call` | Optional opaque call identifier |

```json
{"v":"sleight.cursor/1","seq":4,"ts":1793016000200,"session":"0022446688aaccee0022446688aaccee","type":"status","state":"waiting","call":"1133557799bbddff1133557799bbddff"}
```

`waiting` means an approval or Always-allow card is pending. `error` means a call failed. `done` marks a successful call or
turn end. `handback` marks sign-in handoff or takeover. `thinking` marks time between calls, emitted at call results without
polling. The first status of a session is `idle` when no other status has been published. Turn end also emits `idle`.
Statuses describe the current call or turn. `done` followed by `thinking` after a call does not end the session.

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
