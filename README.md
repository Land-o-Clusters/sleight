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

<p align="center"><img src="docs/assets/demo.gif" width="900" alt="Claude playing macOS Chess against the computer through sleight, with the sleight pane logging each move"></p>
<p align="center"><sub>Claude plays macOS Chess against the computer through sleight, at 6× speed. Every move is a drag. The sleight pane on the right logs each one.</sub></p>

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

`--doctor` prints the engine version it found and checks every file it needs. Then try:

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

## Watch and stop it

The apps sleight drives stay in the background, which also means you can't see them. On Claude Code
v2.1.287 or later you get three ways to keep an eye on things.

`/sleight` opens a pane with the app's latest picture and a log of every action Claude took. Anything
after it goes to Claude as a prompt, so `/sleight play chess in the background` opens the pane and starts
the task. The picture
refreshes after each turn that used sleight, or when you press Refresh (`r`) while Claude is idle. A
terminal draws it in colored half-blocks. The desktop app's Code tab shows the screenshot itself.

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
5. `lib/relay.mjs` sits between Claude Code and the server and fills in what Codex would have sent: a
   session and turn id on each call, session memory for approvals you accepted, and a `turn_ended` call
   when the session closes. It hides `js_add_node_module_dir` from Claude and marks `turn_ended` as
   internal. It also answers a protocol probe from newer Claude Code versions that would otherwise
   crash the server.
6. On Claude Code v2.1.287 or later, the mod (`hooks/register.tsx`) ends the engine's turn after each
   Claude turn that used it, the way Codex does, and refuses Claude's own calls to `turn_ended`.

sleight only turns on native apps by default (`CUA_REPL_ENABLED_SURFACES=computer`), because the engine's
in-app browser only exists inside ChatGPT. To try Chrome control, which needs the Codex Chrome
extension, set `SLEIGHT_SURFACES=browser,computer` in the plugin's environment.

## Known problems

- Anything moving your real pointer in the app interrupts it. The engine watches real mouse and keyboard
  input to notice a person taking over, then makes Claude re-read the app. Another agent driving in the
  foreground counts too. Background sessions can share the engine's helper fine (two sleight sessions, or
  sleight next to Codex). In one test where Codex was also driving in the foreground, keystrokes typed
  during the run showed up twice, and we still don't know why.
- Dragging selected text doesn't move it. The engine's drag on macOS presses, moves and releases at
  once, and text views like TextEdit's only start a text drag after the mouse is held down for a
  moment, so they read it as a new selection. LCU fails the same way. Launching TextEdit with
  `-NSDragAndDropTextDelay 0` didn't help (0/2), and we don't know whether the engine's drag sends
  any mouse-drag events between press and release. Drags that pick something up right away, like
  Chess pieces, work. To move text, use cut and paste.
- There's no real hover, since events go to the app and the real pointer never moves. The skill covers
  most cases: tooltips are readable as `Help:` text in the UI state, and hover menus usually open through
  an element's secondary actions, a right-click or a key. UI that only reacts to a real pointer needs a
  pointer-moving tool.
- The desktop app's Code tab runs its own Claude Code, 2.1.286 as of 2026-10-03, which is too old
  for the mod. There you get approvals and the `js` tool, but no pane, status line, `/sleight stop`
  or per-turn cleanup.
- Nobody has checked the pane's picture in the desktop app's Code tab yet. It embeds the screenshot in an
  SVG there, which the terminal doesn't need.
- Per-turn cleanup needs Claude Code v2.1.287 or later. Without the mod, the engine's turn only ends when
  the session closes.
- ChatGPT updates can break it. The version lookup handles the folder moving around, but not the API
  changing. Run `--doctor` first when something stops working.
- The engine refuses terminal apps such as Terminal.app ("not allowed … for safety reasons") and respects
  any app blocks your organization sets.
- `claude -p` can't answer approval prompts, so headless runs only get apps already approved in that
  session.
- It's macOS on Apple Silicon only. The engine has Linux and Windows builds, but sleight hasn't been
  tested on either.

### Approval scope

Saying yes to an app approval allows that app for the rest of the Claude Code session. The prompt itself
doesn't mention that.

The engine asks before every action on an app and doesn't remember your answers. In Codex, the app
around the engine remembers "Allow for this session" and answers the repeats. Claude Code's prompt only
has accept and decline, so without help you'd get asked on every click. The relay does the remembering:

- After you accept an app, the relay answers later requests for the same app at the same risk level for
  the rest of the session.
- A different app, a riskier request for the same app, or a new Claude Code session asks you again.
- It never remembers a decline or a cancel.
- The relay doesn't write anything to disk. The memory ends with the session.

To get asked on every action instead, set `SLEIGHT_APPROVAL_SCOPE=once` in Claude Code's environment.
The `env` block of `~/.claude/settings.json` works.

In the desktop app's Code tab, sleight asks with its own prompt instead: a small panel with
sleight's icon, Allow and Don't Allow. The Code tab (Claude 2.19675.0) declines MCP prompts without
showing them, so a forwarded prompt would always come back as no. Return does nothing in sleight's
panel, Escape means no, and it gives up after five minutes. Session memory works the same way.
`SLEIGHT_APPROVAL_PROMPT=dialog` or `client` overrides the choice.

## Safety

- `js` runs JavaScript as you, so treat it like Bash. Claude Code asks before each call unless you allow
  `mcp__plugin_sleight_computer__js`, and allowing it means Claude can send any code without asking.
- Per-app approvals apply however you've set up the `js` tool. An accepted approval lasts for the
  session ([Approval scope](#approval-scope)).
- The repo is small enough to read before you install it. It's a launcher and a relay, plus a mod, a
  skill and two manifests.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no Codex computer-use plugin at …` | Computer Use never enabled in ChatGPT | Open ChatGPT → Codex, turn on Computer Use, and run one task |
| `--doctor` shows `MISSING computer-use helper` | The helper app was removed or never installed | Same as above |
| Approval prompt never appears | Claude Code too old for form elicitation | Update Claude Code |
| Tool calls fail after a ChatGPT update | Runtime API changed | Open an issue with the `--doctor` output |

## Benchmark

`bench/` runs each task through headless `claude -p` and checks it outside the agent, against the file
on disk or the exact answer. sleight and LCU get the same prompt for each task, and the prompts
don't mention a tool by name.

Comparison with [LCU](https://github.com/0xpolarzero/lcu) 0.8.8, which drives the same engine, on
2026-10-03, with each task run 3 times per arm, the arms alternating, on Claude Code 2.1.288 and its
default model:

| Task | sleight | LCU | sleight median | LCU median |
|---|---|---|---|---|
| Calculator, clicking | 3/3 | 3/3 | 14 s | 15 s |
| Calculator, Scientific mode via menu | 3/3 | 3/3 | 19 s | 23 s |
| TextEdit, save a new file | 3/3 | 3/3 | 75 s | 70 s |
| TextEdit, edit a file | 3/3 | 3/3 | 21 s | 31 s |
| TextEdit, move a word by drag and drop | 0/3 | 0/3 | 53 s | 45 s |

Both passed 12 of 15 and failed every drag run the same way (see [Known problems](#known-problems)).
The speed differences come from three runs on one Mac, so treat them as noise until more runs say
otherwise. The 30 runs cost $12.90 in all. Every run is in
[`docs/benchmarks/2026-10-03-sleight-vs-lcu.json`](docs/benchmarks/2026-10-03-sleight-vs-lcu.json).
LCU warned that this engine version is one it hasn't tested, and so is ours.

```bash
npm run bench -- --runs 3             # sleight only
npm run bench -- --arm all --runs 3   # sleight and LCU
```

The LCU arm needs LCU registered for Claude Code in a separate folder. `bench/run.mjs` has the steps.

> [!WARNING]
> Headless runs can't show approval prompts, so a benchmark run auto-approves Calculator and TextEdit
> for either arm (`bench/approve.mjs`, loaded only through `bench/settings.json`). Only run it when
> you're fine with Claude driving those two apps unattended. `--dry-run` checks the setup without
> launching Claude.

## Update watch

A ChatGPT update can change the engine under sleight at any time. `scripts/watch.sh` checks for that:
it runs `--doctor`, and when the engine version differs from the last run, it runs one benchmark task.
It logs to `~/Library/Logs/sleight/watch.log` and posts a macOS notification when something fails or
the engine changed.

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
- [ ] Check the pane's picture in the desktop app's Code tab

## Credits

- [@argofowl](https://x.com/argofowl) showed that the ChatGPT app's computer-use server works outside Codex.
- [LCU](https://github.com/0xpolarzero/lcu) by 0xpolarzero takes the same idea across several harnesses, and its notes mapped out how the runtime's lifecycle works.
- The icon started as an image from ChatGPT's image generation.

## License

[MIT](LICENSE). The ChatGPT app and its computer-use runtime belong to OpenAI, under OpenAI's terms.
sleight doesn't include or redistribute either.
