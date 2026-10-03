<h1 align="center">undertow</h1>
<p align="center"><strong>Let Claude Code drive your Mac apps in the background, without taking your cursor.</strong></p>
<p align="center">A Claude Code plugin that connects Claude to the computer-use engine bundled with the ChatGPT desktop app.</p>

<p align="center">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-E8622C">
  <img alt="platform macOS Apple Silicon" src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-3E4A56">
  <img alt="status unofficial, early" src="https://img.shields.io/badge/status-unofficial%2C%20early-3E4A56">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#watch-and-stop-it">Watch and stop it</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-is-still-wrong">What is still wrong</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#benchmark">Benchmark</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

> [!IMPORTANT]
> **Unofficial.** undertow is not affiliated with, endorsed by, or supported by OpenAI or Anthropic.
> It drives an undocumented runtime that ships inside the ChatGPT app, and any ChatGPT update can break it.
> It contains no OpenAI code: it starts the copy already installed on your Mac.

Most computer-use tools take over your screen: the pointer moves, windows jump to the front, and you
wait. The engine inside the ChatGPT desktop app works differently. It sends clicks, drags and keystrokes
straight to the target app, so the app can sit behind your other windows while you keep working.

undertow lets Claude Code use that engine. Claude writes short JavaScript against the engine's API
(`cua.getApp("Calculator")`, `app.click(...)`, `app.getScreenshot()`), and the engine does the rest.

## Install

### Requirements

- macOS on Apple Silicon
- [ChatGPT desktop app](https://chatgpt.com/download/), with **Computer Use** turned on in Codex at least once.
  That first run installs the engine's helper and asks macOS for Accessibility and Screen Recording access.
  You don't need to stay signed in to Codex afterwards.
- Claude Code v2.1.275 or later. The pane, status line, `/undertow stop` and per-turn cleanup are a
  [mod](https://code.claude.com/docs/en/plugins/mods/overview) and need v2.1.287 or later; on older
  versions undertow still works without them.

### Add the plugin

In a Claude Code session:

```text
/plugin install undertow --marketplace Land-o-Clusters/undertow
```

Or from your shell:

```bash
claude plugin marketplace add Land-o-Clusters/undertow
```

```bash
claude plugin install undertow@undertow
```

Run `/reload-plugins` in any open session, or start a new one.

### Check it

```bash
~/.claude/plugins/marketplaces/undertow/plugins/undertow/bin/undertow-mcp --doctor
```

`--doctor` prints the engine version it found and checks each file it needs. Then ask Claude:

```text
Use undertow to open Calculator in the background and work out 12 × 12 by clicking its buttons.
```

The first time Claude touches an app, you'll get a prompt like **Allow Computer Use to use "Calculator"?**
That prompt comes from the engine itself. Accepting it allows that app for the rest of the session; see
[Approval scope](#approval-scope).

### Updating

Third-party marketplaces don't auto-update by default. To update:

```bash
claude plugin marketplace update undertow
```

```bash
claude plugin update undertow@undertow
```

Or turn on auto-update for the `undertow` marketplace in `/plugin` → **Marketplaces**.

## Watch and stop it

Apps undertow drives stay in the background, so you can't watch them directly. On Claude Code v2.1.287
or later:

- **`/undertow`** opens a pane with the app's latest picture and a log of each action Claude took.
  The picture refreshes after each turn that used undertow, or when you press **Refresh** (`r`) while
  Claude is idle. In a terminal it's drawn in colored half-blocks; in the desktop app's Code tab it's
  the screenshot itself.
- **The status line** shows the app and how many actions Claude has taken.
- **`/undertow stop`**, or **Stop** (`s`) in the pane, ends the engine's turn and refuses any further
  undertow call until your next message. It works mid-turn. Press Esc as well to stop the rest of
  Claude's turn.

The pane never snapshots while Claude is working, because the engine reports UI changes as a diff
against the latest read of an app, whoever made it. After the pane reads an app, your next message
tells Claude to take a full read before trusting a diff.

## How it works

```
Claude Code ──MCP──▶ bin/undertow-mcp ──▶ ChatGPT.app's cua-repl server ──▶ native helper ──▶ your apps
```

1. The ChatGPT app writes its computer-use server config to
   `~/.codex/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`,
   and replaces that folder on almost every update.
2. `bin/undertow-mcp` runs with the Node that ships inside ChatGPT.app, finds the newest version folder,
   and starts the server it describes. A hard-coded path would break within days; this one follows
   the updates.
3. The server exposes a persistent JavaScript tool, `js`. Its first call returns the full API
   documentation for the installed version, so Claude always learns the current API.
4. Per-app approvals go through MCP form elicitation, which Claude Code shows as a normal prompt.
5. Between the two, `lib/relay.mjs` adds what Codex would send and Claude Code doesn't: a session and
   turn id on each call, the session scope on accepted app approvals, and a `turn_ended` call when the
   session closes. It also keeps the engine's internal tools (`turn_ended`, `js_add_node_module_dir`)
   out of Claude's tool list.
6. On Claude Code v2.1.287 or later, the plugin's mod (`hooks/register.ts`) also ends the engine's turn
   after each Claude turn that used it, as Codex does.

By default undertow turns on native apps only (`CUA_REPL_ENABLED_SURFACES=computer`). The engine's
in-app browser only exists inside ChatGPT. Set `UNDERTOW_SURFACES=browser,computer` in the plugin's
environment to try the Chrome surface, which needs the Codex Chrome extension.

## What is still wrong

- **Foreground pointer activity interrupts it.** The engine watches real mouse and keyboard input to
  notice a person taking over an app, and asks Claude to re-read the app when it does. Anything moving
  the real pointer in that app counts, including another agent driving in the foreground. Several
  background sessions (two undertow sessions, or undertow and Codex) can share the engine's helper at
  once. In one test with Codex driving the foreground at the same time, keystrokes typed during the run
  arrived twice. We haven't pinned down why.
- **No real hover.** The engine sends events to the app, not through the real pointer. The skill teaches
  Claude the workarounds: tooltips are readable as `Help:` text in the UI state, hover menus usually open
  through an element's secondary actions, a right-click or a key. Only truly pointer-driven UI needs a
  pointer-moving tool.
- **The desktop app's pane picture is unverified.** It embeds the screenshot in an SVG, which the
  terminal pane doesn't need; it hasn't been checked in the desktop app's Code tab yet.
- **Per-turn cleanup needs Claude Code v2.1.287 or later.** The mod ends the engine's turn after each
  Claude turn. On older versions there is no mod, so turns end only when the session closes.
- **ChatGPT updates can break it.** The runtime is undocumented. The version lookup handles the
  folder changing; it can't handle the API changing. Run `--doctor` first when something stops working.
- **Some apps are off limits.** The engine refuses terminal apps such as Terminal.app ("not allowed …
  for safety reasons"), and honors any app blocks your organization sets.
- **`claude -p` can't answer approval prompts**, so headless runs can only use apps already approved
  for that session.
- **macOS on Apple Silicon only.** The engine has Linux and Windows builds, but undertow has only been
  tested on macOS.

### Approval scope

**Accepting an app approval allows that app for the rest of the Claude Code session.** The prompt
doesn't say so, so here it is plainly.

The engine asks before every action on an app and doesn't remember answers for a session itself. In
Codex, the host app remembers "Allow for this session" and answers the repeats. Claude Code's prompt can
only accept or decline, so without help you'd be asked on every click. undertow's relay plays the
host's part:

- Once you accept an app, the relay answers later requests for **the same app at the same risk level**
  for the rest of the session.
- A different app, a riskier request for the same app, or a new Claude Code session asks you again.
- Declines and cancels are never remembered.
- Nothing is written to disk. The memory ends with the session.

To be asked on every action instead, set `UNDERTOW_APPROVAL_SCOPE=once` in Claude Code's environment,
for example in the `env` block of `~/.claude/settings.json`.

## Safety

- **`js` runs JavaScript as you.** Treat it like Bash: Claude Code asks before each call unless you allow
  `mcp__plugin_undertow_computer__js`. Allowing it means no more prompts for any code Claude sends.
- **Per-app approvals still apply.** The engine asks before touching each app, however the `js` tool is
  allowed. An accepted approval lasts for the session ([Approval scope](#approval-scope)).
- **Read before you install.** This repository is small on purpose: a launcher, a relay, a mod, a skill
  and two manifests.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no Codex computer-use plugin at …` | Computer Use never enabled in ChatGPT | Open ChatGPT → Codex, turn on Computer Use, and run one task |
| `--doctor` shows `MISSING computer-use helper` | The helper app was removed or never installed | Same as above |
| Approval prompt never appears | Claude Code too old for form elicitation | Update Claude Code |
| Tool calls fail after a ChatGPT update | Runtime API changed | Open an issue with the `--doctor` output |

## Benchmark

`bench/` holds a small task suite: two Calculator tasks (clicking, a menu) and two TextEdit tasks (save a
new file, edit an existing one). Each runs through headless `claude -p` and is checked outside the
agent, by the file on disk or the exact answer.

```bash
npm run bench -- --runs 3
```

> [!WARNING]
> Headless runs can't show approval prompts, so a benchmark run **auto-approves Calculator and
> TextEdit** for undertow (`bench/approve.mjs`, used only through `bench/settings.json`). Run it only
> when you're fine with Claude driving those two apps unattended. `--dry-run` checks the setup without
> launching Claude.

Results go to `bench/results/`. Comparing other computer-use tools on the same tasks means adding
their MCP configuration as another arm; that isn't built yet.

## Development

```bash
npm test               # relay unit tests
npm run validate       # claude plugin validate, marketplace and plugin
npm run test:mod       # the mod's tests, against the engine (claude plugin test)
npm run typecheck      # needs the types Claude Code writes when it loads the mod
UNDERTOW_TRACE=1 claude --plugin-dir plugins/undertow   # logs every relayed message to ~/Library/Logs/undertow/
```

## Roadmap

- [x] MCP server that survives ChatGPT updates
- [x] Session and turn ids, so the engine can scope approvals and cleanup
- [x] Approvals that last for the session, as in Codex
- [x] Hide the engine's internal tools (`turn_ended`, `js_add_node_module_dir`) from Claude
- [x] A skill that tells Claude when to use undertow and when to fall back to a pointer-moving tool
- [x] Per-turn cleanup through the mod's `turn.complete` hook
- [x] Live pane with the app's latest picture and an action log
- [x] Status line entry and `/undertow stop`
- [x] Hover workarounds in the skill
- [x] A reproducible task benchmark
- [ ] Benchmark arms for other computer-use tools
- [ ] Check the pane's picture in the desktop app's Code tab

## Credits

- [@argofowl](https://x.com/argofowl) for showing that the ChatGPT app's computer-use server works outside Codex.
- [LCU](https://github.com/0xpolarzero/lcu) by 0xpolarzero, a multi-harness take on the same idea, for mapping how the runtime's lifecycle works.

## License

[MIT](LICENSE). The ChatGPT app and its computer-use runtime are OpenAI's and keep their own terms;
undertow doesn't include or redistribute them.
