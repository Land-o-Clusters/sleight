<p align="center"><img src="docs/assets/sleight-icon-256.png" width="128" height="128" alt="sleight icon: two hands passing a mouse pointer, trailing warm and cool pixels"></p>

<h1 align="center">sleight</h1>
<p align="center"><strong>Claude drives your Mac apps in the background. Your cursor stays yours.</strong></p>
<p align="center">A Claude Code plugin that hands Claude the computer-use engine bundled with the ChatGPT desktop app.</p>

<p align="center">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-E8622C">
  <img alt="platform macOS Apple Silicon" src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-3E4A56">
  <img alt="status unofficial, early" src="https://img.shields.io/badge/status-unofficial%2C%20early-3E4A56">
</p>

<p align="center">
  <a href="#compared-with-claudes-own-computer-use">Compared with Claude's computer use</a> ·
  <a href="#install">Install</a> ·
  <a href="#watch-and-stop-it">Watch and stop it</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#known-problems">Known problems</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#benchmark">Benchmark</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

> [!IMPORTANT]
> sleight is unofficial. OpenAI and Anthropic don't endorse or support it.
> It drives an undocumented runtime that comes with the ChatGPT app, so a ChatGPT update can break it at any time.
> It contains no OpenAI code. It starts the copy already installed on your Mac.

Most computer-use tools borrow your screen. The pointer jumps around, windows pop to the front, and you
sit on your hands until it's done. The engine inside the ChatGPT desktop app sends clicks, drags and
keystrokes straight to the target app instead. The app can be behind your other windows the whole time,
and you keep working.

sleight gives that engine to Claude Code. Claude writes a few lines of JavaScript against the engine's
API (`cua.getApp("Calculator")`, `app.click(...)`, `app.getScreenshot()`) and the engine handles the rest.
sleight adds its own tools for what the engine can't do. `drag` holds long enough for text views to
start a drag and tries background events first. Its foreground fallback, `menu_bar` clicks and
`hover` can move your pointer briefly. Each asks first.

<p align="center"><img src="docs/assets/demo.gif" width="900" alt="Claude playing macOS Chess against the computer through sleight, with the sleight pane logging each move"></p>
<p align="center"><sub>Claude plays macOS Chess against the computer through sleight, at 6× speed. Every move is a drag. The sleight pane on the right logs each one.</sub></p>

## Compared with Claude's own computer use

Claude Code has a built-in computer use server, and the Claude desktop app has the same engine.
Anthropic's [documentation](https://code.claude.com/docs/en/computer-use) (read 2026-10-04) says it
controls your screen: other visible apps are hidden while Claude works and come back when the turn
ends. Only one session can use the computer at a time, and it holds the lock until the session exits.
Claude sees the screen through screenshots.

sleight sends events to the app itself, which can be behind your other windows. Your other apps stay
visible, and you keep using the Mac while Claude works. Several sessions can use sleight at once:
we've run two sleight sessions together, and sleight next to Codex. Claude reads each app's
accessibility tree as well as screenshots. Foreground `drag` fallback, `hover` and some `menu_bar`
actions briefly take the pointer.

Claude's own computer use is supported by Anthropic and also runs on Windows in the desktop app.
sleight is unofficial and depends on the ChatGPT app's engine.

## Install

### Requirements

- macOS on Apple Silicon.
- The [ChatGPT desktop app](https://chatgpt.com/download/), with Computer Use turned on in Codex at least
  once. That first run installs the engine's helper and gets macOS to grant it Accessibility and Screen
  Recording. You can sign out of Codex afterwards.
- Claude Code v2.1.275 or later. The pane, status line, `/sleight stop` and per-turn cleanup come from a
  [mod](https://code.claude.com/docs/en/plugins/mods/overview), which needs v2.1.287 or later. Older
  versions still get everything else.

### Add the plugin

In a Claude Code session:

```text
/plugin install sleight --marketplace Land-o-Clusters/sleight
```

Or from your shell:

```bash
claude plugin marketplace add Land-o-Clusters/sleight
```

```bash
claude plugin install sleight@sleight
```

Then run `/reload-plugins` in any open session, or start a new one.

### Check it

```bash
~/.claude/plugins/marketplaces/sleight/plugins/sleight/bin/sleight-mcp --doctor
```

`--doctor` prints the engine version and file checks. It also probes a live helper inventory read
with a five-second execution timeout. It doesn't grant app approval. Then try:

```text
Use sleight to open Calculator in the background and work out 12 × 12 by clicking its buttons.
```

The first time Claude touches an app, the engine asks you something like *Allow Computer Use to use
"Calculator"?* Saying yes covers that app for the rest of the session. [Approval scope](#approval-scope)
has the details.

### Updating

Third-party marketplaces don't update on their own unless you ask them to. To update by hand:

```bash
claude plugin marketplace update sleight
```

```bash
claude plugin update sleight@sleight
```

Or turn on auto-update for the `sleight` marketplace under `/plugin` → Marketplaces.

A session runs the sleight version it started with. `/reload-plugins` keeps the sleight server that's
already running, at least in the desktop app's Code tab (seen 2026-10-03), so start a new session.

## Watch and stop it

The apps sleight drives stay in the background, which also means you can't see them. On Claude Code
v2.1.287 or later you get three ways to keep an eye on things.

`/sleight` opens a pane with the app's latest picture and a log of every action Claude took. Anything
after it goes to Claude as a prompt, so `/sleight play chess in the background` opens the pane and starts
the task. The picture refreshes after each turn that used sleight, or when you press Refresh (`r`) while
Claude is idle. A terminal draws it in colored half-blocks. The desktop app's Code tab shows the
screenshot itself.

The status line shows which app Claude is working in and how many actions it has taken.

`/sleight stop`, or Stop (`s`) in the pane, works mid-turn. It ends the engine's turn and refuses every
further sleight call until your next message. Press Esc too if you want the rest of Claude's turn gone.

The pane waits for Claude to finish before it takes a picture. The engine reports UI changes as a diff
against the latest read of an app, no matter who made that read, so a snapshot mid-turn could hide a
change from Claude. When the pane does read an app, your next message tells Claude to take a full read
before relying on a diff.

## How it works

```
Claude Code ──MCP──▶ bin/sleight-mcp ──▶ ChatGPT.app's cua-repl server ──▶ native helper ──▶ your apps
```

1. The ChatGPT app writes its computer-use server config to
   `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`, and replaces that
   folder on almost every update.
2. `bin/sleight-mcp` runs on the Node runtime bundled in ChatGPT.app, finds the newest version folder and
   starts the server described there. A hard-coded path would break within days.
3. The server has one main tool, `js`, a persistent JavaScript session. Its first call returns the API
   docs for whichever engine version is installed, so Claude always gets the current API.
4. Per-app approvals arrive as MCP form elicitations, which Claude Code shows as an ordinary prompt.
   The desktop app's Code tab gets sleight's own panel instead (`lib/ask.js`, see
   [Approval scope](#approval-scope)).
5. `lib/relay.mjs` sits between Claude Code and the server and fills in what Codex would have sent: a
   session and turn id on each call, session memory for approvals you accepted, and a `turn_ended` call
   after 30 idle seconds and when the session closes. It hides `js_add_node_module_dir` from Claude and
   marks `turn_ended` as internal. It also answers a protocol probe from newer Claude Code versions that
   would otherwise crash the server.
6. On Claude Code v2.1.287 or later, the mod (`hooks/register.tsx`) ends the engine's turn after each
   Claude turn that used it, the way Codex does, and refuses Claude's own calls to `turn_ended`.
7. The `menu_bar` and `notifications` tools handle the menu bar icons and banners the engine leaves
   out. `menu_bar` opens an app's icon, reads its menu or window and clicks menu items, and
   `notifications` reads the banners on screen and presses their buttons. Both go through System Events
   UI scripting (`lib/menubar.js`) with the Accessibility permission of the app running Claude Code.
   Each app's icon needs your approval once per session, as do notifications. `SLEIGHT_MENU_BAR=0`
   leaves both tools out.
8. The `drag` tool (`lib/drag.js`) holds the mouse down and moves in steps, for drags `app.drag` can't
   do. It posts to the target PID first, with a 500 ms hold and window-local coordinates.
   TextEdit falls back to foreground only if its text is unchanged. If the private window-local
   API is unavailable, foreground runs directly. The result reports the path and fallback reason.
   Foreground brings the app forward, then restores the pointer and front app.
   It asks once per app per session, and `SLEIGHT_DRAG=0` leaves it out.
9. The `hover` tool (`lib/hover.js`) moves the real pointer after the skill's background options fail.
   It refuses covered points. The app comes forward for a 1500 ms default wait and a screenshot,
   then the pointer and front app go back. Each app needs approval once per session.
   `SLEIGHT_HOVER=0` leaves it out. [Design and checks](docs/design/hover.md) lists its limits.

### Browser surface

At startup sleight asks the installed engine for connected ChatGPT browser extensions. If one is
available, it enables browser and native control. Empty, failed or timed-out discovery leaves only
native apps enabled, without adding discovery errors to tool results. `SLEIGHT_SURFACES` overrides
this choice. Use `computer` or `browser,computer`. Automatic mode excludes the in-app browser,
which needs ChatGPT host context. Extension discovery adds a short engine launch before the session.

Use `cua.listBrowsers()`, select by `metadata.extensionInstanceId`, then open the URL with
`cua.createBrowserTab(browser.browserId, url)`. Helium and Chrome can both report as Chrome.
Browser requests go through sleight's approval prompts. The relay never preapproves them.

In the final run on 2026-10-04, engine 26.930.31730 opened Example Domain, read it and clicked Learn more
in 2/2 trials, one in Chrome and one in Helium, both identified by the owner. `turn_ended` removed both
tabs. Both tab lists were empty, and later closes returned "No tab with id". Earlier retries found zero
engine instances despite the installed extension. The final run detected both after a connection refresh.
[Every attempt](docs/benchmarks/2026-10-04-browser-surface.json) includes detection and routing failures.

## Known problems

- Native `app.paste` temporarily changed the clipboard, then restored all measured bytes in 4/4
  fixtures. Text entry and engine drag left it unchanged in 4/4 each. Local drag did in 2/2.
  Copy/Cut use the user's clipboard by default, so deliberate copies remain available to menu Paste,
  `pbpaste` and browser pastes. Preservation is opt-in with `SLEIGHT_CLIPBOARD=preserve`. In that mode,
  Copy/Cut save a private session copy and restore the prior bytes. Their results say the copy is
  private. [The measurements](docs/benchmarks/2026-10-04-clipboard.md) include every attempt and failure.
- Opt-in preservation added median call times of 236 ms for Copy, 205 ms for Cut and 226 ms for Paste
  in three trials each on this Mac. Clipboard helper and coordination time accounted for about
  180, 177 and 179 ms respectively. Separate runs include engine timing variation; larger payloads
  may cost more. Native sessions skip this work.
- Preservation cannot snapshot unreadable formats, file promises or more than 64 MiB. It falls back
  to the native shortcut and tells Claude the clipboard was not preserved. Claude must never modify
  the user's clipboard to get around that fallback. Menu actions and browser handles are outside
  preservation, so those pastes cannot use the private copy. Use a native session to copy for the user.
  In preservation mode use literal shortcut keys and one clipboard action per JavaScript request.
  Split calls and retry when the clipboard message asks. Ordinary native sessions have no such limit.
- A failed Copy/Cut cannot attribute new clipboard data, so preservation leaves that data alone.
  Two or more generations stop restoration. One generation could be an outside copy if the app did
  not copy. macOS has no atomic compare-and-restore, and arbitrary JavaScript can bypass the proxy.
  Private copies end with a successful reset or session exit. A process crash during private Paste
  can leave temporary data on the clipboard. File URLs preserve references, not deleted files or
  file-promise providers. Native sessions and other tools do not take the preservation lock.
- Exact window selection is unavailable on macOS engine 26.930.31730. Its API lists
  `cua.getApp({ windowId })`, but it rejects that selector with "macOS getApp requires an app name,
  path, or bundle ID." `cua.getState()` also omits window IDs. With two temporary TextEdit documents,
  3/3 exact selections were rejected before editing. `select_window` uses AXRaise/AXMain instead:
  3/3 with the plugin tool, plus 6/6 with the same approach in prototypes.
  The intended TextEdit document was edited and sampled foreground state was unchanged. This depends on the app supporting those Accessibility operations and
  exposing a unique title or AXDocument URL. Other apps remain untested. During an active selection, the relay marks changed or missing action
  window headers as "outcome unconfirmed". [Attempt results](docs/benchmarks/2026-10-04-window-targeting.md) include the failures.
- Browser call text never turns off native guards. The engine must confirm `browserUse` on its reply
  before sleight learns browser handles. Candidates attempt the known native window lease and
  saved-file checks; when native access is unavailable, their runtime guard denies native access
  while browser operations remain usable. These guards remain cooperative, not JavaScript isolation.
  Flow rules use one `browser` source and destination
  for all tabs, with literal fills, typing and navigation URLs checked. They do not distinguish
  sites or tabs. Clipboard transfers and runtime strings remain outside those checks. Native
  document scope and saved-file change review do not cover browser tabs. Browser discovery runs
  once at startup; connecting an extension later requires a new sleight session or an explicit
  `SLEIGHT_SURFACES` override. An installed extension can be absent from the engine's live inventory.
- [Input leases](docs/design/input-lease.md) let one sleight session act on a window at a time.
  Another session gets the holder's name and time left, while reads remain available. Leases expire
  after 30 seconds without renewal and end with the turn or session. Local drag and hover reserve the app,
  while menu and notification actions reserve the desktop. Other tools, including Codex,
  do not take these leases, and arbitrary JavaScript can bypass the injected guard.
- Anything moving your real pointer in the app interrupts it. The engine watches real mouse and keyboard
  input to notice a person taking over, then makes Claude re-read the app. Another agent driving in the
  foreground counts too. Background sessions share the helper, with leases coordinating sleight's actions.
  In one test where Codex was also driving in the foreground, keystrokes typed
  during the run showed up twice, and we still don't know why. A
  [two-engine probe](docs/benchmarks/2026-10-04-double-keys.md) didn't reproduce it in 30/30 trials
  (engine 26.930.31730, 2026-10-04).
- The engine's `app.drag` failed TextEdit text moves 9/9. Local `drag` passed the benchmark 3/3
  before the window/content guards. Later [two-window checks](docs/benchmarks/2026-10-04-drag-window-guards.md)
  passed 8/8 (four refusals, four exact moves), with about 4.5 s of foreground pointer use per call.
  Ambiguous windows require `windowId`. TextEdit endpoints must share a text area. AX scans refuse
  above 300 elements or 12 levels ([review fixes](docs/benchmarks/2026-10-04-drag-round-2.md)).
  Lost-text errors require Cmd+Z; whitespace-only selections refuse.
  [Spacing repair](docs/benchmarks/2026-10-04-drag-polish.md) covers unique whole words at line ends.
  Other selections need a spacing check, and concurrent edits can confuse snapshot comparisons.
  The old-helper live reproduction was blocked by another session's larger window.
  Both drag paths set AXMain and raise the window selected by `windowId`, then require it above same-app windows
  at both endpoints. Foreground fallback also refuses covering apps.
  Off-screen windows must be brought to the current desktop for drag or hover.
  [Stacked Chess checks](docs/benchmarks/2026-10-04-drag-raise.md) moved the selected pawn 1/3
  submitted drags; two posts left both boards unchanged, and one later setup failed before posting.
  Screenshot points were used because AX square coordinates are reversed. Fixture cleanup was verified.
  Calculator content guards remain unmeasured.
  The [background prototype](docs/benchmarks/2026-10-04-background-text-drag.md) moved TextEdit text
  4/4 after correcting its drop geometry, but joined `gammaalpha`. The product now uses that path
  first and repairs the verified space. It only works when no other app's window covers the drag
  points, because macOS picks the drop target from what's on screen there: 3/3 TextEdit moves with
  the window uncovered, 0/3 with this Claude window over it (2026-10-05). When another app covers
  either point, the tool goes straight to the foreground drag and names that app. Before the
  named-window raise guard,
  [product trials](docs/benchmarks/2026-10-04-background-drag-product.md)
  passed 3/3 TextEdit moves, with TextEdit inactive and the front app unchanged. The owner moved the
  pointer during one trial; it was unchanged throughout the other two.
  `CGEventSetWindowLocation` is a private macOS API. Missing symbols, invalid events or coordinates that fail the
  round trip skip background posting and select foreground. Future macOS updates may
  break this path. A changed, unreadable or lost text snapshot never permits a second drag.
  Apps without a text snapshot report unverified background delivery and need a read to verify the
  move. They do not repeat the drag automatically. Calculator content guards remain unmeasured.
  Chess AX square coordinates were vertically reversed: two local posts and an engine control
  at those points left e2 unchanged. Screenshot coordinates moved e2 to e4 through the product's
  background path. Pointer and front app varied during that trial, so quiet Chess delivery remains
  unmeasured. Use the engine's `app.drag` first for Chess, and read the board after any local post.
  Chess save/close recovery selected another session's game even after the owned window's
  `AXMain` and `AXRaise`. It refused further engine input. The last native read still found the
  product fixture (window 240864) open on e4. Its save and close remain unverified.
- There's no background hover, since engine events go to the app and the real pointer never moves. The skill covers
  most cases: tooltips are readable as `Help:` text in the UI state, and hover menus usually open through
  an element's secondary actions, a right-click or a key. Mouse-moved events posted to a background app
  arrive, but they don't trigger hover: no enter or exit fired on the probe app's hover area, and a
  GitHub Desktop button looked the same pixel for pixel (2026-10-04). UI that only reacts to a real
  pointer can use sleight's local `hover`. The locked trials on 2026-10-04 support its 1500 ms default.
  Calculator's sidebar tooltip was absent in 1/1 capture at 400 ms and 1/1 at 1000 ms, then readable
  in 1/1 at 1500 ms. Chess's green-button hover menu was visible in 1/1 capture at 400 ms and 1/1
  at 1500 ms in the final trial. These small samples support the default. Exact onset remains unmeasured.
  Successful 1500 ms trials reported 1786 to 1798 ms for takeover. [All attempts](docs/benchmarks/2026-10-04-local-hover.md)
  include the setup and capture failures too. Hover captures screen pixels in the selected window's rectangle.
  A window spanning displays can include another app in that rectangle, as a Chess trial showed.
  The point check does not guard the whole capture. Keep the window within one display and inspect
  screenshots before sharing them. The affected trial's PNGs were withheld after privacy review.
  Chess titles and TextEdit home-folder labels identified the user in published evidence. Those strings
  are now placeholders, and the four affected PNGs were removed. Future hover trials redact text on
  write and omit Chess and TextEdit PNGs. Historical Chess plans need a current title before reuse.
  A tooltip or menu outside the rectangle is clipped. Hover requires Screen Recording permission
  before takeover. It refuses coverage by another app or a different window of the same app;
  do not retry unchanged.
  Cleanup attempts to restore the pointer and front app on ordinary failures; forced helper termination
  can interrupt it. Hover's own pointer and front-app restoration has not been measured separately in
  live trials. The fixture also restores both, so its successful checks do not prove hover's restoration.
  It does not restore the full window order. Earlier fixture pointer mismatches remain unresolved.
- The desktop app's Code tab runs its own Claude Code, 2.1.286 as of 2026-10-03, which is too old
  for the mod. Approvals and every tool work there, and the engine's turn ends after 30 idle seconds.
  The pane, status line and `/sleight stop` don't, so nobody has checked the pane's picture there yet.
  It embeds the screenshot in an SVG, which the terminal doesn't need.
- Without the mod, the relay ends the engine's turn once no sleight call has run for 30 seconds, which
  releases the app the engine was holding (its badge on the app's window). Before 0.3.1 nothing ended
  the turn until the session closed. Desktop sessions twice showed as busy after Claude had finished,
  and ending the turn cleared it once, so the open turn is the likely cause.
  `SLEIGHT_IDLE_TURN_END_MS` changes the wait, and 0 turns it off.
- Change review covers saved files observed before `js` actions. A file first seen after an action
  needs a fresh standalone read before editing. Undo then starts at that later copy.
  Unsaved buffers, Save As targets,
  menu bar and pointer tools have no before copy. Undo changes the saved file, so reopen it before
  editing again. Autosave or a user edit after an action makes undo refuse. Arbitrary JavaScript can
  bypass the window guard or forge headers. [The design](docs/design/change-review.md) lists the limits.
- Flow rules check literals and text values observed earlier. Runtime-built strings, encoded values,
  clipboard shortcuts, screenshots and coordinate drags can pass without a match. Source attribution
  and UI parsing can miss values or block harmless text. This guards mistakes; arbitrary JavaScript
  can bypass it. [The design](docs/design/flow-rules.md) lists the limits.
- After every `js` action, sleight's window guard reads the app again with diffing off and adds that
  full tree to the result, so the input lease can check the window header. The engine alone would
  return a diff. On a busy page that means the whole sidebar after each click, which costs tokens
  and shows Claude more of the screen than the task needs (reported by another Claude session on
  2026-10-05). Filtering in Claude's own code doesn't help, since the guard's read comes after it.
- With input leases, a dialog or sheet the action opened (Open, Save) stops the next action until
  Claude reads the window again. Claude recovers, but textedit-save took about twice the turns.
- TextEdit hung 2/2 when Claude pressed Cmd+Shift+S (Duplicate, in apps with autosave) right after
  setting a document's text. Its main thread waits forever on the document's save lock, so every
  read times out and the relay reports a stuck helper and suggests restarting ChatGPT, when only
  TextEdit needs quitting. The skill now steers Claude to Cmd+S or File > Save As.
- The engine's helper can stop answering. On 2026-10-04 every `cua.getApp` timed out
  (`-10005 timeoutReached`) for about 25 minutes, with the Mac unlocked and in use, until ChatGPT was
  restarted. We don't know the cause. It started right after a test that kills engine processes.
  In 18 completed SIGKILL trials, reads passed before and after cleanup. Killing a responding helper
  relaunched it, but no wedge was reproduced, so helper-only recovery from a wedge remains unproven.
  After two consecutive `timeoutReached` failures on standalone reads of one app, the relay tells
  Claude to stop retrying and ask the user to restart ChatGPT. sleight retries by itself.
  For that app, `js` reads are refused between recovery attempts (at most one every 20 seconds),
  and `js` actions using its known handles are refused until a read succeeds. After hidden recovery,
  actions wait for a visible app read, which sleight makes a full read. Other apps, documentation,
  `js_reset`, and turn cleanup remain available. Inventory failures have their own retry counter.
  App identity comes from literal acquisitions, known handles and learned bundle aliases. Arbitrary
  JavaScript can bypass this advisory check. An app hang can produce the same symptom, so the helper
  diagnosis is provisional.
  Doctor probes inventory, which does not prove that every app's accessibility read works. Before
  0.7.0 it also reported "ok" when the helper couldn't start at all.
  [The investigation](docs/benchmarks/2026-10-04-helper-health.md) records each live attempt.
- The helper can also fail to start. On 2026-10-05 it quit normally when doctor's session ended, and
  every later launch failed with "Sky Computer Use service startup request failed" for at least five
  minutes: launchd still held the old job and answered "Operation already in progress". Removing that
  job with `launchctl remove` fixed it at once, without restarting ChatGPT, and the next four helper
  launches worked. We don't know what left the job behind. Doctor now detects this and prints the
  command.
- ChatGPT updates can break it. The version lookup handles the folder moving around, but not the API
  changing. Run `--doctor` first when something stops working.
- The engine has no access to an app's icon in the menu bar or to notification banners: its inventory has
  no Control Center or Notification Center, and `getApp("com.apple.controlcenter")` times out (engine
  26.930.31730, 2026-10-03). sleight's `menu_bar` and `notifications` tools cover those instead (see
  [How it works](#how-it-works)). They work in the foreground: an open menu shows on screen and takes
  the keyboard until sleight closes it. Icons that open a SwiftUI window (`MenuBarExtra` in window
  style) ignore the accessibility press, so sleight clicks them for real and puts the pointer back.
  Controls without a label, tooltip or identifier get names such as `Button at (10, 20)`, measured
  from the window's top-left corner, or `Button 3` if AX has no position. Their element numbers
  remain the arguments to `press`. The fallback names and press mapping have unit tests; an
  unnamed live popover button has not been checked with an approved app.
- The engine refuses some apps outright ("not allowed … for safety reasons"): terminals (Terminal,
  iTerm2) and OpenAI's own apps (ChatGPT, Codex, Atlas, with their beta builds). The list is built
  into the engine's helper, so no approval changes it. It also respects any app blocks your
  organization sets. To stop Codex asking for approvals, change Codex's own approval setting. With
  your opt-in, sleight can drive these apps through its own Accessibility path (see
  [Driving apps the engine refuses](#driving-apps-the-engine-refuses)); the engine's refusal itself
  stays. On that path, settings refusal checks the window title and the window's toolbar (Terminal
  titles its settings window after the open pane, like "General"), so a localized title and a pane
  name can pass it. Background scroll reaches the app's focused view. System Events' keystroke
  doesn't act on
  an embedded newline in Terminal, so blocked_app sends one Return key press per newline instead.
  The window screenshot needs Screen Recording for the app that runs Claude Code, on top of the
  Accessibility permission `menu_bar` and `drag` already need, and it captures only a window that is
  on screen. In the live check the Codex app's window exposed only its window-control buttons to the
  driver's walk (its UI is web content), so a harmless click there had no target; Claude refused the
  window controls and reported, which is the intended behavior.
- `claude -p` can't answer approval prompts. List apps in the user's [preapproval file](#preapproved-apps)
  before starting. Unlisted apps and requests above their listed risk still need a person.
- The preapproval loader proves file ownership, not who wrote it. Any process running as you,
  Claude included, can write the file. The skill tells Claude never to create or edit it, but this
  rule depends on Claude following the instruction.
- Calculator button indices changed during a [preapproval trial](docs/benchmarks/2026-10-04-preapproved-apps.md),
  producing the wrong expression. A filtered read then lost the window header, and the input lease
  stopped the retry. Use current indices from full UI reads, and preserve their window headers.
- Document scope checks the last observed window before forwarding a call and stops on changed or
  missing Window/URL headers. Its injected action guard checks again, but arbitrary JavaScript can
  bypass it or forge observations. Result checks cannot undo actions already taken. Discovery reads
  can expose other windows' contents, and equal titles without URLs are indistinguishable.
- It's macOS on Apple Silicon only. The engine's JavaScript has Linux and Windows instructions, but
  the helper that clicks and types comes only with the Mac ChatGPT app, and there's no ChatGPT desktop
  app for Linux (checked 2026-10-04). We haven't checked the Windows app.

### Approval scope

Saying yes to an app approval allows that app for the rest of the Claude Code session. Claude Code's
prompt doesn't mention that, but sleight's own panel does.

The engine asks before every action on an app and doesn't remember your answers. In Codex, the app
around the engine remembers "Allow for this session" and answers the repeats. Claude Code's prompt only
has accept and decline, so without help you'd get asked on every click. The relay does the remembering:

- After you accept an app, the relay answers later requests for the same app at the same risk level for
  the rest of the session.
- A different app, a riskier request for the same app, or a new Claude Code session asks you again.
- It never remembers a decline or a cancel.
- Approval memory stays in the relay and ends with the session.

To get asked on every action instead, set `SLEIGHT_APPROVAL_SCOPE=once` in Claude Code's environment.
The `env` block of `~/.claude/settings.json` works.

Set `SLEIGHT_APPROVAL_SCOPE=document` to approve a document or window for the session instead.
First call `js` with only `let app = await cua.getApp("TextEdit")`, then call `document_scope`:
the prompt specifies the observed window
and document URL. A different window stops further actions until you read it and ask the user again;
`drag`, `hover`, `menu_bar`, `notifications` and resets are unavailable in this mode.
`cua.getApp({ windowId: 123 })` does not work on macOS, so it cannot select a document here.
For several windows, call `select_window` with `app` and an exact file `url` or `title`,
then acquire the app and check its full Window and URL before `document_scope`.
`SLEIGHT_SELECT_WINDOW=0` leaves the selection tool out.
This guards mistakes in cooperative code. [The design](docs/design/document-scope.md) lists what
the relay enforces and how arbitrary JavaScript can bypass the checks.

In the desktop app's Code tab, sleight asks with its own prompt instead: a small panel with
sleight's icon, Allow and Don't Allow. It plays a sound and opens on the display under the pointer,
over full-screen apps too. The Code tab (Claude 2.19675.0) declines MCP prompts without
showing them, so a forwarded prompt would always come back as no. Return does nothing in sleight's
panel, Escape means no, and it gives up after five minutes. Session memory works the same way.
`SLEIGHT_APPROVAL_PROMPT=dialog` or `client` overrides the choice.

### Preapproved apps

Write `~/Library/Application Support/sleight/preapproved.json` yourself to allow selected apps without
an approval prompt. This applies to interactive sessions too, including the desktop app's Code tab.
Sample file:

```json
{
  "version": 1,
  "apps": [
    { "app": "com.apple.calculator", "riskLevel": "low" },
    { "app": "Calculator", "riskLevel": "low" }
  ]
}
```

Create the parent folder first and set the file's permissions to `600`. sleight refuses symlinks,
files owned by someone else, and group- or world-writable files. Invalid files stop startup.
It reads this fixed path once at startup. Edits take effect in a new session. No environment variable,
project `settings.json` or plugin setting can select another file or add apps.

App identifiers match exactly, including case. List the bundle ID in the engine's prompt and the name
or path you use with local tools separately. There are no wildcards or inferred aliases.
`riskLevel` is a ceiling: `low`, `medium`, then `high`. Higher, missing or unknown request levels still
ask. `high` accepts every engine approval request for that app at a known risk level.
Local `drag` and `menu_bar` approvals require `high`, since they can move the real
pointer. This list does not approve notifications, document scope, change reviews or flow exceptions,
and it cannot override the engine's app blocks.

The list also applies with `SLEIGHT_APPROVAL_SCOPE=once`. Each grant goes to stderr and a grant audit,
and the tool result tells Claude that the app was pre-approved by the user's list, even if the action
fails. Each relay's audit at `~/Library/Logs/sleight/preapproved-<pid>.jsonl` contains grant fields only.
It rotates at 64 KiB and keeps one prior file per process. Full relay tracing requires explicit `SLEIGHT_TRACE`.
An audit write failure falls back to asking. List grants never send an engine persistence setting.

## Review changes

Set `SLEIGHT_CHANGE_REVIEW=1` to turn this on. It's off by default: with it on, both benchmark tasks that open a
TextEdit file through the Open dialog were refused before editing (0/2 on 2026-10-03 and again on 2026-10-04).
Read the intended window with a standalone `let app = await cua.getApp("TextEdit")` before editing.
For a document with a `file://` URL, sleight saves a private copy before the first possible edit.
Open dialogs and same-app sheets can proceed without a copy. If a file was first seen after an
action, a fresh standalone read takes a later copy, and review shows where undo starts.
Call `review_changes` with `op: "list"` to see text diffs or size/date summaries, or `op: "review"`
to choose Keep, Undo or Later for each document in sleight's prompt. Only your prompt response can
decide. Undo restores the saved copy if the file still matches the last agent action, then you
must reopen it in the app. Snapshots last until the session ends.

## Flow rules

Write `~/Library/Application Support/sleight/flow-rules.json` yourself, outside the project, then set
`SLEIGHT_FLOW_RULES=1` in Claude Code's environment. An absolute path selects another user-owned file.
The relay reads it once before starting. Edits take effect in the next session. A sample file:

```json
{
  "version": 1,
  "rules": [
    { "id": "contacts-mail", "kind": "source", "sources": ["Contacts"], "destinations": ["Mail"] },
    { "id": "ssns", "kind": "pattern", "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b", "destinations": ["*"], "except": ["1Password"] },
    { "id": "cards", "kind": "pattern", "pattern": "\\b(?:\\d[ -]?){13,19}\\b", "destinations": ["*"], "except": ["1Password"] }
  ]
}
```

Rules stop matching literal transfers before forwarding and tell Claude which rule matched.
`flow_exception` shows the exact stopped call for your decision. Allow Once permits one identical
retry. Another call cancels it. Claude cannot grant an exception through tool arguments. Pattern
rules accept optional regex `flags` (i/m/s/u). App names and observed bundle IDs ignore case.
Source rules remember text fields and emitted values, then match exact substrings sent later.
[The design](docs/design/flow-rules.md) explains the gaps in literal checks and source attribution.

## Driving apps the engine refuses

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex,
Atlas, and their beta builds) before any approval prompt. That refusal is OpenAI's code, and sleight
never modifies or wraps it. The `blocked_app` tool is sleight's own. It drives those apps through
macOS Accessibility, the same path as `menu_bar` and `drag`, and its prompt is the whole opt-in.
When Claude reaches a refused app, the relay says so in the result and offers `blocked_app`;
nothing happens until you approve the app, and Allow puts it on the session allowlist like any other
app.

Once you approve, Claude can read the app's window (numbered elements plus a screenshot), click,
type, press keys and scroll in it for the rest of the session. The prompt says what a yes means. For
OpenAI's apps, it says the yes covers clicks in ChatGPT, approval buttons included. A yes for the
session lets Claude answer Codex's approval dialogs by itself. Declines are never remembered.

In a terminal, every key or text that can run a command (any typing, Return, paste, most chords) is
shown to you first, exactly as it will be sent. The prompt offers Allow Once and Don't Allow, like
Claude Code's Bash prompt. Those asks are never remembered and can't be pre-approved. Settings and
preferences windows of these apps are refused, so Claude can't change their own approval or safety
settings. Every action goes through the input leases and flow rules like sleight's other tools, and
is logged to stderr and the trace. Actions that need the app in front (typing, keys, point clicks)
bring it forward, check that the switch worked, and put your front app and pointer back, as `drag`
does.

One limit to keep in mind: the gate is your consent. It does not isolate the app. The engine still
refuses these apps, and its own approvals, badges and background typing don't apply here. sleight's
own code does the driving, with the limits above (Accessibility and Screen Recording permissions
for the app that runs Claude Code, settings refusal by window title, toolbar and foreground typing).
[The design](docs/design/blocked-apps.md) has the details.

### Fewer prompts: let the engine drive them

If a prompt for every terminal command is too much, you can turn off the helper's refusal yourself.
The setting belongs to OpenAI's helper, so Codex loses the refusal too. sleight never sets it.

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

The helper reads it when it starts, and `--doctor` shows whether it's on. Then these apps go
through the engine like any other app, with one approval per app for the session, and Claude types
in the background without bringing the app forward. sleight's prompt tells you that a yes lets
Claude run commands in a terminal for the rest of the session without asking again.

sleight still refuses actions in these apps' settings windows. The relay checks the title of the
window Claude last read against Terminal's pane names (General, Profiles and others) and the words
Settings and Preferences. Like the other window guards, this check runs in cooperative code
and is not a security boundary. To turn the setting back off:

```bash
defaults delete -g ComputerUseAllowForbiddenTargets
```

We tested it live on 2026-10-05 with engine 26.930.31730. Terminal ran an `echo` in the background
2/2 and never came to the front. The prompt included the warning above. An action in Terminal's
settings window was refused 1/1. OpenAI's apps reached the engine's approval prompt instead of its
refusal, but driving them this way is untested. The setting is undocumented, so an engine update
can remove it.

## Safety

- `js` runs JavaScript as you, so treat it like Bash. Claude Code asks before each call unless you allow
  `mcp__plugin_sleight_computer__js`, and allowing it means Claude can send any code without asking.
- Per-app approvals apply however you've set up the `js` tool. An accepted approval lasts for the
  session ([Approval scope](#approval-scope)).
- Foreground `drag` fallback, `hover` and the `menu_bar` fallback for SwiftUI icons move your pointer
  briefly. `drag` refuses points outside the chosen window's visible content; foreground also refuses
  covered endpoints, after bringing the app forward.
  `hover` refuses points another window covers, including
  another window of the same app, and takes about two seconds with the default dwell.
- The repo is small enough to read before you install it. It holds a launcher, a relay, a mod, a skill,
  two manifests and the macOS scripts for the approval panel, menu bar tools, drag and hover.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no Codex computer-use plugin at …` | Computer Use never enabled in ChatGPT | Open ChatGPT → Codex, turn on Computer Use, and run one task |
| `--doctor` shows `MISSING computer-use helper` | The helper app was removed or never installed | Same as above |
| Repeated `timeoutReached`, or doctor reports a stuck helper | The helper stopped answering reads | Stop retries and tell the user. Restarting ChatGPT ends Codex sessions, so only the user should do it |
| Approval prompt never appears | Claude Code too old for form elicitation | Update Claude Code |
| "Not approved" right away in the desktop app, with no panel | The session started before sleight 0.1.1 | Start a new session |
| A desktop session still shows as busy after Claude has finished | Before 0.3.1, nothing ended the engine's turn in the desktop app | Update sleight and start a new session |
| "Sky Computer Use service startup request failed" | macOS kept the helper's old launchd job and won't start a new one | Run `--doctor`; it prints the `launchctl remove` command that clears the job without restarting ChatGPT |
| Tool calls fail after a ChatGPT update | Runtime API changed | Open an issue with the `--doctor` output |

## Benchmark

`bench/` runs each task through headless `claude -p` and checks it outside the agent, against the file
on disk or the exact answer. sleight and LCU get the same prompt for each task, and the prompts
don't mention a tool by name.

Comparison with [LCU](https://github.com/amontlabs/lcu) 0.8.8, which drives the same engine, on
2026-10-03. Each task ran 3 times per arm on Claude Code 2.1.288 and its default model (Opus 5.5).
Each arm ran from an empty folder with only its own tool loaded. Both folders were inside this repo,
though, so both arms also loaded its CLAUDE.md and project memory (found 2026-10-05):

| Task | sleight | LCU | sleight median | LCU median |
|---|---|---|---|---|
| Calculator, clicking | 3/3 | 3/3 | 22 s | 14 s |
| Calculator, Scientific mode via menu | 3/3 | 3/3 | 24 s | 19 s |
| TextEdit, save a new file | 3/3 | 3/3 | 54 s | 63 s |
| TextEdit, edit a file | 3/3 | 3/3 | 34 s | 46 s |
| TextEdit, move a word by drag and drop | 0/3 | 0/3 | 43 s | 43 s |
| Chess, drag a pawn and save the game | 3/3 | 3/3 | 68 s | 75 s |

Both passed 15 of 18 and failed every text drag the same way (see [Known problems](#known-problems)).
That was before sleight's `drag` tool. The local tool passed the text drag task 3/3 before the
window/content guards on 2026-10-04 (Sonnet 5.5,
[`2026-10-04-drag-tool.json`](docs/benchmarks/2026-10-04-drag-tool.json)).
With 3 runs per task, the speed differences are noise. The valid runs came to $16.00 at API prices.
Logged in through a claude.ai plan, runs use plan limits rather than money.

Getting a fair comparison took three tries, and every run is published. In the first (12/15 each,
[`2026-10-03-sleight-vs-lcu.json`](docs/benchmarks/2026-10-03-sleight-vs-lcu.json)) the sleight arm
ran inside this repo and read the project's memory. The Chess runs
([`2026-10-03-chess-drag.json`](docs/benchmarks/2026-10-03-chess-drag.json)) piled up Chess windows
until it hung. Then a user-level sleight install leaked into the LCU arm and failed four of its runs
([`2026-10-03-fair-rerun.json`](docs/benchmarks/2026-10-03-fair-rerun.json) has those and the
rerun). The benchmark now checks before every run that each arm loads only its own tool and runs
from a folder outside any git repo.
LCU warned that this engine version is one it hasn't tested, and so is ours.

The release check for 0.7.0 on 2026-10-05 (Sonnet 5.5, medium) passed 16 of 18 from a clean arm
folder: 3/3 on every task except chess-drag, 1/3. Both Chess failures dragged the pawn to e5
instead of e4, an illegal move, so the board didn't change. textedit-drag passed 3/3 in that pass
and 3/3 in a rerun. Getting there took three earlier passes, which found a helper that wouldn't
launch, two harness problems and the leaking arm folder.
[The write-up](docs/benchmarks/2026-10-05-release-0.7.0.md) has every run.

From 2026-10-04 on, runs default to Sonnet 5.5 at medium effort (`--model`, `--effort`).

```bash
npm run bench -- --runs 3             # sleight only
npm run bench -- --arm all --runs 3   # sleight and LCU
```

The LCU arm needs LCU registered for Claude Code in a separate folder. `bench/run.mjs` has the steps.

> [!WARNING]
> Headless runs can't show approval prompts, so a benchmark run auto-approves Calculator, TextEdit and
> Chess for either arm, and sleight's `drag` and `hover` in those apps (`bench/approve.mjs`, loaded only through
> `bench/settings.json`). Only run it when you're fine with Claude driving those three apps unattended. `--dry-run` checks the setup without
> launching Claude.

## Update watch

`scripts/watch.sh` runs `--doctor` and saves the engine's runtime API docs to
`~/Library/Logs/sleight/engine-api-<version>.md`, declining the app approval during capture.
When the version changes, it writes `engine-api-<version>.diff` against the previous snapshot and runs
one benchmark task, with the diff path in the macOS notification (the first run saves a baseline).
It logs to `~/Library/Logs/sleight/watch.log` and also notifies when a check fails; an older watch
without a previous snapshot reports that the diff is unavailable.

```bash
npm run watch            # check now
npm run watch:install    # run it every Monday at 9:00 (a launchd job)
npm run watch:remove     # remove the job
```

The benchmark task auto-approves Calculator, like any benchmark run.

## Development

```bash
npm test               # relay unit tests
npm run validate       # claude plugin validate, marketplace and plugin
npm run test:mod       # the mod's tests, against the engine (claude plugin test)
npm run typecheck      # needs the types Claude Code writes when it loads the mod
npm run lint:prose     # Vale with the ai-tells style pack, over the docs
SLEIGHT_TRACE=1 claude --plugin-dir plugins/sleight   # logs every relayed message to ~/Library/Logs/sleight/
```

## Roadmap

- [x] MCP server that survives ChatGPT updates
- [x] Session and turn ids, so the engine can scope approvals and cleanup
- [x] Approvals that last for the session, as in Codex
- [x] Hide or block the engine's internal tools for Claude
- [x] A skill that tells Claude when to use sleight and when to fall back to a pointer-moving tool
- [x] Per-turn cleanup through the mod's `turn.complete` hook
- [x] Live pane with the app's latest picture and an action log
- [x] Status line entry and `/sleight stop`
- [x] Hover workarounds in the skill
- [x] A reproducible task benchmark
- [x] Weekly update watch
- [x] Approvals in the desktop app's Code tab, through sleight's own panel
- [x] Menu bar icons and notification banners, which the engine leaves out
- [x] A fair benchmark against LCU, with each arm checked to load only its own tool
- [x] Text drags: a drag of sleight's own that holds the mouse down and moves in steps
- [x] TextEdit drags in the background, with verified text readback and foreground fallback
- [ ] The pane, status line and `/sleight stop` in the desktop app, once its Claude Code reaches 2.1.287
- [ ] Windows, if the ChatGPT app there includes the computer-use helper (unchecked)
- [x] Approve one document instead of a whole app (`SLEIGHT_APPROVAL_SCOPE=document`, a guard against
  mistakes rather than a security boundary)
- [x] Review saved-file changes and choose Keep or Undo through a user prompt
- [ ] Review unsaved changes and app state without backing files
- [x] Rules for what data may move from one app to another (`SLEIGHT_FLOW_RULES=1`, a guard against
  mistakes rather than a security boundary)

## Credits

- [@argofowl](https://x.com/argofowl) showed that the ChatGPT app's computer-use server works outside Codex.
- [LCU](https://github.com/amontlabs/lcu), started by 0xpolarzero, takes the same idea across several harnesses, and its notes mapped out how the runtime's lifecycle works.
- The icon started as an image from ChatGPT's image generation.

## License

[MIT](LICENSE). The ChatGPT app and its computer-use runtime belong to OpenAI, under OpenAI's terms.
sleight doesn't include or redistribute either.
