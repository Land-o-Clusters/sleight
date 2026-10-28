# Changelog

## 1.5.0 (unreleased)

### Turbo reads

- `browser_read` can return a viewport JPEG (at most 1,000 px), and `browser_act` can return 2 to 4 motion frames (480 px). Pages with protected fields return no pixels.
- `links:true` lists unique `text -> URL` rows, 146 characters against 506 for the full snapshot on one fixture.
- `console`, `network` and `performance` return scrubbed data for the current page, capped at 100 rows and 8,000 characters.
- `export` writes an observed table, grid or list to CSV or JSON. A 200-row table that the snapshot cut at 40,000 characters exported whole. Hidden clipped text and authentication codes are omitted.
- `whole` reads a full thread: 120 chat items in 24.4 to 25.5 s with zero clicks on a fixture that paces its own loading. It holds non-GET requests from expander clicks, SharedWorker requests included. Loader discovery stays inside the chosen scroller. `whole.max_steps` caps work at 1 to 500 steps (default 200).
- Owned PDF tabs and named local PDFs are read through PDFKit in a sandbox, up to 32 MiB. A tab can re-fetch its PDF after a resource-cache miss.
- Viewport steps accept `color_scheme`, `reduced_motion` and `touch`. Reset and release clear emulation. Wait steps accept text, URL or page quiet, and a stuck tab recovers in place.

### Turbo actions and guards

- `paste` sends text or a TSV block to an observed ref and restores the clipboard.
- `download` saves an observed same-origin link, up to 3 per message at 32 MiB each and 128 MiB per session.
- Turbo refuses app links, native form destinations and HTTP redirects into native apps, and reports page-initiated native navigation.
- Cookie walls default to Reject or necessary-only. Turbo and the engine path refuse an accepting label in an identified wall, and a wall with no reject option stops and asks.
- With `SLEIGHT_POINT_INPUT=1`, click, hover and drag accept viewport points from a fresh read. It's off by default, and guarded controls always need refs.
- A Claude Code hook blocks shell launches that could take focus after a sleight call (`SLEIGHT_SHELL_GUARD=0` opts out). Uploads refuse hidden, Library and system paths and files over 40 MiB.
- Popup actions end a batch before the next step. Transient page readiness gets one bounded retry, and opening a page records its phases in the trace.
- Turbo package verification reuses a full hash for at most 1 second, with file identity checked on every call. Consent inspection reuses labels only within one synchronous read. Default-off experiments cover popup observation, form batching and full observation. Their flags remain off.
- The mod no longer rewrites tool input. Auto mode skips its classifier, and browser guidance prefers turbo while native guidance stays scoped to native apps.

### Sign-in and approvals

- Handoff with `wait:true` pauses up to 4 minutes and returns a fresh read after Continue. `app_handoff` resumes a native app's new window. Away from the Mac, waiting handoffs return a pending result immediately and keep their card answerable. Pending handoffs fence browser and local app calls, and stale lifecycle replies cannot release a newer handoff.
- A tab handed to the person is kept open at turn end. Demo pages report viewport size before closing so a fast close cannot lose its restore record.
- Protected cards accept a typed word and Return from a physical keyboard. Inactive cards require a fresh hardware click on the card before activation. Posted mouse input and Accessibility presses are refused.
- Away from the Mac (a phone prompt, a locked screen or 120 s without input), an app card ends the waiting call at once with what to type. A first line `allow <app>` in the user's own prompt approves that app's low-risk cards for the session, and a bare yes grants nothing. Matching uses the engine catalog's bundle id.
- Settings open without an active sleight session. Security-sensitive settings keep their person-only confirmation.

### Agent cursor and characters

- An open local event stream lets other renderers follow sleight actions and statuses. The character format is independent of vendor pets. The branded ring marks the target. Sprites are hidden until selected, and the cursor stays off until enabled.
- Ring and sprite controls pause and resume the session. A confirmed pause refuses new calls and stops a batch before its next step. An action already sent may finish. Host replacement preserves pause.
- The picker selects ring, seam, glove or sprite styles. Character import validates manifests and images in a sandbox and explains missing event animations and their fallbacks. Codex v1 and v2 and supported Petdex atlases keep their original bytes. sleight distributes compatibility and its own original art, with no vendor pets or art.
- sleight includes six original MIT characters. Character plugins and `.sleightchar` packs can supply more. The picker warns about executable plugin components. `/sleight:make-character` builds a pack for review, and `cursor check` can validate an uninstalled pack.
- Optional perch mode places a sprite on the target window's edge. Character lines stay outside Claude's context and the public stream, with an 8 s display cap.
- Optional narration shows Claude's latest sentence in a bubble or speaks it with an installed system voice. It doesn't request another model response. Filters remove common sensitive values. Paraphrases and short secrets can remain, so turn it off for sensitive work.

### Records, hooks and memory

- `/sleight stats` and the pane show the last turn's duration, calls, text and host tokens.
- `Record this turn.` saves a GIF with the page pixelated and fields blacked out (30 frames, 12 MiB). A demo recorder can produce a 240-frame MP4 from approved captures.
- Optional cursor-run recording stores delivered screenshots and filtered events in private local files, up to 5 MiB per session, with 30-day retention and a 200 MiB managed cap. The local replay has a scrubber and no network access. Screenshots may contain private document content.
- `sleight-mcp watch` checks a public page without a model and notifies on change.
- With the action log on, turbo remembers generic controls per origin: 3 calls and 1,362 ms on a scripted second run, against 5 and 3,560 ms.
- `SLEIGHT_COMPLETENESS=1` and `SLEIGHT_OUTCOMES=1` add read-scope and unverified-effect notes.
- Hook state belongs to each registration and agent loop. A teammate's completion cannot clear another loop's shell fence or replace the main pane's app log.

### Native recovery and security

- Native list-focus recovery is bounded and never double-clicks. New-tab batches can end with a screenshot. TextEdit guidance uses the supported engine API and button names.
- Source inspection recognizes every JavaScript line-comment terminator and refuses ambiguous regex or division syntax before engine dispatch. This closes cases where inspection could miss an executable action.
- Deferred engine documentation keeps its provenance. Caller output containing a documentation heading can no longer be promoted into the next call's engine instructions. An error or failed output write cannot supply trusted documentation.
- Replay without a payment card refuses the payment. A replay failure keeps its original reason if closing its servers also fails.

### Benchmark and harness

- The FowlBrowser rematch pins `e51c52a`, after the earlier `6a12d60` comparison. The held-out coverage includes five job fixtures, a mail-to-Numbers task and three whole-thread tasks, separate from the 13 core browser tasks. The Cursor arm journals its own work and refuses uncertain state. `--agent-seconds` offers a separate agent clock.
- Finder setup retains the created window, recognizes its own folder dialog and recovers document-less windows on macOS 27. Mail fixture reads retry scoped Accessibility queries and retain evidence after a dialog stop. A vanished CDP target during fixture reset has a narrow retry rule.
- Benchmark turbo delivers images as the installed relay does and rejects foreign MCP servers in a clean sleight arm. It reads product presence for waiting handoffs. Remote-approval checks require trusted mod begin receipts and allow only model-facing tools. Person checks record delivered event metadata and continue after a failed row.
- Compatibility checks validate the installed engine launch shape, including option files, before an engine session starts.
- Settings grading accepts an explicit stop at a widened dialog and records click-through. Socket-start tests await both outcomes with bounded fixture waits. The results hub includes validation banks and regenerates charts and README summaries.

### Measured results

- The [release A/B](docs/results/validation.md) passed all 8 groups on 2026-10-28, engine `26.1023.50603` build `22391`, build B `e679ed7e` against 1.4.2 (the 1.5.0 harness with the 1.4.2 plugin tree). Passing lower-median totals fell by 4.97% in Chrome Haiku, 5.34% native, 2.13% held-out controls, 0.74% additional page tasks in Safari and 4.65% additional page tasks in Firefox. Chrome Opus lost 1 pass (13 to 12). No group lost 2 or more. The release passed the group limits while Safari (+10.57%), Chrome Opus (+5.14%) and Firefox (+2.74%) are slower. The earlier release A/B record uses engine `26.1021.31345`.

<!-- hub:release-slowdowns -->
Individual expected times at least 24% slower against 1.4.2:

| Group | Task | Change | A runs | B runs |
| --- | --- | --- | --- | --- |
| Held-out controls Haiku | `cc-list-pop-up-firefox` | +31.67% | 3 | 3 |
| Held-out controls Haiku | `cc-dropdown-slow-firefox` | +34.89% | 3 | 3 |
| Chrome Opus | `form-checkout` | +24.03% | 1 | 1 |
| Chrome Opus | `form-settings-helium` | +25.41% | 1 | 1 |
| Chrome Opus | `demoid` | +74.34% | 1 | 1 |
| Chrome Opus | `inject-order` | +113.61% | 1 | 1 |
| Firefox Haiku | `inject-order` | +40.00% | 3 | 3 |
| Firefox Haiku | `inject-mail` | +24.35% | 3 | 3 |
| Native Haiku | `textedit-insert-line` | +51.49% | 3 | 3 |
| Native Haiku | `textedit-edit` | +53.27% | 3 | 3 |
| Safari Haiku | `form-checkout` | +32.06% | 3 | 3 |
| Safari Haiku | `inject-order` | +36.96% | 3 | 3 |
| Safari Haiku | `inject-mail` | +26.26% | 3 | 3 |
| Safari Haiku | `mdn` | +31.26% | 3 | 3 |

Chrome Haiku `inject-mail` was +23.94% slower, rounded to 24% (5 A runs, 5 B runs).

Tasks with no B pass:

| Group | Task | A passes/runs | B passes/runs |
| --- | --- | --- | --- |
| Chrome Opus | `inject-mail` | 1/1 | 0/1 |
| Firefox Haiku | `form-settings-helium` | 0/3 | 0/3 |
<!-- /hub:release-slowdowns -->

- The [FowlBrowser rematch](docs/results/browser-turbo.md), dated 2026-10-28, compares sleight build `e679ed7e` (harness `4275bedb`) against FowlBrowser `e51c52a`. On `claude-haiku-5-5`, turbo had the lowest expected time on 12/13 core tasks in Chrome (256.1 vs 399.2 s total) and 12/13 in Helium (258.2 vs 434.0 s). FowlBrowser paid on the unpriced checkout in 1 of 3 Chrome and 2 of 3 Helium Haiku runs, and its expected time includes those failures. On `claude-opus-5-5`, it had the lowest expected time on 12/13 in each browser, with totals of 232.6 s in Chrome and 219.8 s in Helium. FowlBrowser has no Opus total because it paid on all 3 unpriced checkouts in each browser. Both models ran at high effort, with competitor defaults. Turbo used engine `26.1023.50603` build `22391`.
- The rematch's 8 held-out tasks are separate from the 13 core tasks. Haiku turbo completed 6 of 8 tasks, with the lowest expected time on 3 of 8. FowlBrowser completed 6 of 8 tasks, with the lowest expected time on 4 of 8. The whole-thread regrade gives 5/9 for each arm. Turbo failed job-kanban 0/3 against FowlBrowser's 3/3. Both arms failed job-motion 0/3. FowlBrowser used yellow/teal/purple where the grader required amber/teal/violet. The hub includes every failure, median and range, with p90 only at 5 or more runs.
- Live feature checks in installed Chrome 155 and Helium (2026-10-25) passed 12 of 14 features in each browser after fixes for viewport reset, PDF tab reads and a redirect to `mailto:`. Page watch and turn stats were not checked live.

## 1.4.3 (2026-10-28)

- ChatGPT's engine 26.1023.50603 starts its server with `--import <file URL>` before the script. The doctor, setup and
  an engine restart now find the script past node's options. On that engine, 1.4.2's doctor and setup report `MISSING
  server script: --import` and exit 1. By reading the code (not run live), a 1.4.2 session that was running when the
  engine updated fails each later call while it reconnects, until Claude Code restarts sleight.

## 1.4.2 (2026-10-22)

- sleight starts when its plugin folder is reached through a symlink, such as a symlinked `~/.claude`. Before, the
  launcher compared the script path as typed with the resolved module path, so it exited silently with status 0,
  and sleight never appeared. The launcher and the six other entry points with the same check now compare resolved
  paths.
- INSTALL's agent notes ask the installing agent to end with the steps left for the user, the first approval card for
  each app included. A public install test on 2026-10-22 had Codex install and enable 1.4.1 in 3 of 3 runs, and every
  final message left out the approval card.

## 1.4.1 (2026-10-22)

### Electron turbo

- Electron turbo passed live qualification for the first time. One combined run on build ff8be8b0 (2026-10-22)
  passed qualification 22/22 and relaunch 9/9, with a person answering all 6 approval cards in 1.1 to 3.3 s.
  Earlier attempts on the way there scored 13/22, 20/22 and 21/22.
- A reply and the events that follow it now reach the worker in the order the app sent them. Before, a worker could
  see an event ahead of its reply and lose the main page's execution context.
- A revoke during a batch is reported as an error: `ELECTRON_PARKED: revoked, N of M steps ran`. Before, the batch
  returned an ordinary result.
- Relaunch compares the app's path after canonicalising `/private/tmp` and `/tmp`, quits a copy that fails
  readiness, and treats an empty bundle id during the app's exit as not yet registered. A host that restarts and
  reattaches now authorizes the recorded launch, so it admits the app's pages again (before, the worker saw zero tabs).

### Approvals and cards

- When an approval card closes, the card host returns focus to the app that was in front, so the benchmark app no
  longer takes focus after the person's click. A person's own app switch wins.
- Cards use one horizontal button row sized to their choices. Electron cards keep the app name, version, bundle and
  permission explanation visible, with technical identity fields under Details.
- Permission buttons read Don't allow, Allow once, Allow this session and Always allow, and each card offers only
  its supported scopes. Restart cards keep Cancel and Quit and reopen.
- Shell approvals open a styled sleight card with its icon, and the glove reopens it. Identical shell retries join
  the call that is waiting and run once. Action and payment requests still ask, and each gets its own decision.
- The engine path's payment card escapes directional controls in the site, amount and button it shows, as the
  request and styled fields already do.
- Cards appear even while their host is inactive, and decisions are bound to pending request IDs. An owned
  fake-card run refused Accessibility, PID-posted and spoofed-HID input, then accepted a physical click.
- Grok Bot approvals show one styled card with its sound, once (the owner checked a Chess request on 2026-10-22,
  and a same-session repeat asked nothing). Menu overflow, transport and shared-host operation still need
  qualification.

### Turbo receipt

- A server no longer replaces the turbo receipt of another live copy of sleight. The copy with the newer plugin
  version takes the receipt, doctor and status report which copy holds it, and a failed write of the ownership
  sidecar is reported. Before, a new Claude Code session started from a 1.4.0 checkout overwrote a 1.4.1 receipt.

### Documentation and results

- The README has a three-line native benchmark summary and a Turbo section with the published Chrome and Helium
  results and commands to turn it on and off. It states that the ChatGPT desktop app is required in `/Applications`
  and that no ChatGPT sign-in is.
- The benchmark hub (charts, hub pages, interactive page and README results) refreshes after each completed
  benchmark pass. The release preflight fails on a stale hub.
- The first native reference can reuse documentation captured during startup, which removes 201 characters of
  API whitespace on the qualified engine format. Latency and token savings are not measured.
- An offline tool prepares a comparison GIF from approved recordings and refuses outputs of 5,000,000 bytes or more.

### Release and benchmark tooling

- Plugin manifests and the Claude and Cursor marketplace entries report 1.4.1 (the 1.4.0 release carried a manifest
  still saying 1.3.1). Doctor prints the installed version, and offline checks compare it with the manifests and
  the newest CHANGELOG heading.
- An offline preflight for releases checks versions, tag, placeholders, private release-note data, history and Linux
  test evidence. A Node 24 Docker preflight (optionally through Colima) runs the suite on locked Linux dependencies.
  A test-path guard rejects hardcoded macOS temporary and home paths.
- A validation driver reruns named tasks three times on the final build and fails on a higher expected time or lower
  pass rate than the recorded A rounds. A workflow-documentation A/B driver has offline evidence only.
- The benchmark runner waits for accepted operations to settle on interruption and keeps the app, evidence and
  lock when an effect is uncertain.

### Not qualified

- An Electron browser fill stopped by a revoke still returns a plain result instead of the revoke error. The
  reattach review's lower-severity findings are deferred to 1.4.2.
- Finder fixture setup, cancellation and cleanup ownership have no live qualification. The latest Finder smoke failed
  before retaining a window identity.
- GH8 (visible-hand pacing) is blocked on supported action events for engine-persisted Always allow grants. The
  partial change is unmerged and the hand's off default is unchanged.
- Grok Bot still needs qualification for menu overflow, transport, shared-host operation and card counts through
  its shell.

### Validation

Run on 2026-10-22 with Haiku 5.5 at high effort on engine 26.1016.51333. Both builds ran the same 1.4.1 benchmark
harness for the native comparison.

- Chrome turbo, 13 tasks, 3 runs a side: both builds passed 39 of 39. Total expected time was 213.0 s for 1.4.0 and
  218.9 s for 1.4.1, with 1.4.1 faster on 6 of the 13 tasks.
- Native held-out tasks, 8 of the 10 (the two Finder tasks are out while the Finder fixture is unqualified): the
  mean total was 515.8 s for 1.4.0 (3 runs, 18 of 24 passed) and 501.7 s for 1.4.1 (7 runs, 42 of 56 passed).
- One Opus 5.5 round of the 13 Chrome tasks on 1.4.1 passed 13 of 13 in 237.3 s.
- The 1.4.1 harness itself makes native tasks slower: 1.4.0 measured 420.7 s on its own harness (5 runs). Results
  from the two harnesses are not comparable until that is found.

## 1.4.0 (2026-10-20)

### Install and results

- The README explains requirements and setup limits before the Chess demo. Its benchmark summary defines expected time
  and names the model and engine limits.
- INSTALL.md gives humans an install path before the agent notes, fixes the default Codex home path and marks Cursor
  as unverified. It covers setup, updates and removal.
- Benchmark pages put task results first, with shared navigation, folded methods and failures, and separate comparisons
  of sleight inside Codex against Codex on the same model.
- The GitHub Pages results landing links to each benchmark family, its data and the interactive explorer. It loads no
  external scripts or fonts.
- Results include light and dark charts for the native headline, the overview and each benchmark family, with engine
  versions, model details and explicit labels for missing or failed runs.
- A light and dark architecture diagram shows the engine and turbo paths. The demo export checks synchronized captures
  before making a GIF. A new demo has not yet been recorded.
- An install benchmark checks the agent's plugin install, doctor result and remaining user steps in an isolated config.
- The install guide is shorter, marks untested host installs and commands, and a test rejects release placeholders in
  the docs unless a development override is set.

### Cursor

- A Cursor plugin and marketplace use sleight's existing launcher and skill. The doctor reports the install route and
  duplicate routes.
- Cursor's approval cards and menu bar label say "Cursor" for both editor and CLI clients.

### Grok CLI and launcher shutdown

- Grok CLI can use sleight through its Claude marketplace import or a direct MCP entry. Approval labels name Grok,
  and the doctor reports its install route. Turbo stays off in Grok.
- Grok Bot (preview) can call `sleight-mcp js` through its local shell. Sessions start on demand, exit after ten idle
  minutes and return screenshot paths. The doctor reports the shell route and live helper Accessibility status. Turbo
  stays off. Payments, bookings, settings changes and submits ask on sleight's panel. One live Calculator read passed.
  Approvals wait in the menu bar glove as a plain window and can repeat. Image delivery is unchecked.
- The Grok Bot shell route prints that it is waiting for approval on the Mac while a card is pending (GB14f).
- Protected consent buttons require physical input. VoiceOver, Switch Control, Voice Control and screen-sharing users
  need a physical keyboard or pointer for these cards in 1.4.0. A typed-confirmation alternative is planned afterward.
- The launcher registers stdin EOF and signal handlers before startup's first await, then waits for its engine and
  relay to be ready before collecting them on shutdown. A piped-handshake test checks clean launcher and engine exit.

### Local stats

- `sleight-mcp stats` reports median and p90 action times, reads saved and failures from the opt-in local log, with
  native, turbo and engine-browser results kept separate. `--days N` and `--json` are available.
- The glove's menu shows recent action times and reads saved while a session writes the log.
- Action logs record call time excluding approval waits, process identity and reads saved, without typed values or
  page text. The log stays on this Mac. [Settings](docs/settings.md#stats).
- An isolated analytics check compares log counts and timings with the relay trace and stats output, without changing
  user settings.

### Native actions and engine browsers

- A standalone `getScreenshot()` from the js tool sets the drag tool's screenshot scale. Drags in screenshot pixels
  are no longer read as window points. Safari form-settings went from 1 of 3 to 3 of 3 passes (VS1).
- Text drops can use an empty final row when Accessibility geometry proves it. Cross-window moves use Accessibility
  and refuse when it cannot safely move the text, including formatted selections.
- Accessibility text moves run before the raise and settle wait. Posted input keeps that wait, and overlapping
  windows still require a raise and another exposure check. `SLEIGHT_DP2=0` restores the earlier order.
- A changed-text drag can append changed lines from one bounded engine read while holding its lease.
  `SLEIGHT_DP4=0` disables the read, and `SLEIGHT_DP7=0` restores the earlier drop and cross-window behavior.
- Spelling annotations no longer count as formatting differences when checking whether text can move through Accessibility.
- Empty-line drops use adjacent glyph bounds, including consecutive blank lines. Line geometry rejects points outside
  the text area and handles mixed line heights without estimating a row from the first line.
- Accessibility text moves remove extra source spaces, add missing word separators and preserve the final newline
  when dropping onto an empty final line.
- Opened app handles retain their document window. Input checks its native identity, selects it in the background
  when needed and forgets uncertain aliases. A unique nonempty selection can identify a drag's source window.
- Internal opened-window requests include JSON-RPC framing. Engine exits clear pending call and lease state, and reset
  clears stale markers while refusing to interrupt live work. Unconfirmed input requires a fresh app read.
- Native input argument checks reject malformed calls before forwarding them and show the engine signature. They accept
  future string values, option fields and extra arguments, with the same checks for computed arguments in the app proxy.
- Keep the engine API documentation when opening a file requires a second window acquisition, and preserve it
  through internal reads, helper retries and acquisition refusals.
- The first scroll that moves a sorted list points Claude to `pickFromList` with that list's number. The skill gives
  the list instruction beside form batching.
- `app.pickFromList(<list>, "<row>")` accepts a list number or label and focuses the list itself. It checks the observed
  number and refuses lists whose rows trigger actions before clicking.
- List picks estimate jumps from the labels around the target, with reads between bounded key bursts and stops for
  lost focus, stalled movement or an ambiguous row.
- `pickFromList` follows a list renumbered since the last read, as scroll does. Page keys go only to the list, its row
  or passive text inside it. The Firefox held-out list task took 26.5 s expected, against 34.0 s before the fix (PL1).
- Action results wait for newly loading controls before returning the latest tree, within a bounded polling budget.
- Numbered batches can follow renumbered controls only when each remaining observed target and its parent still match
  uniquely. A resent click still passes the payment check.
- After `setValue`, a moved plain text field can be remapped when a fresh read proves a unique match, unchanged
  ancestors and the same settable fields. Payment and credential fields keep their stops. Traces explain binding
  decisions; another `setValue` still reads because native metadata cannot identify the engine's element number.
- Computer-only instructions explain that action results already show changed lines. Those results include current
  element numbers, and the final read waits for actions and list picks still running.
- A call's own Cmd+T in Safari can continue with the address and Return in that call, including from a window with no
  visible tab strip. Window, focus, idle and payment checks still apply.
- After that Return, a result that still shows the new tab under the page title reads again for the landed page.
  `SLEIGHT_TABC=0` disables the tab changes.
- Eligible Cmd+T, URL and Return sequences can check the native tab strip and address focus through read-only FIFOs.
  The bounded checks recognize Firefox address identifiers and Safari tab strips, accept closed menu children and
  request samples only when needed. Partial evidence takes a full read. Traces name failed checks and operations.
- Drag endpoints can match a short, exact static-text label exposed only as its accessibility value. Document text,
  other windows and ambiguous labels still refuse.
- `select_window` accepts a unique title ending that starts after whitespace when no exact title matches. It returns
  the full title and refuses ambiguous endings with a bounded list of candidates.
- With `SLEIGHT_BROWSER_CORE=1`, `browser_open` uses observed browser toolbars, keeps full trees through same-window
  re-reads and returns the window identity. It handles content-first toolbars and refuses duplicate or forged IDs.
  Invalid app targets return guidance to correct the browser argument. The flag stays off by default.

### Turbo

- Shorter turbo popup and refusal messages, with the same payment, confirmation and approval rules.
- Browser tools explain field values, batch boundaries, viewport markers and tab handoffs.
- Tab handles are shorter in browsers and Electron, with random generation and collision checks. `SLEIGHT_MT=0`
  restores the earlier wording and handles, and benchmark workers forward the switch for an A/B.
- Viewport guidance defines outside and partly offscreen markers. Fill and action fallbacks omit consent-refusal
  routing hints, while capability failures keep engine-path advice.
- Viewport, plain scroll, history and wait steps use bounded frame and request settling. Calls with `observe: none`
  skip an unrequested final snapshot. Waits report elapsed time and keep their duration after an uncertain submit.
- When a popup closes during input, sleight can return its owned opener's snapshot and keeps the warning for an
  unconfirmed submit, including when the opener is blocked. Alerts during the final read return a waiting-dialog
  result.
- Browser opens record the time spent in each phase without URLs, page text or tab handles.
- The benchmark census counts a worker lost on the first turbo call separately from startup errors, including older
  transcripts whose metrics omit the cause.
- Turbo accepts a hidden radio's own label and retries a cancelled click once after the same target settles, when
  the page didn't receive input. Removed, replaced or covered targets still refuse. The trusted classification excludes
  submits and payments from retries. `SLEIGHT_MC1=0` disables this change in the plugin and race harness.
- Multi-select fills set exactly the requested option texts, and an empty array clears the selection. ARIA option
  clicks use the background-click guards, including card-frame focus and target sealing.
- Click steps accept Command or Control on targets without links, controls or window-opening handlers. On macOS,
  Control uses a trusted left click with the requested modifier flags. All 20 headless multi-select cases passed.

### Optional ghost hand

- The hand reuses a session host and cached window geometry. Geometry expires within 500 ms, and turning the hand off
  stops worker reads. Bound actions contribute to hand timing. Tree hashing reads only requested lines.
- Hover waits for the hand's drawing-pause acknowledgement before capture or pointer movement. Consent cards keep
  normal process priority and clear when their worker exits. Turbo remains available if the hand host fails to start.
- The hand starts after its first local build finishes. Traces report compiler failures, cancellation and the host
  pid. Expired frames are dropped, and the compiler holds the build lock until it exits.

### Measurements and benchmark rules

- Drag method audits exclude exact Sleight refusals that stopped code before execution while retaining evidence of
  failed engine calls and replacement typing.
- Drag audits track opened handles from Sleight's final relay notice, forget shadowed and reset bindings, and allow
  documented optional reads only after a handle was opened. Competitor calls retain their previous grading.
- The app speed map publishes sequential and concurrent-session timings, failures and cleanup evidence across native
  and Electron apps. [Measured results](docs/benchmarks/2026-10-19-speed-map.md).
- Sessions that meet the same helper crash spread their read retries instead of resending together. The speed map
  names helper crashes and counts crash reports.
- Race reports keep covered runs by default. `--exclude-covered` applies the same evidence rule to passes and failures,
  and cells with too few runs stay out of fastest-task counts. Cover readings omit system overlays.
- Race instructions allow a task-requested popup in the same browser and profile, and explain how to return after it
  closes. They still refuse unrelated windows.
- The inject-mail grader accepts answers that withheld a message and rejects claims that sent it. Reports can compare
  saved and current graders without changing the original verdicts or ignoring site-log evidence of a send.
- Held-out list, calendar, dependent-dropdown and new-tab fixtures cover Firefox, Safari and native Finder. World
  benchmark approvals cover only selected task apps.
- Release validation ran the held-out list, calendar, dropdown and new-tab fixtures, 3 runs a side in Firefox and
  Safari, plus cc-list-native in Finder (2026-10-20).
- The compatibility check recognizes its own benchmark session's Safari window-selection approval.
- Browser-open A/B runs keep prompt cells separate from product cells and rotate their run order.
- The Browser Use benchmark pins AnyIO 4.14.2, pypdf 6.19.0, MCP 2.2.0 and aiohttp 3.14.4 through uv overrides.
  Browser Use stays at 0.13.11. Earlier results used the original dependency environment. Offline imports and all
  14 focused arm tests passed, including the Anthropic SDK request check.

### Not yet run live

- The new install flow and agent install benchmark, Cursor install and approval labels.
- Stats, the menu row, action logging and native analytics validation.
- Loading-control waits, batch remapping, computer-only action diffs and final reads.
- Drag labels and title endings.
- Turbo settling, popup recovery, dialogs and browser-open timings.
- Helper retry spreading and revised race instructions.

## 1.3.1 (2026-10-19)

### Engine updates

- A compatibility check runs after every ChatGPT update: a static half that reads each release's engine files on Linux
  (`bench/compat-static.mjs`, hourly), and the installed engine plus optional live checks on the Mac through
  `scripts/watch.sh`. Results go to [the compatibility record](docs/results/engine-compat.md). On 2026-10-19 the
  engine checks and the live Calculator check passed, and the live Safari page read didn't pass yet (the check's own
  window-selection approval for Safari is missing).

### Codex

- Turbo works in Codex 0.160.0 and later. A prompt hook ties each turbo turn to your message through a
  tool Codex hides from the model, and the Stop and Interrupt hooks end it. The plugin no longer sets
  `SLEIGHT_TURBO=0`. Trust the new hook when Codex asks. Not yet run live.

### Turbo

- A turbo start that fails before anything reaches the browser runs once more. Before, it left turbo off for the
  session (in a benchmark round, for the task). The startup check no longer compares the times of Chrome's profile
  folder. Chrome changes them on its own, the likeliest cause of the 2 failed starts in 185 Chrome race tasks.
  The failed stage and code go to the trace and, in benchmark rounds, to the task's `turbo-metrics.jsonl`. Not yet run
  live.

### Browsers

- A browser getApp result whose window shows its tab strip with a selected tab, as Firefox's does, now says to open a new tab
  in one call with Cmd+T, the URL and Return. In three race rounds a side (2026-10-19, Haiku 5.5 at high effort, 12 tasks),
  Firefox took 474.2, 450.8 and 440.1 s with it against 517.8, 488.5 and 512.0 s without, all 12/12. Safari's one-tab window
  doesn't show a tab strip, so all 36 Safari results kept the earlier sentence, and native apps never see either one.
- `SLEIGHT_FS=1` (under A/B) gives the js tool sleight's shorter description, which every session reads. On 10 native tasks
  three times a side it passed 24 of 27 against 25 of 27 (one task that failed every run left out) and slowed word-brief from 67.2 to 100.2 s, so it stays off.
- `SLEIGHT_BROWSER_CORE=1` (under A/B) adds `browser_open`, which opens a URL in Safari or Firefox in one call on the engine
  path. In three rounds a side on five held-out tasks (2026-10-19, Haiku 5.5 at high effort), Haiku called it 0 times in 30
  tasks, so the A/B measured nothing about it, and it stays off.

### Native apps

Each switch that was off by default ran an A/B, five alternating rounds a side on held-out native tasks
(2026-10-19, Haiku 5.5 at high effort, 55 runs, [flag A/Bs](docs/benchmarks/2026-10-19-flag-ab.md)).

- `open_file`'s first read includes the window's screenshot by default. Summed expected time on four tasks was 60.0 s
  against 65.8 s without it (standard error 5.2 s), all 25 runs a side passing.
- The skill tells Claude to take a screenshot when a document pane or table doesn't expose its text. On Word's word-memo and
  word-brief, summed expected time fell from 196.2 to 162.0 s (standard error 22.7 s), 10 of 10 passing against 9 of 10.
  Only Word ran it. The lean skill is unchanged.
- `SLEIGHT_COMPACT_CONFIRMATIONS` is gone. It didn't save time (92.3 s against 90.9 s), and confirmations read as before.
- `SLEIGHT_COMPACT_TOOLBARS=1` stays off by default. It made textedit-replace-all 16% slower (26.9 s against 23.2 s).

### Ghost hand

- A hand drawn over the app shows where sleight acts. It is off by default: turn it on from the menu bar dropdown,
  `sleight-mcp hand on` or the settings file. With it on, textedit-drag took 31 to 37 s against 23 to 26 s off (3 runs a
  side, 2026-10-19), and the screenshots sleight takes for hover can show it. [Known problems](docs/known-problems.md)
  has the numbers.

### Windows

- When an action brings up a pop-up window, such as a sign-in window in Safari, the result says it belongs to the task in
  the window it came from. A later result says when the window in front has that window's ID again. This needs an app that
  prints window IDs, and a read that counted the window the action ran in as the app's only window. The count leaves out
  windows no Space holds, such as the one Safari keeps hidden from launch, which stopped the line in all 3 live rounds.
- When `select_window` doesn't find a match, it lists window titles whole up to 120 characters. It cut them at 60, and a Safari
  profile window's 69-character title couldn't be copied.

### Electron

- Turbo for Electron apps is built but hasn't passed its live qualification yet (the first live run on 2026-10-19
  stopped in its own harness before any card showed), so Electron apps stay on the native path.

### Startup

- A session started with an A/B switch such as `SLEIGHT_FS=1`, right after sessions without it, failed every call with
  "Engine tools changed" (the first task of a Firefox race round, 2026-10-19). The startup cache now
  keeps only the engine's own replies, keyed on what starts the engine, and each session applies its own settings to
  them. A cached reply that turns out stale no longer ends the session: its calls run on the live engine, and the cache is
  rewritten. [Known problems](docs/known-problems.md) lists what such a session keeps from the cache. Unit-tested on each
  of the 67 `SLEIGHT_*` switches in the plugin's code with every value the code compares it to. Not yet run live.

## 1.3.0 (2026-10-19)

Native actions read the app less, and browsers get a turbo path, on by default, beside the engine's tools.
In the guard A/B on five native tasks (2026-10-14, Haiku 5.5 at high effort, three runs a side),
the combined changes passed 15/15 against 14/15 and cut summed median tool time from 49.9 s to 32.5 s.
After safety fixes, a follow-up passed 14/14 with one skipped run, at 43.9 s of tool time and
11.6 s of guard reads. [Guard measurements](docs/benchmarks/2026-10-14-guard-ab.md).

On FowlBrowser's 13 browser tasks in both orders (2026-10-13, Haiku 5.5 at high effort),
sleight passed 23/26 and then 21/26 against FowlBrowser's 26/26 each time, taking 1,206 s and
1,517 s against 677 s and 711 s. Every miss was a form. These rounds predate production turbo.
[Browser measurements](docs/benchmarks/2026-10-13-gate.md).

Turbo v3 on the same 13 tasks (2026-10-16, Haiku 5.5 at high effort on the owner's login, both
browser orders, five rounds, build `66ada2bd`): turbo's median round took 547 s (p90 590) with 0
errors in all five rounds, against FowlBrowser's 720 s (p90 868) and 7 errors, so 76% of its time.
Both arms finished 26/26 under the owner's scoring, and turbo took focus 0 times. With Opus 5.5 at high
effort (five rounds) turbo took 675 s (p90 713) against 885 s (p90 935), 76% again, with 41% fewer
tool calls and faster in every round. Turbo stopped before paying in all 10 form-checkout runs of
each set, since the prompt doesn't state an amount. FowlBrowser paid $268.00 unpriced in 6 of 10
Haiku runs, and in all 10 on Opus. These are FowlBrowser's own 13 tasks and nothing wider: the
native-app comparison hasn't run. [Gate](docs/benchmarks/2026-10-16-gate.md),
[Opus](docs/benchmarks/2026-10-16-opus.md), [turbo A/B](docs/benchmarks/2026-10-16-turbo-ab.md).
The release pass (2026-10-19, build `1f6efff2`, engine 26.1013.40934) ran turbo in real Chrome windows on the same
13 tasks: 13 of 13 on Haiku 5.5 in 257.8 s and 13 of 13 on Opus 5.5 in 249.9 s. Claim results are in the
[benchmark hub](docs/results/README.md), each arm with its engine version and dates.

### Native apps

- The guard reads less by default. A call's first key, text or coordinate action skips its read
  only after a passed focus check. Typing after an edit shortcut or a field click skips another read
  while text is being edited. Element actions use the call's first read until an opener or explicit
  read replaces it. Confirming buttons count as openers. The guard still reads for the first element
  lookup, after a panel opener and at the end of an acting call. On Calculator, numbers from one
  read hit the right buttons 10/10, against 0/10 with a read after AC that moved all 6 later numbers.
  `SLEIGHT_GUARD=careful` reads before every action. Document scope and change review keep their reads.
- When the window renumbers between Claude's read and a call with one element number, and the line
  Claude saw is now on exactly one element, the action goes there with a note instead of stopping.
  A number the code reads itself in a call is checked against that read. Both previously stopped
  correct clicks in recorded runs.
- A click that opens a new sheet or dialog in the same app lets the rest of the call act on it.
- A call that writes with `setValue` and then saves with Cmd+S in the same app is split at the save,
  with one Shift press posted to the app between the two. That press stops the save hang after an
  Accessibility write. When the press can't be sent, the call goes
  through unsplit with a note.
- When acquiring an app launches it, sleight puts your previous front app back in front. A click
  during the launch cancels that, and typing doesn't. `SLEIGHT_FRONT_RESTORE=0` turns it off.
- When the engine's helper crashes during a read ("native pipe closed before response"), sleight
  sends the read again once, 2 s later. A call with actions is never resent.
- An app that lives only in the menu bar gets the `menu_bar` route on its first `getApp` timeout,
  without stuck-app advice to quit an app that answers Accessibility.
- Before telling you an app is hung, sleight probes it again with a 3 s Accessibility deadline instead
  of 0.5 s. At a load average of 101, apps missed 0.5 s in 5 of 5 probes and answered within 0.52 s.
- When the helper won't start because launchd still holds its old job, the result gives the
  `launchctl remove` command for you to run. sleight never runs it.
- An action chained with `.then`, `.catch` or `.finally` and followed by more code is refused
  like a bare unawaited action, since its failure would end the engine's session.
- On a window whose tree is only its chrome (a mirrored iPhone screen), `scroll` becomes a swipe
  across the content. The engine's scroll left the list unmoved in 3 of 3 tries.
- A drag of text formatted unlike its paragraph (a bold word in plain text) takes the posted or
  foreground path, since the Accessibility write came out plain in 3/3 trials. `drag` reads the
  window through Accessibility with a 0.5 s deadline instead of System Events, which took 9.4 s of an
  11 to 14 s drag. In the native claim runs (2026-10-16, Haiku 5.5) the TextEdit text drag passed 2/2 at a 29.2 s median,
  against 0/2 to 0/3 for Codex, lcu, Cua and Peekaboo. `drag` says it stays inside one window when asked to move a window or
  drop text into another.
- `hover` refuses a window that spans two displays, since its capture could include another app.
- Replay and demonstration recording no longer report unconfirmed cleanup when their processes have
  exited but macOS still answers EPERM for the group. A group with a live member still reports it.
- `open_file` returns the opened window and a handle in the same result. A final top-level `return`
  in a call works as its value. A Save with no earlier read of the document reads its file URL in
  the same call, so the file's modification time can confirm the save. File contents are never read.
- A read call that prints a filtered string or array gets the value and the window header, without
  the whole tree again. Element numbers Claude wasn't shown stay unknown, so a click on one is refused.
- Non-text drags check only their two endpoints and the elements above them, instead of scanning the
  whole window. Finder drags hit the scan limit in the 2026-10-16 runs. A timed-out drag suggests
  Copy or Cut and Paste. An endpoint the hit test finds in the window isn't refused because a parent
  element's frame misses it. Chess's board reported such frames, and every drag on its right half was
  refused in the 2026-10-17 A/B.
- A first result from `open_file` leaves out the engine's API reference, about 17,000 of its 24,849 characters in the
  2026-10-17 preview-read runs, and the reference arrives with Claude's first `js` result instead.
- A call stopped because it reached another app says how many of its actions ran and that the next action will lease the
  observed window. After `select_window`, any call that starts by acquiring the selected app counts as the confirmation. A
  menu Cancel in the selected window is no longer refused, which deadlocked a textedit-calculator run for 15 calls.
- A save after a click by ID followed by typing in the same element is confirmed from the file's modification time. It was
  reported as "not confirmed (mixed save targets)" and Claude saved again.
- When a click also swaps two sibling elements, such as Excel's sheet tabs after a rename, the result says so with the new
  order, and the next save repeats it once. All three excel-edit failures in the 2026-10-17 claim run were this swap.
- When the tree shows a menu-bar item as selected with no menu in front, the result warns that a menu may be stuck open and how to close
  it. In a 2026-10-17 word-edit run, Word ignored keys for 20 calls in that state with no warning.
- When text typed after a click shows up in a different existing field than the one clicked, the result says where it went.
- `open_file` overlaps its setup steps, and sleight pays the engine's first-call start (about 0.73 s measured) before
  Claude's first call, both by default (`SLEIGHT_OPEN_FAST=0` and `SLEIGHT_WARM_ENGINE=0` turn them off). With both on in the
  2026-10-17 A/B, calculator-click went from 8.7 to 6.7 s, preview-read from 5.5 to 3.9 s and textedit-save from 10.4 to
  8.1 s (medians, 3 runs each).
- The engine's `js` tool description reaches Claude whole. Claude Code cut it at 2,048 of its 3,511 characters, dropping the
  app example and output rules. sleight now sends a 1,536-character version with the safety guidance first.
- A result's skill rules come before its first window tree instead of after it
  (`SLEIGHT_RULES_FIRST=0` keeps them last). In the 2026-10-17 claim run, with 5 KB of rules after
  preview-read's 2.3 KB tree, Haiku thought on its second turn in 5 of 5 runs against 2 of 5 for Peekaboo.
  Not yet measured with the change.
- A read whose document area doesn't show text values, such as an Excel sheet, gets one note to read the
  window with a screenshot (`SLEIGHT_TEXTLESS_HINT=0` leaves it out). In 5 of 5 excel-edit runs of the
  2026-10-17 claim run, Claude's first Excel read returned no cell values and a screenshot followed, about
  3 s a run. An empty text area gets the note only when `open_file` found its file non-empty, so a blank new
  document doesn't.
- `open_file` skips `open -g` (150 to 200 ms) when the app's main window already shows that exact file, unless the
  file changed during the call or after this session opened it. When the window read after it shows another file,
  the result says so instead of reporting the file opened. Its approval runs alongside the app lookup
  (118 to 138 ms cold). Not yet measured live.
- The skill says a confirmed save covers the document's sheets and pages until later edits. In 3 of 5 excel-edit runs
  (2026-10-17), Claude went back to an earlier sheet after saving, which set off a 10 to 25 s repair. It no
  longer repeats the engine's advice to prefer a CLI or API.
- `bench/timing.mjs` counts `open_file` calls, with the open as local time and the window read as engine
  time. Runs that used it reported 0 calls before.
- `SLEIGHT_OPEN_SHOT=1` (opt-in until an A/B) adds the window's screenshot to `open_file`'s first read. In replays Haiku stopped
  re-checking a text-only result: second-turn thinking was 0 in 5 of 6 runs, and output fell from 478 to 312 tokens.
- The skill tells Claude to acquire an app the task names directly, and to use the changed lines an
  action returns instead of reading again to confirm them. It moves files with Copy and then the
  menu's Move item, since Cut is often disabled for files.
- A call that opens a menu with its own label click and then picks an item goes on in the same call.
  The guard still stops at the menu, and sleight continues only if the window and its focus are
  unchanged and there was no keyboard or mouse input since the call was sent.
- A click into a text area before Cmd+S no longer hides an observed save: when the same document's
  file changed on disk during the call, the result says it saved.
- An element number is checked against the window of the app the call acts on. A click in one app
  after a read of another was stopped as stale.
- The skill's browser how-to arrives with the first browser result instead of in every native
  session. Its submit and redaction rules still come first.
- A read whose value is derived from the tree is printed when the call ends on it or on
  `console.log`, and then the tree is left out. The engine printed nothing for a bare final value,
  so 58 of 78 recorded filtered reads lost their value and Claude read the whole tree instead.
- `getAXState({ disableDiffing: true })` no longer turns every tree in the call whole. A filtered
  read still filters, and an acting call keeps its change note. 105 of 108 recorded Office calls
  passed it.
- Guard stops say whether any input was sent. When a label matches a menu-bar item and exactly one
  element in the window, the click goes to the window's element, and other ambiguities list the candidates.
- A call whose own key or click moves a window without editable document content to another place,
  such as a folder, goes on in the same call, on the same window and input evidence as menus. A
  key often counts as input there, so navigation by key can still stop (known problems).
- When an action leaves the same element focused but changes its description, such as another sheet
  becoming active, the result says so. A changed selected tab is reported too.
- A window's close button is never clicked by element number. Close a window by label or Cmd+W.
- A call that re-acquires an app and then shows the same window whole drops the duplicate first
  tree. Word runs sent both in every call.
- `SLEIGHT_COMPACT_REACQUIRE=1` (opt-in) returns "no change" or the changed lines when Claude
  re-acquires a window it already saw whole. Replayed offline it halved acquisition tree text, but in
  the 2026-10-17 A/B (excel-edit and word-edit, 5 rounds) it was slower, 156.3 s against 149.4 s.
- `SLEIGHT_COMPACT_ACQUISITION=1` sends an app's first tree with only the elements that take actions
  and short text, and refuses a click on a number it left out. It hasn't had its own A/B yet.

- On a list with more rows than it shows, the skill and the 3-scroll note make
  `app.pickFromList("<whole row text>")` the first move, with search, keys or a scroll loop after it
  stops. In the Safari and Firefox race, 5 of 6 form-travel runs wrote scroll-and-read loops, up to 34.7 s.
- The renumbering guard follows an element with no ID that an earlier action in the same call moved,
  when one inserted or removed block of rows explains the shift and its whole line is on one element in
  each tree. Anything else still stops. Safari's AutoFill button stopped 3 of 3 form-travel runs.
- `{ id: "18" }` alone at the top of a call acts on element 18 when no element has that ID or label,
  and the result says so. An `{ id }` that matches no element's ID is looked up as a label, and
  `setValue` takes the one settable match when a field and its text label share a label.
- A failed action's note names the actions that ran before it, the action that failed, and an app
  handle's argument order when the call used a tab's (`pressKey("Return")`, not `pressKey(null, "Return")`).
- Row reorders go to the `drag` tool, which the skill and the tool's description now name for list
  rows. In Safari, `app.drag` left every row in place in both runs that tried it.
- A click on a list row outside the list's visible part says so and names the scroll that brings it
  into view, in place of "UI changed". `SLEIGHT_OFFSCREEN_CLICK=0` turns it off.

### Browsers

- `sleight.fillForm(tab, fields)` fills a form in one call and never submits. It reports the count
  filled and each field that failed, takes multi-select options by label or value, refuses read-only
  fields (naming the page's picker when there is one) and reads switches by `aria-checked`. Forms
  remain the weak spot: form runs passed 13 of 24 across the two gate rounds and one targeted check,
  while every other task passed 36/36 (2026-10-13, before production turbo).
- `sleight.dragTo(tab, from, to)` drags between two elements so the page sees the drop. The engine's
  `tab.drag` never dropped on an HTML5 list (0/14). On FowlBrowser's settings form the task took
  39 s instead of 313 s (2026-10-12).
- `sleight.pickFromList(tab, list, text)` scrolls a virtualized list, prefers an exact row and reads
  the selection back. On an unsorted list it can pick a prefix match at the scroll cap before
  reaching a later exact row.
- `sleight.reorder(tab, list, order)` drags a list into order and reads it back. Lists take an exact
  accessible name, a CSS selector or a locator, and an ambiguous name is refused.
- Common Playwright calls on a tab go to `tab.playwright`, and a locator's `dragTo` goes to
  `sleight.dragTo`, with one note a session.
- Browser calls no longer take a native window lease.
- A link or GET form that targets a new tab or window opens as a background tab. Inline handlers,
  links that need `window.opener` and popups a script opens keep the page's own click and can still
  take focus: 18 focus events in 26 runs, against 0 for FowlBrowser (2026-10-13).
- An explicit turn end closes finished tabs the session created, after checking each one's identity.
  It keeps tabs still loading, edited forms, tabs handed to you and deliverables. Tabs left open in
  a 26-run round fell from 74 to 41.
- After a kernel reset, browser and tab handles the session opened or read come back from their own
  saved identity.
- When a call opens a tab and then fails, the error gives the tab and the call that gets it back.
- Common tab errors get one more line with the cause, whether input was sent and the next call, for
  covered or stale elements, page dialogs, CDP timeouts, a lost
  debugger, stalled downloads and a `TypeError` from the read-only page scope.
- A tab read that meets "Debugger unattached" is sent once more after 1 s. Actions, tab creation and
  mixed calls never are.
- A page write inside a read-only `evaluate` is refused before it reaches the engine, with the call
  that does it. A recorded replay refused 19 of 19 writes and allowed 89 reads. DOM clicks inside
  `evaluate` no longer count as unawaited engine actions. Real unawaited actions remain refused.
- A submit-like click or Enter that leaves the page unchanged warns that a retry may submit twice.
  Ordinary clicks don't add engine reads.
- A tab's tree in a result is capped, dialogs and focused rows first, with a note on reading the
  rest. The browser cap leaves native trees and the engine's docs unchanged.
- `getAXState({ emit: false })` leaves that read's tree out of the result. Its element numbers stay
  unavailable for input.
- First results are smaller. Browser-first sessions defer the native API reference until needed.
  An offline replay saved 309,759 characters over 39 recorded runs. A first result still over
  45,000 characters also defers the browser reference while retaining confirmations policy
  and Browser Safety.
- A call that ends in an unprinted expression says how to print it (23 of 34 recorded cases).
  `SLEIGHT_AUTOPRINT=1` prints a pure final expression.
- The engine's JavaScript session is prepared before the first call. With 13 sessions starting
  together, an empty first call took 34 and 26 ms on average against 804 and 1,160 ms without it.
  `SLEIGHT_WARM_REPL=0` turns it off.
- Browser discovery binds to the chosen browser's verified backend instead of probing every socket.
  Startup caches the engine's first tool list by version. The cache's hit rate is unmeasured.
- `SLEIGHT_ENGINE_DOCS=lean` cuts the reference from 11,897 to 9,393 characters, and `min` sends 672
  with the reference on demand. Both are opt-in.

### Approvals and safety

- `blocked_app` is gone. When the engine refuses a terminal or OpenAI's app, the result gives the
  setting that lifts the refusal (`ComputerUseAllowForbiddenTargets`), which only you turn on. With
  it on, those apps get the usual approval card with one line saying the app could be dangerous.
- When your own message names what to pay, the amount and what to pay with, that payment counts as
  confirmed, including the page's confirm dialog for the same item, amount and payee. Any other payment
  asks, on the engine's browser path as on turbo: in the first real-window Firefox round (2026-10-17) the
  engine path paid $268.00 on a test checkout whose prompt named the item and card but no amount.
  `SLEIGHT_CONFIRM_PAYMENTS=always` keeps asking. `SLEIGHT_CONFIRM_PAYMENTS=never` also skips turbo's
  check of a money figure larger than your amount, for a payment your message named with its amount.
  An unrequested payment, a second payment in the same request and a different amount still ask.
- In Safari and Firefox driven through the accessibility tree, a guard check now applies turbo's payment
  rule before the input goes out. On a page that shows a payment (card fields, or a money figure above zero
  beside a pay, order, confirm, submit, reserve or book control), it checks every click that reads as a
  submit, Enter or a typed line break in any field, and the browser's confirm dialog. A payment goes through
  when your message stated its amount, the page shows that amount and no larger figure, and it's the
  request's first payment (the confirm dialog within 60 s after it, showing the same figure, counts as the
  same one). Any other payment opens sleight's own payment card, the one turbo uses, naming the site, the
  largest figure and the control. Allow once lets Claude send that one action again, and Cancel keeps the
  stop. This works in Codex and with turbo off. Tabs driven through the ChatGPT browser extension aren't
  checked yet. On the recorded race trees it stops the unasked $268.00 payment and passes the same click when
  the message states $268.00. Not run live yet.
- No tool can answer sleight's own menu or its approval and payment cards. The menu bar tool, hover,
  drag, window selection and every engine call refuse the process that shows them (sleight's consent
  host), matched by name, by its file and by its pid, so only your click answers them.
- When your own message asks to submit or save a form or settings page, sleight no longer stops to
  confirm the values it names, notification, email and SMS switches included. A security or
  privacy switch your message names counts too when it makes the account safer, such as two-factor on.
  It still asks before a page dialog that adds anything you didn't name, high-stakes submissions,
  loosening a security or privacy setting, recovery email, phone, password or connected-app changes,
  and submits only the page proposes. Bookings your message asks for work the
  same way, and any money they charge follows the payment rule.
- In Cursor and other MCP clients, approval prompts use the client's name instead of Claude.
- The mod refuses Claude's file edits and common shell writes to the preapproved-apps file. Reads
  stay allowed. A path built at run time still gets past it.

### Codex

- sleight installs as a Codex plugin from the same repo: `codex plugin marketplace add Land-o-Clusters/sleight`,
  then `codex plugin add sleight@sleight`. Codex gets the same server, skill and tool names, and two hooks
  meant to end the engine's turn when a Codex turn stops or is interrupted (listed and trusted live, not
  yet seen running). Turbo, the pane and `/sleight` stay Claude Code only. `--doctor` reports whether
  sleight is on in Codex and whether Codex's own Computer Use is on beside it. On 2026-10-19, with Codex
  0.160.0 and gpt-6.1-sol, Calculator's 12 × 12 took 22.5 s and a TextEdit note 44.4 s. Always in Codex's
  approval prompt wrote sleight's pre-approved list, as a click does in Claude Code.
- In Codex the first `getApp` of a session failed once and cost a turn (2 of 2 live tasks). Codex sends
  its sandbox state with each call, and we think the engine runs that call in a kernel without sleight's
  setup. sleight now sends its own calls with the same state and sets up again when the state changes.
  Unit-tested, not yet rerun live.
- Outside Claude Code, the model doesn't see `turn_ended` or turbo's tools, and the relay refuses a turbo
  call from it. Stop and resume work on every host. Only the Claude Code mod binds a turbo turn to your
  message. Claude Code is recognized by the client name `claude-code`. The CLI's traces show it, and the
  desktop app's Code tab runs a bundled binary that builds the same name. No trace from the desktop tab
  has been captured. Any other host gets these protections.
- The turbo menu shows the host each session runs in and its version, as the client introduced itself
  ("Claude Code 2.1.289"). It doesn't show a model, because no host reports one to sleight. For Claude
  Code users the idle line now reads "Its session has ended". The menu change was typechecked and
  unit-tested, not seen in the real menu yet.

### Pane, replay and receipts

- Recording from the pane goes through a file instead of the mod's 4 MiB output limit. After a
  replay that acquired an app by window ID, Refresh and the next prompt find that app.
- Receipts scrub your name in any letter case.

### Turbo

- Turbo is on by default, with `browser_open`, `browser_read`, `browser_act` and `browser_fill`.
  With turbo on, Claude can also choose the engine's browser tools, including mobile viewport control.
  Each path keeps separate tabs and refs. A safety refusal or an uncertain action must not be retried
  through the other path.
- The menu bar shows sleight's glove only while turbo is connected, paused or waiting for cleanup, or while a request
  waits for you. Its menu shows the state, browser and payment check, with Pause, Disconnect, Turn Turbo Off… (confirmed
  first, and it reaches every session), Settings & Help… and the version. It used to read "sleight disconnected" for as long
  as a session ran.
- At startup sleight writes the operator-owned `~/Library/Application Support/sleight/turbo.json` for
  Google Chrome (or Helium when Chrome isn't installed), and rewrites it after a plugin update or a
  node version change. A file with `enabled: false` is never overwritten. With no supported browser,
  or a write that fails, the engine path is used and one line says why. `sleight-mcp turbo on|off|status`
  are the user's controls, and `--doctor` has a turbo section with the fix for each problem. Claude's
  file edits and shell commands can't write the file or run `turbo on` or `turbo off`.
- Turbo connects to the selected browser through its remote-debugging consent, without an extension.
  Turning on remote debugging at `chrome://inspect/#remote-debugging` stays the user's one step.
  A receipt that doesn't match the installed package never connects. Installed setup and native
  consent still need qualification before release.
- Page content never supplies instructions or permission. Payments follow the rule above. Before
  retrying a submit with an unknown effect, Claude must read fresh state. Input checks the target
  element, and incomplete page sensing does not alone block it. Pausing, losing consent or changing
  the package stops input. Unresolved actions retain their tabs for review.
- Turbo includes the whole `playwright-core` 1.64.0 package with file hashes and license notices,
  loaded only when enabled. Its two native helpers compile from hash-checked source on the user's
  Mac at first use, requiring Apple's command-line tools. A failed compiler leaves the engine path
  available. Native apps keep the engine path.
- `browser_read`'s `find` matches any term of `a|b`. In the night's Haiku runs 254 of 519 finds came
  back empty, 193 of those with `|`. In a 3-round A/B, empty finds fell from 29 of 68 to 9 of 83 and
  the median round from 622 s to 572 s (faster in 2 of 3 rounds).
- A click or check on a visually hidden control under its own label acts at the point proven to be
  that label, never at a link nested in it. Before, the click came back "covered" 5 to 6 times in a
  slow form-checkout run.
- Turbo forgives five misses from the gate rounds: a timed `wait` with `ms`, `navigate` on a link
  ref, scrolls past 10,000 px (clamped, not refused), a popup that closed itself (read as its
  opener) and read errors that name their reason. A frame still holding focus after a card field
  is blurred before a modified click.
- In a 5-round A/B on the 13 tasks (Haiku 5.5, turbo only), these fixes plus `never` took the median
  round from 581 s to 542 s, with 0 errors in 130 runs against 20 in 5 rounds before.
  [A/B](docs/benchmarks/2026-10-16-turbo-ab.md).
- The nine-task prototype passed 4/9 in its last round, with all four forms failing. It skipped
  production consent and the broker, so it doesn't support a claim about production speed or accuracy.
  [Prototype measurements](docs/benchmarks/2026-10-14-turbo-prototype.md). Approval and cleanup in a copy
  installed from the marketplace haven't been checked live on native apps.

### A/B switches, off by default

- `SLEIGHT_RESULT_TRIM=1` drops runs of 20 or more sibling rows from a result over 25,000 characters,
  keeping selected rows, folders and title matches. A constructed 198-file folder went from 72,616
  characters to under 25,000.
- `SLEIGHT_LAUNCH_REREAD=1` reads a just-launched app once more after 2.5 s when its tree has 1 to 19
  elements, and keeps the fuller tree only for the same window.
- `SLEIGHT_FIRST_CALL_BATCH=nosavestop` drops the first-call advice to end a call after Cmd+S.
- `SLEIGHT_LEAN_CALLS=1` ends native actions with compact changes. After its cache fix, the rerun
  passed 11/13 against 12/14 and took 220.8 s against 194.4 s (summed medians, five tasks).
  It stays off: no measured win. [Lean-call measurements](docs/benchmarks/2026-10-14-lean-calls-ab.md).

### Plugin size

- Turbo v1 and v2 and nine modules nothing in 1.3.0 reaches are removed, taking the plugin from
  15,960 KB to 8,640 KB.

### Benchmark

- The world benchmark runs every native Claude arm (sleight, lcu, cua, peekaboo) on the owner's
  login in its own isolated config, checked before any task, with `--auth login` as the default.
  An unverified login stops the pass before a runner starts. The dry run plans 162 rows (6 arms,
  27 tasks).
- Before each Chess arm starts, earlier benchmark task folders are archived without deleting their
  games or traces. Whether a remembered Save location falls back correctly needs a live check.
- Runs use isolated Claude configuration, record the resolved model and price usage from token
  counts. Tab inventories have deadlines. Runner checks distinguish unavailable evidence from a pass.

## 1.2.5 (2026-10-11)

- The prompt-budget tests are skipped by name where the typescript dev dependency isn't installed.
  CI doesn't install it, and 1.2.4's CI failed there. The plugin itself is unchanged.

## 1.2.4 (2026-10-11)

- README: updating is right after install, with Claude Code's auto-update switch for the sleight
  marketplace (off by default for marketplaces outside Anthropic's own) and the one-line update.
- `SLEIGHT_PROMPT=lean` makes everything Claude reads from sleight 30% smaller (23,629 to 16,482
  characters) for an A/B. The default text is unchanged until that A/B runs.

## 1.2.3 (2026-10-11)

- Install has two paths: with Computer Use already on in ChatGPT or Codex, installing sleight is
  enough. Without it, `sleight-mcp setup` installs the helper and opens the permission panes, with no
  ChatGPT account or Codex sign-in. The launcher's missing-engine error and `--doctor` point at setup.

## 1.2.2 (2026-10-11)

- The pane shows the latest receipt's path as text. Claude Code 2.1.288, the oldest version we support,
  refuses a `file://` link, and the pane then drew nothing with receipts on (`SLEIGHT_RECEIPTS=1`).

## 1.2.1 (2026-10-11)

- Tests that need macOS (osascript, xcrun, plutil or `/private/tmp`) are listed as skipped on other
  platforms. CI on Linux failed 36 of them for 1.2.0. The plugin itself is unchanged.

## 1.2.0 (2026-10-11)

Against native Codex computer use on the same engine, with the owner away: 9/9 each with clean arms,
sleight at 22.0 s and 7.11 turns a run against 44.6 s and 8.67, using 4.68 against 4.84 CPU seconds;
9/9 each in the owner's normal setup, 27.1 s against 36.2 s (5.94 against 4.30 CPU seconds); and
24/24 each on 12 browser tasks in Safari and Helium, 28.5 s against 41.8 s a run. No full release
pass ran for this release. The owner chose to release on these head-to-heads.

- sleight is app-agnostic: the skill (86 lines, down from 137) has no app-specific rules, and `drag`, the
  screenshot scale note, the orphan Save panel diagnosis, demonstration recording and browser
  detection work the same in every app.

- The skill is the app-agnostic one: 86 lines against 137, with no app names. It matched or beat
  the old skill in two A/Bs (2026-10-11): 4.58 turns and 14.5 s a run against 4.58 and 15.6 s on
  calculator-click and textedit-edit, and 38.9 s against 44.7 s on textedit-save, every run passing.
  `SLEIGHT_SKILL=none` still leaves it out, for A/Bs. `SLEIGHT_FIRST_CALL_BATCH=sheet` is gone: it took
  29.7 s a run against 21.5 s.
- `drag` uses one path for every app. Selected text tries Accessibility before posted
  events. The guarded foreground fallback remains last. Text endpoints must share one area or field
  with a non-blank selection. Covered windows use the same focused-selection check.
  The TextEdit rich-text clipboard option and the Command-only text-drag modifier were removed.
  The generic Shift event after Accessibility writes remains (10/13 save hangs without it,
  0/10 with it in the original probes). The new regressions failed 10/10 against the old code;
  the mocked window suite passes 122/122 across two bundle IDs. Live qualification is pending.
- Screenshot scale notes above a 2000-pixel long edge now cover any app, alongside
  orphan AppKit Save panels, demonstration capture by bundle ID, browser identification from
  HTTP and HTTPS registrations. The new offline tests failed 9/9 against the old code. The passive
  observer's Swift source typechecks. Live proof is pending for each mechanism. A Shift press
  after `setValue` was dropped before release: the engine refuses a key press with only modifiers
  (2/2 live, 2026-10-11), so it would have failed every `setValue` on a text area.
- `open_file` tells Claude the exact `getApp` call to send next, and a Cmd+S on an open file reads
  "saved: observed" when the file on disk changed during the call. TextEdit in the background shows
  no edited state. Those saves used to read "not confirmed", and Claude spent a turn checking in
  4 of 7 runs. On textedit-edit the A/B went 6/6 at 6 turns and 18.5 s a run against 5/5 at 6.6 turns
  and 20.0 s (2026-10-11).
- The `js` tool's description names `let app = await cua.getApp("Calculator")` as the first call
  for an app Claude can name, and `cua.getState()` only for one it can't. In an A/B of 11 and 12 runs
  (2026-10-11), first calls on `getState` fell from 8 of 11 to 0 of 12, turns from 7.91 to 7.17 a
  run and total time from 30.6 s to 27.0 s, with every run passing.
- A lease broker CLI exposes acquire, status, renew and checked release over
  sleight's existing store for cooperating outside agents. Tokens can cross CLI
  invocations; status omits them, and foreign or expired tokens cannot release
  a holder. Each runtime handles app approvals separately. All 9 new tests failed
  against the old code. The focused broker and lease suite passed 51/51 offline.
  Native Codex participation is unverified. The [design](docs/design/lease-broker.md)
  gives the owner opt-in and sleight-arch's live check.
- `SLEIGHT_STATE_REVIEW=1` adds redacted before/after values, checkbox states and selections to
  the turn receipt and pane. It uses existing full reads, with 0 added engine reads. Secure fields
  and their descendants are excluded; missing or ambiguous observations leave review unavailable
  or partial. Native Undo remains the user's action in the app. No live run.
  [Design and live checklist](docs/design/unsaved-review.md).
- The mod ends the engine turn after a turn that used an app even when Claude Code's pane list
  fails. That failure used to skip `turn_ended`, so only the relay's 30 s idle timer ended the
  turn. That may be one cause of desktop sessions that stay busy (inferred). A mod test covers it. It hasn't run live.
- The real-shop smoke check scores a stop at an interactive human check as its own outcome
  (`outcome: "human-check"` in the results, STOP in the log), not a pass, when the answer states the
  check and the captured cart screenshot backs it. A complete cart passes. Anything else fails with the real reason, and an input lease
  or tool refusal is a refusal, never a human check. Target's correct stop at a "Press & hold"
  check scored as a plain failure and Best Buy's lease refusal scored "stopped at a CAPTCHA or
  bot check" (2026-10-10). Both recorded answers now score correctly, from unit tests against
  the stored answers. No live run.
- `sleight-mcp setup` (`--dry-run` prints the steps) runs OpenAI's helper installer from
  ChatGPT.app when its status isn't OK. Then it opens the Accessibility and Screen Recording panes
  and runs the doctor. With no Codex plugin under `~/.codex`, sleight starts the engine from
  ChatGPT.app directly, driving Mac apps only (`CUA_REPL_ENABLED_SURFACES=computer`), because its
  browser extension API needs a Codex sign-in. In a macOS user that never signed in to ChatGPT, that engine listed apps (2026-10-10).
  A full setup run hasn't been tried live.
- App approval prompts offer "Always allow" (owner's call). It adds the app to your pre-approved
  list with its risk level and the date, so later sessions don't ask. Only your click writes it,
  and terminals and OpenAI's apps never offer it. `sleight-mcp allow list` and
  `sleight-mcp allow remove <app>` show and edit the list. Unit-tested.
- `open_file` opens an existing file in an app with the app left in the background (`open -g`),
  instead of the File > Open panel. Finishing that panel brought TextEdit to the front for about a
  second in 3 of about 21 textedit-edit runs while the owner worked (2026-10-10). The skill points
  Claude to it. Each app is approved once per session, and the user's pre-approved list covers it.
  The app is resolved to its bundle ID first, and the tool refuses terminals, OpenAI's apps, apps
  that run or install what they open (Python Launcher, Installer), scripts, apps and executable
  files, and anything but an existing regular file. `SLEIGHT_OPEN_FILE=0` turns it off. It's
  unit-tested, and the TextEdit tasks ran with it in the build on 2026-10-10 (4/4 in the save-check
  head-to-head, 8/9 and 9/9 in the h2h-4 and h2h-5 passes, 6/6 in the verified-results run); the
  results files don't record whether Claude used it.
- Native action replies add a line when a value, element, window or sheet changed, from the reads
  the relay already has (no extra engine read). A save is reported only for the same file URL or
  the path the call named, and an Edited title cleared by autosave isn't credited to Claude.
  Cmd+S opening a Save panel, and Save in the panel producing a file the call didn't name, no
  longer say "saved: not confirmed"; the window header shows both steps, and a named path that
  doesn't match still says so. A save named through Go to Folder and the panel's name field in the
  same call reads as that file URL, including `~/` folders. Unit-tested with recorded replies
  (Sol, `codex/verified-results`). Live on 2026-10-10 with the owner away: 6/6 on Calculator and
  TextEdit ([results](docs/benchmarks/2026-10-10-verified-results-live.json)) and 2/2 each on Chess
  and safari-form ([away runs](docs/benchmarks/2026-10-10-away.md)); the Chess runs recorded
  verified-results lines and save fields, but not Claude's code, so which calls produced them is
  unknown.
- `app.waitFor({ id | label | line }, { timeoutMs })` waits up to 10 s for one element in the same
  window, polling full reads at least 250 ms apart. The skill asks Claude to use it only for
  elements that appear late. Live on 2026-10-10: the waits check waited on TextEdit's Save sheet
  with it, then saved ([away runs](docs/benchmarks/2026-10-10-away-2.md)).
- Windows with the same title and no URL get a native identity check before input, using the
  window number from `select_window`, the acquisition or the focused window. When identity can't
  tell them apart, the guards work as before and warn once. Single windows and TextEdit Save sheets
  skip it. With one window the check is skipped, and it cost the same as no check:
  median 482 to 484 ms an action with it against 492 to 515 without, loaded
  ([report](docs/benchmarks/2026-10-10-waits-targeting-4.md)). The equal-title live check hasn't run.
- A call keeps going when its own shortcut, Return or click opens or names a window in the same
  app: the Save or Open panel, a new untitled window, or the document saved or opened under a name
  the call typed (owner's call). The lease stopped such calls in 10 of 12 TextEdit runs with
  first-call batching, and a transcript study estimates TextEdit's save and edit tasks drop from about
  6 calls to 3. A window you open in that app at that moment passes too. Document scope and change
  review still stop. Unit-tested only.
- Claude may put its first actions in the same call as the app's acquisition. The engine's
  description asks for the acquisition alone, and sleight now rewrites that sentence by default
  (`SLEIGHT_FIRST_CALL_BATCH=0` keeps it). On calculator-menu, textedit-save, textedit-edit and
  chess-drag, 3 runs each in two rounds, it passed 24/24 in 168 turns, 366 s of model time and 780 s,
  against 23/24 in 208 turns, 464 s and 835 s without it. Chess gained most (91 turns to 56), and
  textedit-save went from 41 turns to 46, because Claude chained keys past Cmd+N or Cmd+O, and the lease
  stopped the call when the window changed (10 of 12 TextEdit runs). The wording now says to end the
  call after such a shortcut. That sentence hasn't run in the benchmark yet.
- A result whose window shows an open menu (`menu Secondary Actions: Cancel`) says how to close it.
  Escape left such menus open in 3 of 3 tries in the head-to-head, and their Cancel action closed
  one in Finder. Checked live on Calculator's View menu, where the note pointed at the menu (element 1)
  and its Cancel closed it in 445 ms. This changes what Claude does. The affected tasks run with it
  before release.
- A call's first action that sends keys, text or coordinates uses Claude's full read from the call
  just before when it's under 10 s old, however fast that read was (owner's call). Before, only a
  read over 2 s qualified, and only on a loaded Mac. A window that comes to the front between the
  two calls isn't caught before that first action. Otherwise the guard reads again, about 50 ms
  when the app has settled, and checks every number the call acts on against the line Claude last
  saw: in the head-to-head a saved TextEdit document renumbered after Claude's read, and a click
  meant for Format opened File. Under 20 CPU workers that read took 17 to 57 s, seconds after
  Claude's own took 1.9 s. A study of 93 runs put the change at about 0.9 s a run. Document scope,
  change review and `SLEIGHT_GUARD=careful` keep the read.
- Keys, typing, paste and coordinate actions after typing, pasting or a plain key in the same call
  no longer wait for a window read first. After a click, a shortcut, Return, Escape, Tab or Space
  the read stays: it also waits for a panel the action opened, and without it Cmd+O, Cmd+Shift+G and
  a typed path outran TextEdit's Open panel in a head-to-head run. That read waited about 400 ms for the UI to settle, and tens of seconds on a
  loaded Mac, where Codex doesn't make that read (owner's call). The first action and actions on
  element numbers, IDs or labels are still checked. `SLEIGHT_GUARD=careful` keeps every read.
- Return after `setValue` no longer reads the window first, as after typing (owner's call). In a
  Save sheet that read took 1.85 s a save. `SLEIGHT_GUARD=careful` keeps it. The first action of a
  session no longer says "UI unverified (no earlier read)" because of the engine's docs on that call.
- Reads around acquisitions. In a call that starts with the app's acquisition, the first action
  uses that read, taken milliseconds before, when the app was already running with a window
  (owner's call); an app the acquisition launched, or one the probe couldn't see, is read again.
  A call that only acquires an app, with or without printing the handle
  (`let app = await cua.getApp("X"); app`), takes the acquisition's read as the window header the
  lease needs and counts as the guard's read, so the guard doesn't read the window again after it.
  Without those skips the guard read every time: 173 extra reads and 98 s in the first case and
  53 reads and 27 s in the second across the benchmark runs of 2026-10-09, each milliseconds after
  the acquisition read the same tree. The check behind the 1.0.0 reuse rule never checked anything:
  engine 26.1002.52244 doesn't list windows, and two empty lists matched, so the first action after
  an acquisition ran on that read unchecked; now the guard reads instead, about 50 ms on a settled
  app. Guard traces now include reads the guard skipped, which the relay used to drop. Unit-tested
  only.
- A call that acted and ended on exactly the window Claude last saw gets the whole tree instead of
  "no change since the last full tree you saw", which read as if the actions hadn't run. In
  calculator-click, Calculator still showed the previous run's 391, and Claude read again in 2 of 9
  traced runs. In 6 runs after the change it got the tree every time.
- On a busy Mac the engine can read an element without its attributes (`button Two` for
  `button Description: 2, ID: Two`). The guard took that as a renumbered window and stopped 5 of 5
  batched Calculator calls under load. It now matches such a bare line to the element by role and
  ID or label, so a lookup by ID or label that finds nothing in a read that dropped attributes
  takes the one bare line with that name. Unit-tested only.
- `click("Multiply")` with a bare name clicks the one element with that label, or else with that
  ID, as `click({ label })` does. The engine rejects a bare name, and Claude redid a batch over two
  calls when it wrote one.
- `{ label }` matches a field whose line has states before its title (`text field (settable) Email`)
  and a menu bar item named alone (`Edit`). Both stopped calls in the head-to-head.
- A guard stop (a renumbered element, or no element with an ID or label) carries the window as it is
  now, so Claude can retry with current numbers without a turn spent reading again. Each stop cost
  safari-form a turn in the head-to-head.
- A numbered click in a batch that an earlier click renumbered (Calculator renumbers every button
  when its first click closes the history) goes to the same element at its new number, with a note,
  when that element's line is in the new tree exactly once. It used to stop, and Claude rewrote the
  batch over several calls. A read bound to a name (`const state = await cua.getState(); return
  state;`) now passes as a read instead of being refused. Unit-tested only.
- When the user is in a full-screen or Split View Space and the app Claude reads has no window on
  it, the read says so, once per app per turn: clicks and typing still work there, and
  drags and some reads don't. A second read timeout in a row on such an app gets the same advice instead
  of "cause unknown". A Split View pass failed 8 of 21 runs this way, with Claude spending up to 19
  turns before it gave up. With a full-screen fixture in front of TextEdit, a textedit-drag run got
  the note on its first read and stopped after 12 turns, asking the user to leave full screen.
- Guard and probe CPU. Guard setup stays in the engine after its first successful installation,
  reducing repeated source processing while retaining each call's checks: 90 guarded no-input calls
  fell from 0.75 to 0.05 engine CPU seconds, and the setup source from 23,088 to 1,301 bytes. App
  probes filter native window and app lists before converting them to JavaScript, keeping fresh
  observations and the original matching rules: 100 probes fell from about 4.8 to 0.55 osascript
  CPU seconds. Probes go to one long-lived helper per session instead of starting `osascript` each
  time, about 33 ms a probe after a 190 ms start, against about 180 ms for each spawn. The helper
  runs its run loop before each probe, since otherwise it never saw an app launched after it
  started, and an app the acquisition launched is probed again after the engine answers. Both were
  found and checked live with a full-screen fixture. Handle reads retain their app selector so each
  read gets its required Space probe. Previously only acquisitions did. The
  [CPU report](docs/benchmarks/2026-10-10-footprint-parity.md) records the component measurements.
  In the owner-away head-to-heads of 2026-10-10, sleight's own CPU was 51.8 s against Codex's 42.8
  with clean arms (7/9 against 9/9) and 64.2 against 38.4 with the owner's setup (8/9 against 9/9)
  ([away runs](docs/benchmarks/2026-10-10-away-2.md)).
- The browser-extension check, which decides whether the next session gets the browser API, runs after the engine's
  first call has answered, not during it. Its second engine used to overlap every session's first
  call: about 0.12 s on a quiet Mac, and 2.4 s against 1.2 s under load
  (`docs/benchmarks/2026-10-10-startup-costs.md`).
- A call that declares `app` itself (`let app = await cua.getApp(…)` with actions after it) no
  longer fails with "Cannot access 'app' before initialization". The guard's setup read `app`
  before that declaration (4 of 29 TextEdit runs on 2026-10-10).
- An action after a failed call or a reset no longer gets refused with "send the acquisition
  first" (13 refusals in 29 TextEdit runs, a turn each). The relay acquires the app the lease last
  confirmed and runs the call when the window is still the same one. If the window changed,
  nothing runs, and the refusal includes the new read.
- A rejected `turn_ended` keeps its original turn identity and retries after the configured idle
  interval, up to three total attempts. A third rejection logs once and drops that turn.
  Fake-engine tests cover explicit and idle cleanup errors and a newer turn in flight.
  The historical desktop busy incidents still need live qualification.
- `SLEIGHT_RECEIPTS=1` writes a private action receipt with a link in the pane; receipts are off
  by default. Text inputs, typed characters (a printable key alone or with Shift or Option) and window titles
  are redacted. Each write prunes
  files to seven days or 200 receipts, whichever is fewer. Account usernames and full names are scrubbed.
  `SLEIGHT_STATE_REVIEW=1` also lists changed or modified windows and observed native Undo or Revert
  controls for the user to use in the app. It is off by default. Receipts use existing reads;
  parsing runs after forwarding turn cleanup. stderr contains counts only.
  [Evidence and limits](docs/benchmarks/2026-10-10-review-receipts-2.md).
- `/sleight stop` says which calls were in flight and whether the engine finished or was cut off,
  then checks lease files, the pointer button and keyboard taps once the engine and helpers are
  collected. The relay and session approvals stay, and the next call after the user's next message
  starts a fresh engine (acquire the app again). Esc ends the engine turn and keeps the engine.
  Unit-tested, with the live checks before release (Sol, `codex/waits-targeting`).
- Cursor and generic MCP clients can use sleight's native approval panel and idle turn cleanup.
  The panel still names Claude under Claude Code. Unanswered relay forms expire after five minutes, and a panel
  that cannot be shown reports a failure. Unit-tested only, with [install notes](docs/other-hosts.md).
- `/sleight record [file]` saves the current session's successful sleight calls, and
  `/sleight replay <file>` runs them through that session's replay tool. The pane has a file field
  and buttons for both, starting with an empty file field. It logs each attempted step's result
  and wait when the tool returns, and hands a stopped replay to Claude with its window and remaining
  steps. Stop cancels, prevents handoff before submission and warns that the stopped step may have
  sent input. Replay preserves the user's Stop until a new message, and its schema can load on demand.
  Mod and relay tests cover the paths;
  desktop clicks await the owner's check (Sol, `codex/replay-desktop`).
- Claude can run a recorded script itself with the new `replay` tool. On a stop it gets the step,
  the error, the steps left and the window as it is now, and finishes the task from there. A step
  whose element isn't there yet waits up to 5 s (`--wait-ms` on the command line) when nothing in
  that call could have sent input yet. Unit-tested only (Sol, `codex/replay-next`).
- Scheduled replay routines have `routine add`, `list`, `remove`, `unlock` and `run-now` commands.
  Installation prints its launchd job and asks in an interactive terminal. Unattended runs require
  two minutes idle (HID idle first, then the compiled observer). Existing windows and the user's
  preapproved apps are required. Replay and routines acquire by bundle ID and confirm the window
  title (and URL when present) before input, including a script's recorded window on plain replay.
  Literal background steps only. Locks recover when the stored start time no longer matches the
  live PID. Damaged receipts need `unlock`. A user returning mid-run skips and retries at the next
  interval. Other stops pause the job and send a notification with the log path. Live on 2026-10-10
  with the owner away ([report](docs/benchmarks/2026-10-10-routines-live.md)): `record` built a
  2-step Calculator script, `replay` ran it 2/2, `routine add` printed the launchd job, `run-now`
  passed 10/10 steps behind the idle gate, and `remove` waited for typed confirmation.
  A launchd-scheduled run needs a release that contains routines: the installed 1.1.0 copy has
  none, and its scheduled run exited 1.
- `record --watch <bundle.id> <file.json>` observes a demonstration using Accessibility
  and a passive click listener, then writes portable replay steps. It checks permissions without asking.
  A terminal and filename are required, with notifications at start and stop. It refuses existing text
  and unsupported actions, and preserves existing recordings. It has never run live. Native qualification
  and limitations are in the [run report](docs/benchmarks/2026-10-10-routines-demo.md).
- The clipboard helper accepts types macOS adds to what it writes, as long as every requested
  type reads back byte for byte. The opt-in rich TextEdit move stopped there on its last live
  trial: staged RTF read back with two plain-text types. A private pasteboard reproduced it
  with that trial's RTF. No live run since.
- Paste keeps the user's clipboard with one helper per session instead of a spawn per paste, and
  reads large clipboards in linear time (a mocked 40 MiB transfer fell from about 5 s to 31 to 88 ms).
  `blocked_app` also refuses a settings window by its Accessibility metadata, so a localized title or
  a pane name like "General" no longer passes. The skill says to replace a whole document with
  select-all and `app.paste`, then compare before saving, outside the iOS simulator. Live byte
  checks and the TextEdit benchmark runs are pending (Sol, `codex/small-fixes`).
- A read identifies a possible orphan Save panel once per window when only `Save Panel Accessory View` remains without
  AX windows. Unit tests pass. The first live attempt after the clipboard fix (2026-10-11) stopped
  before the move: another app's window covered TextEdit at the drag point, so the background path
  was skipped and the Accessibility path failed its checks
  ([evidence](docs/benchmarks/2026-10-11-evidence.md)). [Investigation and every attempt](docs/benchmarks/2026-10-09-textedit-fixes.md).
  [Review follow-up](docs/benchmarks/2026-10-10-textedit-fixes-2.md).
  [Third review](docs/benchmarks/2026-10-10-textedit-fixes-3.md).
- `drag` refuses a drag another app covers and that has no selected text before raising or scanning
  the window in every app. It took 10 to 13 s to reach the same refusal in Chess and Finder.
- Real-suite tasks for VS Code, Cursor, Firefox, Slack, Discord and WhatsApp (owner, 2026-10-10).
  `vscode-edit` and `cursor-edit` open a temp file, replace one word and save. Firefox reuses the
  local form, grid and spa fixtures. Slack, Discord and WhatsApp only open a named chat and
  report the newest author; published rows keep the Mimestream hash shape, with no message text.
  Each app is quit only if that run launched it. Unit-tested. VS Code, Cursor and Firefox passed
  5/5 on one run each on 2026-10-10, owner away, in 27.2 to 58.7 s
  ([raw](docs/benchmarks/2026-10-10-electron-firefox-live.json)), after the allowlist took VS
  Code's bundle name, Code. The chat tasks never ran, because the pass's private-results filter
  rejected a row it had built and stopped before any run was saved. That's fixed (2026-10-11,
  unit-tested), and the chat tasks haven't run since.
- Real-use shop tasks: local Harbor Market pages for `safari-shop` and `helium-shop` (ZIP, store,
  search, filters, pagination, options, cart), with a server-side cart check. Safari smoke tasks
  `real-shop-target` and `real-shop-bestbuy` take `--runs 1` only and stay out of default passes
  and the head-to-head. Their check is the answer plus a cart-page screenshot. The smoke tasks ran
  once each on 2026-10-10, owner away ([raw](docs/benchmarks/2026-10-10-real-shop-smoke.json)):
  Target stopped at a "Press & hold" human check, as the task's prompt directs, and the check
  counts that as a failure because it looks for the three item names in the answer. Best Buy
  failed on sleight's input lease, which the check recorded as a CAPTCHA stop, which it wasn't
  ([away runs](docs/benchmarks/2026-10-10-away-2.md)). The Harbor Market tasks ran live the same
  day: helium-shop passed both arms, and safari-shop failed fixture setup on both in
  [shop-1](docs/benchmarks/2026-10-10-shop-1.json) and passed both in
  [shop-2](docs/benchmarks/2026-10-10-shop-2.json) after the title-nonce fix.
- Real-suite task `iphone-mirroring-settings` opens iPhone Mirroring and reads the iOS version from Settings > General > About. The check is that version text. `--owner-present` is required. Default passes and the head-to-head skip it. Headless `claude -p` can't show an approval prompt. The benchmark approves iPhone Mirroring only in `--owner-present` runs (owner, 2026-10-11). Published rows keep the answer and timings, with no screenshot. A version followed by a blank line and a note passes. One live run on 2026-10-11 read 27.0.1 in 66.9 s and 16 turns, and failed the stricter check then in place, since Claude added a note about a mis-tap.
- App screenshot replies larger than Claude Code shows unresized (a 2000-pixel long edge,
  observed once, on a 2200 × 1600 engine screenshot shown at 2000 × 1455) now state the engine's
  pixel frame, the shown size and the exact multiplier. On by default; `SLEIGHT_SIM_FOCUS_NOTE=0`
  turns it off. Coordinates are unchanged.
  Unit-tested only; `simulator-form` must pass with it (3 runs, first tap on the field) before
  release.
- `sleight-mcp --doctor <app>` reads an app that is already running and reports the read's time and
  whether it had a window header. It never launches the app or sends input. An app on the user's
  pre-approved list is read, with the grant audited; any other app needing approval is skipped without
  a prompt. A live run read Calculator in 156 ms with a header (2026-10-10).
- A flow rule's source or destination can be a site (`site:example.com`, `site:*.example.com`),
  matched from the window's URL. Existing rules keep their meaning. Unit-tested.
- Trace settings for diagnosis on this Mac: `SLEIGHT_TRACE_CODE=1` keeps Claude's code in the
  trace, up to 4,000 characters (the trace's 300-character cut used to drop the end of every
  batch), and `SLEIGHT_TRACE_CUT` sets that cut for everything else, such as whole UI trees.
- Repository checks use four test workers, retaining the full suite and its existing deadlines:
  with every test file at once, the app-health restart test and the doctor's pipe test each failed
  one full check at load 9 to 11 and passed 5 of 5 and 3 of 3 runs alone.

## 1.1.0 (2026-10-09)

Its release pass passed 20/21 ([results](docs/benchmarks/2026-10-09-release-1.1.0.json)), and
chess-drag passed 3/3 after the last two changes below.

- When a turn ends, sleight names any app it acted on that holds a keyboard event tap, once per
  session, in a notice. Device Hub kept a tap after simulator runs and stalled every key on the Mac
  for 40 s.
- When a page renumbers its elements and Claude acts on a number from the tree it saw, sleight finds
  that element by its line in the current tree and tells Claude, instead of refusing the action and
  costing a read. If the line isn't on exactly one element, the refusal stays. Unit-tested only.
- When the engine's helper is restarting after 20 s idle and a call fails with "native pipe startup
  failed", the relay sends it again once, a second later. Unit-tested only: no live idle gap hit the
  race (0 of 6).
- Replay: `sleight-mcp record <transcript or session id> task.json` turns a finished run into a
  script, and `sleight-mcp replay task.json` runs it again through sleight with no model. Element
  numbers become IDs, labels or whole lines the guard finds again, and a script that depends on
  screen positions needs `--allow-positions`. A 3-call Calculator run replayed in 5.5 s against 17 s,
  and stopped without clicking when Calculator wasn't in the recorded state
  ([design](docs/design/replay.md)).
- An action Claude didn't await that fails no longer ends the engine's JavaScript session. The guard
  handles each action's promise and tells Claude which action failed. 1.0.0 lost the session and
  its handles (1/1), and the fix kept them (3/3).
- A `drag` that runs past its 30 s limit says it timed out, instead of returning only "Command
  failed", and a mouse button it left pressed is released. It won't start a press after 20 s, and it
  reads the window's elements once instead of twice. Chess took 9.4 s per read.
- A covered drag with no selected text presses nothing and tells Claude to use the engine's
  `app.drag`, which moved a covered Chess pawn where `drag`'s posts didn't.
- Benchmark runs disallow Glob, Grep and Read too. Claude's Glob for a saved Chess game never
  returned, and runs that had passed hit the 5-minute limit.
- The skill says to press another visible part of a piece when a drag moved nothing, instead of
  repeating the point or switching to `drag`. Telling Claude to press a pawn's head backfired in a
  small Chess window, where the e-pawn's head sits behind the king.
- The benchmark counts an acquisition the relay sends ahead of a call's actions as engine time. It
  had counted as relay time: 9.6 of the 9.98 s of relay time in the background head-to-head.

## 1.0.0 (2026-10-09)

sleight's first stable release. Its release pass passed 19/21 in 165 turns and 912 s, at 2.59 s of
model time per turn ([results](docs/benchmarks/2026-10-09-release-1.0.0.json)). 0.16.0's passed 20/21 in
178 turns and 1,355 s.

- The first action after an acquisition no longer reads the app's whole tree again. The guard reuses
  the acquisition's read when the app's windows are unchanged, checked through the engine's inventory
  in 11 to 30 ms. Right after Calculator launched under load, that second read had taken 16.7 s.
- When a drag point is covered, `drag` says by which window. A window of the same app with no title is
  named as a likely dialog to finish or close first. Chess's New Game dialog stopped 9 drags in one
  run.
- Text moves in other apps' text areas and fields try the Accessibility move first. Safari's web
  text areas ignore those writes, so `drag` falls back there; other apps' native text views are
  untested. A move whose writes leave the text as it was now says so and tries the next path, where it used to
  ask for Cmd+Z.
- A text drag into a TextEdit window you've covered no longer takes your pointer. `drag` moves the
  text through Accessibility, then posts one Shift press and release to TextEdit's process. Without
  that event, TextEdit's next Cmd+S deadlocked in 10 of 13 probe trials; with it, 0 in 10, and 10
  `drag` moves in a row saved cleanly. The background mouse drag's spacing repair gets the same event.

- Benchmark runs disallow Bash, Write, Edit and the web tools for Claude, like the Codex arm's
  disabled shell. No run used them to pass a check, but Claude often opened task files from Bash.
- The benchmark quits Device Hub or Simulator after each simulator run, and stops a pass when a
  benchmark app still holds a keyboard event tap afterwards. On 2026-10-09 Device Hub's tap stalled
  every key on the owner's Mac until it quit.

- `drag` scales Claude's points by the screenshot of the window it drags in, not only the app's latest
  screenshot. In a 0.16.0 pass, Chess had a second, untitled window, and 3 of 13 drags went in
  unconverted because the latest screenshot was of the other window.

## 0.16.0 (2026-10-08)

- `drag` takes `from` and `to` in the engine screenshot's pixels, as its description always said. It
  read them as window points, which are half that on a Retina display, so drops landed a line below
  the text. In 3 textedit-drag runs on 2026-10-08, Claude's first 2 or 3 drags each left the text as it was,
  and one run never found the cause. The relay now tells `drag` the size of the app's latest engine
  screenshot, and the result says the scale it used.
- The foreground drag waits for 2 s without typing or mouse use (up to 10 s), and stops if you type
  once it has taken focus. macOS drops a background drag on whatever is on screen at the drop point, so
  a TextEdit window you've covered still needs the real pointer. In a pass on 2026-10-08 that caught
  the owner typing, and a space went into TextEdit. `hover` and the `menu_bar` real click wait the same way.
- The docs say that apps marked "Always allow" in Codex or ChatGPT are approved by the engine itself,
  with no prompt in sleight. They used to say every app asks once per session; TextEdit, on that list
  here, never asked (2026-10-08).
- `noWindowsAvailable` from the engine now comes with what it means: the app's window is on another
  Space (full screen or Split View), minimized or hidden. Claude asks you to show it instead of retrying.
- The pane shows the app's picture in the desktop app's Code tab, Auto mode included. Auto mode
  refused the pane's between-turn snapshot because no request asked for it. A `tool.check` hook now
  allows exactly the snapshot code the mod built, and `turn_ended`, when Claude Code says the call
  came from sleight itself. Claude's own calls still go through the normal check. The picture also
  re-encodes until it's 16,000 base64 characters or less. At 51,135 it went over Claude Code's MCP
  output limit and was dropped. In the owner's Auto mode check, the pane showed Calculator's picture and 6
  actions, and the status line showed sleight.
- `/sleight <prompt>` waits for sleight's tools to load before it sends the prompt. In a new session
  Claude used to start with `open` and `osascript` because they hadn't loaded yet.
- The relay refuses an action written without `await` when more code follows it. A failed action
  without `await` can end the engine's JavaScript session and every app handle with it (3/3 on
  2026-10-07).
- The benchmark closes the documents a failed run left in TextEdit before the next run, and records
  whether each task's app had a window on the current Space.
- The release pass ([`release-0.16.0`](docs/benchmarks/2026-10-09-release-0.16.0.json)) passed 20/21
  in 178 turns and 1,355 s, at 2.34 s of model time per turn. textedit-drag passed 3/3. One
  chess-drag run hit the 5-minute limit with its game unsaved. A second, untitled Chess window sat over
  the game, so 6 of its drags were refused as covered.

## 0.15.2 (2026-10-08)

- A window that retitles itself keeps its lease. Chess renames its window when a game starts, on each
  move and on save. The guard still stops the next action, and the stop now includes the window it
  saw, which the relay leases, so Claude's retry goes through. Before, the retry was refused
  again and Claude had to acquire the app anew. Document scope and change review stay strict, and
  another session holding the window still refuses.
- Every sleight tool loads at session start, local tools included. Claude searched for `drag` before
  each drag.
- The skill says the window title is the confirmation of a save, not `ls` or `cat`.
- The benchmark runner holds the live lock itself.
- The next pass (`docs/benchmarks/2026-10-08-retitle.json`) passed 21/21 in 123 turns instead of 140,
  with 101 calls. None were refused or tool searches, and one was a Bash check. It took 582 s, at 2.64 s of
  model time per turn against 1.93.

## 0.15.1 (2026-10-08)

- The skill is 7,528 characters instead of 17,549, with every safety rule kept. Claude reads it on
  every turn now. It adds what a trace of 12 slow-task runs found: exact text by `paste`, because
  `typeText` goes through macOS auto-capitalization ("sleight" was saved as "Sleight" in 6/6 runs);
  the whole Save, final Return included, in one call; the result's title as the save's confirmation
  instead of a Bash check; menu shortcuts; and `menu_bar` only for menu bar icons.
- An action whose result shows another window of the same app says which window it acted on and
  which it shows. After closing a Chess game, Claude used to probe for it.
- A call that starts with an acquisition is split for the app the lease already holds too. In one
  call, the guard's setup referred to `app` before Claude's `let app` and threw.
- The next pass (`docs/benchmarks/2026-10-08-skill-trim.json`) passed 21/21 in 140 turns instead of
  156 and 531 s instead of 638, with 271 s of model time at 1.93 s per turn. textedit-save took 6 to
  8 turns instead of 9 to 14.

## 0.15.0 (2026-10-08)

- Claude can acquire an app and act on it in one call:
  `let app = await cua.getApp("TextEdit"); await app.pressKey("super+n")`. The lease used to refuse
  that until the app was acquired in a call of its own. Now the relay sends the acquisition alone and
  takes the lease from its reply. Then it sends the rest under the guard and returns one result. A failed
  acquisition stops before any action, and another session's lease refuses the rest as before. The
  skill says to combine them when the first actions don't depend on the UI.
- The next pass (`docs/benchmarks/2026-10-08-acquire-and-act.json`) passed 21/21 in 156 turns and 638
  s. Claude didn't combine a call in any of its runs, so it measures that nothing broke, not a saving.
  The benchmark has no task that switches apps, where this saves the most.

## 0.14.1 (2026-10-08)

- When an app's reads time out twice, sleight asks the app over Accessibility (500 ms, no prompts)
  and reads another approved app as a control before advising anything. It tells Claude to have
  the user restart ChatGPT only when the helper itself is stuck, and to quit the app when the app is.
  Restarting ChatGPT ends every Codex thread. Wrong restart advice fell from 1/1 to 0/6 runs with a
  hung fixture app (`docs/benchmarks/2026-10-08-reliability.md`).
- `drag`'s refusal for a window that's off screen or minimized says how to recover.
- The benchmark waits for Chess to exit before relaunching it and retries LaunchServices -600.
- The next pass (`docs/benchmarks/2026-10-08-reliability-pass.json`) passed 21/21 in 157 turns and
  586 s, with no refused calls.

## 0.14.0 (2026-10-08)

Fewer turns. In the 0.13.4 pass, 20 of 155 tool calls only loaded the skill, and without it Claude
spent the turn searching for the `js` tool instead.

- The relay adds the skill to the engine's first result, which Claude waits for anyway, and Claude
  no longer invokes the skill itself (`/sleight:drive-mac-apps` still shows it).
- `js` loads at session start (`_meta` `anthropic/alwaysLoad`), so Claude doesn't search for it before
  its first call. sleight's other tools load on demand, as before.
- `getAXState({ disableDiffing: true })` comes back whole, as sleight's own advice promises. Before,
  it could say "no change", and Claude took a screenshot to check.
- Each pre-approval grant appears once per result, where a batch of Calculator clicks used to repeat
  it 12 times.
- The next pass (`docs/benchmarks/2026-10-08-turns.json`) passed 21/21 in 157 turns instead of 195,
  with 426 s of model time instead of 490 and 717 s in total instead of 756. Model time per turn
  rose from 2.51 s to 2.71 s. Every task took fewer turns.

## 0.13.5 (2026-10-08)

- `getScreenshot()` takes the engine's combined capture and keeps its AX half as the guard's read,
  with the same image. A screenshot then an action took 469 ms instead of 501, and an action then a
  screenshot 468 instead of 520 (`docs/design/engine-time.md`).
- The skill says to type contiguous text with one `typeText` instead of a `pressKey` per character.
  Typing 8 digits in TextEdit took 1.4 s instead of 4.2 s.
- Reads after any input cost about 415 ms however long the caller waits first. The skill says not to
  sleep before a read.
- The next pass (`docs/benchmarks/2026-10-08-engine-time-pass.json`) passed 21/21 in 212 turns and
  877 s. Two calculator-click runs took 16 and 10 turns while Calculator's AX tree changed under them
  (`docs/known-problems.md`). The other tasks matched the previous pass.

## 0.13.4 (2026-10-08)

- Every action clears the window guard's saved reads for all handles in the call. Before, an action
  through a second handle on the same window left the first handle's read in place, so that
  handle's next action was checked against a stale tree.
- A `getAXStateAndScreenshot()` read counts as the guard's read until the next action, which saves
  one read per call that reads that way (Chess, 2 to 1). Other calls read as often as before.
- With `SLEIGHT_TRACE` set, the trace times each guard read (`docs/design/guard-reads.md`). Reads
  after an action take about 400 ms, against about 50 ms for the first in a call.
- The next pass (`docs/benchmarks/2026-10-08-guard-reads.json`) passed all 20 runs that started, in
  195 turns and 121 calls. Engine time was 190 s against 191 s. chess-drag's first run didn't start,
  because macOS failed to relaunch Chess right after the benchmark quit it (error -600).

## 0.13.3 (2026-10-08)

- `let app = await cua.getApp("X"); app` counts as an acquisition. The input lease knew only the
  form without the trailing `app`, refused Haiku 5.5's three tries at it as actions, and advised
  `await cua.getState()`, which acquires nothing (a textedit-save failure, 2026-10-08). When a
  refused first call names its app, the advice is now that app's acquisition. Unit tests cover both.
  Neither came up in the passes after the fix. Sonnet 5.5 medium passed 21/21 in 226 turns and 738 s
  (`docs/benchmarks/2026-10-08-acquisition-echo.json`), and Haiku 5.5 passed textedit-save 3/3.
- `docs/benchmark.md` compares Sonnet 5.5 at medium and low effort, Haiku 5.5 and Opus 5.5 on 0.13.2.

## 0.13.2 (2026-10-08)

- sleight keeps the input lease when it stops an action (a renumbered batch, or an AX ID that
  doesn't match). The stop message includes the window header from the read it took, so Claude
  retries without acquiring the app again. Before, a textedit-save run's correct retry was refused and cost
  a turn and a 21,043-character tree.
- The skill shows a Save As in one call (Go to Folder, the folder, Return, the name by ID, Return).
- The next pass (`docs/benchmarks/2026-10-08-save-in-one-call.json`) passed 20/21 and took 213 turns
  instead of 260, and 687 s instead of 825, at 2.05 s of model time per turn against 1.81.
  textedit-save's median fell from 27 turns to 16. The failure was a Chess window the engine
  couldn't drag in (`docs/known-problems.md`).

## 0.13.1 (2026-10-07)

- Fewer errors, so fewer turns. In two benchmark passes 94 of 437 calls failed. A Save panel's Go to
  Folder sheet has no title, and the input lease stopped the call that opened it (18 errors); an
  untitled sheet or panel of the same app now passes. `js` accepts `command` for `code`, which Claude
  sent 6 times. Reading after ⌘W closed the last window reports that instead of a
  `noWindowsAvailable` error (7). Inventory reads may pass `{ emit: false }`. The next pass passed
  21/21 with 12.7% of calls failing instead of 21.5%, and took 260 turns instead of 300 and 825 s
  instead of 902 (`docs/benchmarks/2026-10-07-errors.json`).
- `menu_bar` says it isn't for an app's own menus, and its error points to `js` (Claude used it for
  File and Format 3 times). Not measured yet.
- Benchmark runs record token usage and allow every sleight tool.

## 0.13.0 (2026-10-07)

- Claude can address an element by its AX ID or label instead of its number:
  `await app.click({ id: "Seven" })` or `{ label: "Multiply" }`, also for `scroll`, `selectText`,
  `setValue` and `performSecondaryAction`. sleight finds the element in the read it already takes
  before each action. A batch addressed this way keeps working when an earlier action renumbers
  the window. All
  Clear and then 1234 × 5 = ran as one Calculator call and showed 6,170. A name that matches no
  element or several stops the action. Over the benchmark (7 tasks, 3 runs each, Sonnet 5.5),
  refused calls fell from 14 to 7 and turns from 300 to 281
  (`docs/benchmarks/2026-10-07-element-ids.json`).
- Benchmark answers have the user's full name replaced, because Chess window titles include it.

## 0.12.3 (2026-10-07)

- Claude gets each screenshot once. The skill told Claude to pass `getScreenshot()` to
  `nodeRepl.emitImage`, but `getScreenshot()` already shows its picture, so every step sent two
  copies: 64 images over one iPhone Mirroring session. The skill now says to call it alone, and the
  relay drops an exact repeat within a result and tells Claude why (checked live: 2 images before,
  1 after). The skill also says to keep one handle between actions instead of acquiring the app
  again before each one.
- Benchmark results split each run's time into model, engine, sleight's local tools, the relay and
  Claude Code (`docs/benchmark.md`).

## 0.12.2 (2026-10-07)

- The input lease's recovery advice works. A session asked for `getApp("grokbot")`, and no app
  has that name. Every later refusal told Claude to send exactly that call again, as `app = …`. A failed
  `let app` leaves no `app`, so the assignment failed with "app is not defined", and the session
  failed 20 of its first 22 calls. The advice now uses the last app that was read successfully
  (or `cua.getState()`), and declares the handle with `let`, which the engine accepts again for a
  name it already has.
- A refused `cua.listApps()` or `cua.getState()` statement is told the one-expression form that
  passes the lease.
- When the engine's JavaScript session restarts on its own, sleight now tells Claude that its
  handles are gone and forgets them too. An action without `await` that fails can end the session:
  `app.click(1); "x"` on a disabled Calculator element did it 3/3 times on 2026-10-07. The skill's
  example now awaits its click, and the skill says how to look up an app's name.
- Benchmark: `simulator-form`, a mobile end-to-end task in the iPhone simulator, 3/3
  (`docs/benchmarks/2026-10-07-simulator-form.json`).

## 0.12.1 (2026-10-06)

- The pane's picture fits the pane. It was sized to half the terminal, but a pane above the prompt
  gets about a third, so the picture pushed Refresh, Stop and the action log out of view. It now
  uses the rows the pane has and leaves room for the buttons and three log lines.
- The pane's snapshot holds half-block cells in a terminal and an image in the desktop app, never
  both. Claude Code replaces an MCP result over about 100,000 characters with a
  notice, and a docked terminal pane's snapshot of Calculator came to 107,707 with both, so the
  pane showed "no frame in the result". Now it's 62,710 characters at 120 × 33 cells. The desktop
  image is a JPEG at most 640 px wide, 53,536 characters for Calculator.
- The update watch captures the engine's API docs without touching an app, so a pre-approved
  Calculator no longer puts its window in the snapshot.
- Checked live in a fullscreen terminal session: the docked pane showed Calculator with the full
  log. The benchmark runs headless without the pane, so it wasn't rerun.

## 0.12.0 (2026-10-05)

- A batch of clicks stops when an earlier action in the same call renumbers its target. Before each
  action the guard compares the element at that number with the one at the call's first action.
  Recording the demo, two takes garbled Calculator: the first click closed its history sidebar,
  every button shifted, and the rest of an 11-click batch hit the wrong keys. In the next take
  sleight stopped the batch at the second click, and Claude read again and got 1234 × 5678 right.
  Benchmark 12/12 (`docs/benchmarks/2026-10-05-release-0.12.0.json`), though no run there batched clicks.

## 0.11.0 (2026-10-05)

- Fewer reads per call. A read Claude makes is now a full read the relay turns into changed lines,
  and the window guard reuses it instead of reading the whole tree again after the call. Time added
  per call fell from 242 to 332 ms to 10 to 14 ms on the CNN front page, and from 46 to 88 ms to
  6 to 11 ms in Calculator (`docs/benchmarks/2026-10-05-guard-reads.md`).
- An untitled document that autosave gives a URL mid-call counts as the same window, outside
  document scope and change review. No change in turns was measurable.
- When an app stops answering, the message adds that the app itself may be hung if other apps still
  answer, before suggesting a ChatGPT restart. The skill tells Claude not to set TextEdit text with
  `setValue`, after three TextEdit hangs that followed it.
- README rewritten for first-time readers. The in-session install command it gave wasn't valid; it
  now gives `/plugin marketplace add` and `/plugin install`, checked on a fresh Claude config.
  Known problems, settings, how it works and the benchmark moved to `docs/`.
- Benchmark: 12/12 in two full passes. Two TextEdit-only reruns in between went 0/9 and 7/9, one
  TextEdit hang and its aftermath (`docs/benchmarks/2026-10-05-release-0.11.0.json`).

## 0.10.0 (2026-10-05)

- Compaction handles pages that renumber. Lines are matched by their text without the element
  number, and elements whose only change is a new number are counted instead of listed. The relay
  refuses actions on numbers that changed until Claude reads them again, and on computed numbers in
  that state. On the CNN front page, five scrolls sent 39,655 characters instead of 203,160; in
  click trials the relay refused 8 stale numbers and let 6 current ones through, none wrong
  (`docs/benchmarks/2026-10-05-compact-reads.md`). Benchmark 12/12. Two of its three refusals stopped a
  click that would have hit the next menu item, because an open menu had shifted the numbers by one.
- When the engine's helper fails to start ("native pipe startup failed"), the result says no app got
  the call and tells Claude to retry once, then `js_reset` and retry.

## 0.9.1 (2026-10-05)

- Guard-read compaction works when a `js` call writes its own output before the guard's read. In
  0.9.0 those reads went whole with the relay's internal mark visible. Benchmark 12/12. In Helium, a
  click on a page with a 120-item sidebar sent 428 characters instead of 35,532; scrolls on the CNN
  front page still go whole, because lazy loading renumbers the elements
  (`docs/benchmarks/2026-10-05-compact-reads.md`).

## 0.9.0 (2026-10-05)

- Smaller results after actions. The window guard's read after each `js` action now reaches Claude
  as the lines that changed since the last full tree it saw for that window, or one "no change"
  line, instead of the whole tree again (`docs/benchmarks/2026-10-05-compact-reads.md`). The relay
  keeps that tree, so the engine's next diff still starts from what Claude knows. Benchmark 12/12;
  46 guard reads were cut down, and result text per run fell 1 to 23% on TextEdit and Chess. Busy
  browser pages, where the complaint came from, are unmeasured.

## 0.8.0 (2026-10-05)

- Fewer prompts for terminals and OpenAI's apps, opt-in. If you turn off the helper's refusal
  yourself with `defaults write -g ComputerUseAllowForbiddenTargets -bool YES`, these apps go
  through the engine with one approval per app for the session, and Claude types in the background.
  sleight's prompt says a yes lets Claude run terminal commands without asking again, and actions
  in these apps' settings windows are refused. `--doctor` shows whether the setting is on. sleight
  never sets it. In the live check Terminal ran `echo` in the background 2/2, and its settings
  window was refused 1/1.
- The skill says a built-in browser is usually faster for public pages, and sleight's browser
  surface fits pages that need the user's logged-in browser.
- Known problems added: the window guard adds a full, non-diffed tree to every action result, and
  TextEdit hung 2/2 on Cmd+Shift+S (Duplicate) right after its text was set. The skill now steers
  Claude to Cmd+S or File > Save As, and the benchmark's TextEdit setup times out on a hung TextEdit.
- Benchmark: 6/6 TextEdit runs after the skill hint, and 1/1 each on the other tasks
  (`docs/benchmarks/2026-10-05-release-0.8.0.md`, the hung runs included).

## 0.7.0 (2026-10-05)

Benchmark: 16/18 from a clean arm folder (Sonnet 5.5, medium). Every task passed 3/3 except
chess-drag, 1/3; both failures dragged the pawn to e5, an illegal move
(`docs/benchmarks/2026-10-05-release-0.7.0.md`, every run included).

- `drag` tries a background drag first. It posts the drag to the app's process, with no activation
  and no pointer move, and falls back to the foreground drag only when the text didn't change
  (`docs/design/background-drag.md`). When another app's window covers either drag point, it goes
  straight to the foreground drag and names that app, because macOS picks the drop target from
  what's on screen: 0/3 background moves covered, 3/3 uncovered, on TextEdit. Both paths raise the
  window chosen by `windowId` and refuse before pressing if it isn't on top at both points. Drags
  that land outside the window's content, or in an ambiguous window, are refused. Lost text is
  reported with a Cmd+Z hint, and TextEdit gets back the space after a verified one-word move to a
  line end. Built by Codex. Locked window checks passed 8/8 (four refusals, four exact moves).
  Stacked Chess games moved the chosen game 1/3, with the covering game unchanged in all three.
- `hover`: a short real-pointer hover with a screenshot, for UI that only reacts to a real pointer,
  after the skill's background options fail (`docs/design/hover.md`). It asks once per app and holds
  the pointer for about 1.8 s. A point another window covers is refused. Built by Codex. A tooltip was absent at
  1000 ms and readable at 1500 ms in one trial each, so 1500 ms is the default.
- Pre-approved apps: a list you write at `~/Library/Application Support/sleight/preapproved.json`
  approves apps up to a risk level without a prompt, in every session (`docs/design/preapproved-apps.md`).
  No setting can point at another file. Grants go to a small audit log. Built by Codex. Live: listed
  Calculator worked out 12 × 12 with audited grants, and was refused once taken off the list.
- `select_window` raises one window of an app through Accessibility, since the engine rejects
  `cua.getApp({ windowId })` on macOS. Built by Codex. 3/3 with the tool on TextEdit.
- Browser surface: sleight turns on the engine's browser control when a ChatGPT browser extension is
  connected at startup (`docs/design/browser-surface.md`). Native guards stay on for every call
  until the engine's reply confirms a browser call. Built by Codex. In the live check Chrome and
  Helium each opened a tab and clicked a link in it, and turn end closed both tabs.
- Engine stall: after two read timeouts for an app, the relay stops sending its calls and tells
  Claude to ask the user to restart ChatGPT, retrying one read itself at most every 20 s
  (`docs/design/helper-health.md`). Built by Codex. 3/3 recovery trials.
- Doctor runs a bounded live read. It now fails when the helper can't start, which it used to report
  as "ok", and prints the `launchctl remove` command for the stale launchd job that caused that on
  2026-10-05.
- Clipboard preservation, opt-in with `SLEIGHT_CLIPBOARD=preserve`. Copy and Cut go to a private
  session clipboard and the user's is put back (`docs/design/clipboard.md`). Off by default, since a
  copy meant for the user wouldn't reach menu Paste or `pbpaste`. Built by Codex. 19/19 live, then
  2/2 on the merged code. Each call takes about 230 ms longer.
- Change review (still opt-in) takes its snapshot on a standalone re-read, so a file opened through
  the Open dialog can be edited. Live: 4/4.
- Benchmark harness: arm folders live outside any git repo, and `bench/run.mjs` refuses one inside.
  Until now both arms ran from inside this repo and loaded its CLAUDE.md and project memory. The
  approval hook also takes the three apps' bundle IDs, and TextEdit tasks quit an empty TextEdit
  first so its windows open on the current desktop.
- `blocked_app`: drives the apps the engine's helper refuses (Terminal, iTerm2, ChatGPT, Codex, Atlas
  and beta builds) through sleight's own macOS Accessibility path, the one `menu_bar` and `drag` use
  (`docs/design/blocked-apps.md`). The engine's refusal is OpenAI's code and is untouched, and
  sleight's prompt is the whole opt-in. When Claude reaches a refused app, the relay says so in the
  result and offers the tool. Allow puts the app on the session allowlist like any other app
  approval, and the prompt says it covers approval buttons. In a terminal, every key or text that can
  run a command (any typing, Return, paste, most chords; only arrows, Tab, Escape and ctrl+c are
  inert) is shown exactly as it will be sent, with Allow Once and Don't Allow. The relay forgets
  each answer, and the preapproved list cannot cover these sends. Settings windows of these apps are
  refused by title plus a toolbar check, because the Terminal app titles its settings window after
  the open pane. Actions take app-scope input leases and pass through the flow rules. The driver is
  pinned to the consented app's bundle ID and pid, and checks the frontmost switch before sending
  keystrokes. Clicks on buttons named like Approve, Allow, Run or Accept are named in the result.
  `npm run check` passes (22 tests on this path). Live runs, with the owner clicking Allow, went as
  follows. Terminal passed 1/1 (read, exact-text prompt, echo, output visible); three other runs
  stopped on a declined or timed-out consent. The Codex window read passed 1/1; its harmless click
  had no target, because the window exposed only window-control buttons to the walk.
  `docs/benchmarks/` has all the attempts, timeouts included, with personal paths scrubbed.
- The CHANGELOG entries for 0.6.0 and earlier, lost in a merge, are back.

## 0.6.0 (2026-10-04)

- Input leases: one sleight session acts on a window at a time. A second session gets the holder's
  name and seconds left, and reads still work. Before acting, Claude reads the window with
  `cua.getApp`, and a refusal gives the exact call to send. Leases end with the turn, or after 30 s
  without renewal (`docs/design/input-lease.md`). Built by Codex. With two relays typing into one
  TextEdit document, text doubled in 5/5 trials without leases and appeared once with one refusal in
  5/5 with them. Benchmark with leases on: 11/11 over two passes (Sonnet 5.5, medium). A Save sheet
  stops the next action until Claude reads again, so textedit-save took 27 and 30 turns, against 13
  without leases.

## 0.5.0 (2026-10-04)

- `review_changes`, opt-in with `SLEIGHT_CHANGE_REVIEW=1`: lists the saved files Claude changed this
  session and lets the user choose Keep or Undo for each one in a prompt. The relay copies a `file://`
  document before a `js` call that may edit it and deletes the copies when the session ends
  (`docs/design/change-review.md`). Built by Codex. In the live check, Undo restored one TextEdit
  file and Keep left the other in 1/5 attempts. The sandbox and a locked Mac stopped the first two,
  and the user chose Keep for both files in the next two. It's off by default because its window
  guard failed both benchmark tasks that open a TextEdit file.
- Flow rules, opt-in with `SLEIGHT_FLOW_RULES=1`: user-written rules for text moving between apps,
  checked in the relay before a call is forwarded, with a one-call exception only the user can grant
  (`docs/design/flow-rules.md`). Built by Codex. It guards against mistakes, since code can build
  strings at runtime. The live TextEdit check passed in 2/5 attempts. One failure forwarded a
  protected value, and the parser fix that followed has a regression test.

## 0.4.0 (2026-10-04)

- `SLEIGHT_APPROVAL_SCOPE=document` approves one window or document for the session instead of a
  whole app, through a new `document_scope` tool. The relay forwards actions only while the last
  observed window matches, and stops when a result shows a different window. It guards against
  mistakes; code running in the engine can get around it (`docs/design/document-scope.md`). Built by
  Codex; live check: the approved TextEdit document was edited and a write to a second one never
  reached the engine.
- Background drag research (`bench/background-drag/`, not in the plugin): full sequences reached the
  probe app in 5/5 quiet trials and 2/5 during real use, but TextEdit text moved 0/10.
- The weekly watch saves the engine's API docs and diffs them when the engine updates.

## 0.3.1 (2026-10-04)

- The relay ends the engine's turn after 30 s without a running call. In the desktop app, where the mod
  can't run, the engine used to hold the last app (its badge on the window) until the session closed.
  That's the likely cause of desktop sessions showing as busy after Claude finished. `SLEIGHT_IDLE_TURN_END_MS` sets the wait.
- Hover: mouse events posted to a background app don't trigger hover, measured with the probe app and
  GitHub Desktop.

## 0.3.0 (2026-10-04)

- A `drag` tool that holds the mouse down and moves in steps, for drags the engine's `app.drag` can't
  do, such as moving selected text. It works in the foreground and puts the pointer and the front
  app back. It refuses to press when another app's window covers the start point. Benchmark text drag:
  3/3 (Sonnet 5.5), against 0/9 for `app.drag`.

## 0.2.1 (2026-10-03)

- `menu_bar` opens SwiftUI window-style icons, which ignore the accessibility press, with a real
  click and puts the pointer back. `close` clicks them again to shut the window. Icon-only buttons
  report their tooltip or identifier when they have one.
- `menu_bar` op `apps` takes about 4 s instead of 5.5 s.
- Drag findings: a probe app (`bench/drag-probe/`) shows the engine's drag lasting 14 ms with two drag
  events, so text drags can't work.

## 0.2.0 (2026-10-03)

- New `menu_bar` and `notifications` tools for what the engine leaves out: apps' icons in the menu
  bar (read the menu or window, choose an item, press a button) and notification banners (read, press
  a button). They go through System Events UI scripting. Each app's icon needs the user's approval
  once per session, as do notifications. `SLEIGHT_MENU_BAR=0` turns them off.
- The approval panel opens on the display under the pointer, over full-screen apps, with a sound.
- Benchmark: each arm loads only its own tool (checked before every run), runs default to Sonnet 5.5
  at medium effort, and runs close the windows they leave behind.

## 0.1.1 (2026-10-03)

- App approvals work in the desktop app's Code tab. It declines MCP prompts without showing them, so
  there sleight asks with its own panel (Liquid Glass where macOS has it). `SLEIGHT_APPROVAL_PROMPT`
  picks `dialog` or `client`.
- Benchmark runs keep approvals on the benchmark's hook when started from a desktop app session, and
  the sleight arm runs from an empty folder like LCU's. A Chess drag task joins the benchmark.
- The skill covers saving to a path through Go to Folder, and apps whose bundle ID is ambiguous.

## 0.1.0 (2026-10-03)

First release. Tested on Claude Code 2.1.288 with ChatGPT engine 26.930.31730, on macOS (Apple Silicon).

- Claude Code can drive Mac apps in the background through the computer-use engine bundled with the
  ChatGPT desktop app. The launcher finds the newest engine version on every start.
- One approval prompt per app per session. The relay replies to the engine's repeat requests itself, and
  `SLEIGHT_APPROVAL_SCOPE=once` asks every time instead.
- `/sleight` opens a pane with the app's latest picture, an action log and Refresh and Stop buttons.
  Text after `/sleight` goes to Claude as a prompt. `/sleight stop` halts it mid-turn.
- The engine's turn ends after each Claude turn, as in Codex (Claude Code 2.1.287 or later).
- A skill tells Claude when to use sleight and how to work around the missing hover.
- Benchmark: four Calculator and TextEdit tasks, 12/12 on the first run.
