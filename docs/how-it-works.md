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
   docs for whichever engine version is installed, so Claude always gets the current API.
4. Per-app approvals arrive as MCP form elicitations, which Claude Code shows as an ordinary prompt.
   The desktop app's Code tab gets sleight's own panel instead (`lib/ask.js`, see
   [Approval scope](settings.md#approval-scope)).
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
   `SLEIGHT_HOVER=0` leaves it out. [Design and checks](design/hover.md) lists its limits.

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
[Every attempt](benchmarks/2026-10-04-browser-surface.json) includes detection and routing failures.
