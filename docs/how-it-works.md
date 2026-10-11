# How it works

```
Claude Code ──MCP──▶ bin/sleight-mcp ──▶ ChatGPT.app's cua-repl server ──▶ native helper ──▶ your apps
```

1. The ChatGPT app writes its computer-use server config to
   `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`, and replaces that
   folder on almost every update.
2. `bin/sleight-mcp` runs on the Node runtime bundled in ChatGPT.app, finds the newest version folder and
   starts the server described there. A hard-coded path would break within days.
3. The server has one main tool, `js`, a persistent JavaScript session. Its first call returns the API
   docs for whichever engine version is installed, so Claude always gets the current API. The relay
   adds sleight's skill to that result, so Claude learns sleight's rules in a turn it pays for anyway,
   and marks `js` to load at session start instead of behind Claude Code's tool search. Claude no
   longer invokes the skill itself; `/sleight:drive-mac-apps` still shows it.
4. Per-app approvals arrive as MCP form elicitations, which Claude Code shows as an ordinary prompt.
   The desktop app's Code tab gets sleight's own panel instead (`lib/ask.js`, see
   [Approval scope](settings.md#approval-scope)).
5. `lib/relay.mjs` sits between Claude Code and the server and fills in what Codex would have sent: a
   session and turn id on each call, session memory for approvals you accepted, the rewritten
   first-call description ([first-call batching](settings.md#first-call-batching)), and a `turn_ended`
   call after 30 idle seconds and when the session closes. It hides `js_add_node_module_dir` from
   Claude and marks `turn_ended` as internal. It also answers a protocol probe from newer Claude Code
   versions that would otherwise crash the server.
6. On Claude Code v2.1.287 or later, the mod (`hooks/register.tsx`) ends the engine's turn after each
   Claude turn that used it, the way Codex does, even when Claude Code's pane list fails, and refuses
   Claude's own calls to `turn_ended`.
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
   `SLEIGHT_HOVER=0` leaves it out. [Design and checks](design/hover.md) lists its limits.

### Browser surface

Startup uses `computer` unless a cached discovery result less than six hours old reports a connected
extension. A negative result lasts 24 hours. An engine started from ChatGPT.app, when there's no
Codex plugin, stays `computer`-only: the browser API needs a Codex sign-in. After the engine's
first call answers (or 60 s without one), background discovery refreshes the cache for the next
session. `SLEIGHT_SURFACES` overrides this choice: use `computer` or `browser,computer`
([settings](settings.md#browser-surface)). Automatic mode excludes the in-app browser, which needs
ChatGPT host context. Doctor still probes extension availability separately.

Use `cua.listBrowsers()`, select by `metadata.extensionInstanceId`, then open the URL with
`cua.createBrowserTab(browser.browserId, url)`. Helium and Chrome can both report as Chrome.
Browser requests go through sleight's approval prompts. The relay never preapproves them.

In the final live run on 2026-10-04, engine 26.930.31730 opened Example Domain and clicked Learn more
in 2/2 trials, one in Chrome and one in Helium, and `turn_ended` removed both tabs.
[The attempts file](benchmarks/2026-10-04-browser-surface.json) records the detection and routing
failures before that run.
