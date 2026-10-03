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
  <a href="#how-it-works">How it works</a> ·
  <a href="#what-is-still-wrong">What is still wrong</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
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
- Claude Code v2.1.275 or later. Later releases add a live view of what the engine is doing (see [Roadmap](#roadmap)); those need v2.1.287 or later.

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
That prompt comes from the engine itself, once per app per session.

### Updating

Third-party marketplaces don't auto-update by default. To update:

```bash
claude plugin marketplace update undertow
```

```bash
claude plugin update undertow@undertow
```

Or turn on auto-update for the `undertow` marketplace in `/plugin` → **Marketplaces**.

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
- **No hover.** The engine sends events to the app, not through the real pointer, so hover-only UI
  (tooltips, hover menus) never sees a pointer. Use a pointer-moving computer-use tool for those.
- **No end-of-turn cleanup yet.** In Codex, the end of each turn tells the engine to release the apps
  it was using. undertow doesn't send that signal yet, so the engine can hold an app between turns.
  This is the next thing on the roadmap.
- **ChatGPT updates can break it.** The runtime is undocumented. The version lookup handles the
  folder changing; it can't handle the API changing. Run `--doctor` first when something stops working.
- **Some apps are off limits.** The engine refuses terminal apps such as Terminal.app ("not allowed …
  for safety reasons"), and honors any app blocks your organization sets.
- **Approvals repeat on every action.** Claude Code's prompt can only accept or decline, so the engine
  treats each accept as one-time and asks again on the next click. Codex avoids this by sending a
  "for this session" choice. See [the open question](#open-question-approval-scope).
- **`claude -p` can't answer approval prompts**, so headless runs can only use apps already approved
  for that session.
- **macOS on Apple Silicon only.** The engine has Linux and Windows builds, but undertow has only been
  tested on macOS.

### Open question: approval scope

The engine remembers an approval for the rest of a session only when the answer says so
(`_meta.persist: "session"`), which Claude Code's prompt can't express. The relay could add that field
whenever you click Accept on a computer-use approval, so each app is approved once per Claude session,
as in Codex. The cost is that Accept then silently means "for this session". This is undecided; it would
ship as an opt-in setting, not a default, if at all.

## Safety

- **`js` runs JavaScript as you.** Treat it like Bash: Claude Code asks before each call unless you allow
  `mcp__plugin_undertow_computer__js`. Allowing it means no more prompts for any code Claude sends.
- **Per-app approvals still apply.** The engine asks before touching each app, however the `js` tool is allowed.
- **Read before you install.** This repository is small on purpose: one shell script, one Node file,
  two manifests.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `no Codex computer-use plugin at …` | Computer Use never enabled in ChatGPT | Open ChatGPT → Codex, turn on Computer Use, and run one task |
| `--doctor` shows `MISSING computer-use helper` | The helper app was removed or never installed | Same as above |
| Approval prompt never appears | Claude Code too old for form elicitation | Update Claude Code |
| Tool calls fail after a ChatGPT update | Runtime API changed | Open an issue with the `--doctor` output |

## Roadmap

- [x] MCP server that survives ChatGPT updates
- [ ] End-of-turn cleanup through a mod `turn.complete` hook (Claude Code v2.1.287+)
- [ ] Hide the engine's internal tools (`turn_ended`, `js_add_node_module_dir`) from Claude
- [ ] Live pane showing the engine's latest screenshot and actions, since you can't see apps it drives in the background
- [ ] Status line entry and `/undertow stop`
- [ ] A skill that tells Claude when to use undertow and when to fall back to a pointer-moving tool
- [ ] A reproducible task benchmark against other computer-use tools

## Credits

- [@argofowl](https://x.com/argofowl) for showing that the ChatGPT app's computer-use server works outside Codex.
- [LCU](https://github.com/0xpolarzero/lcu) by 0xpolarzero, a multi-harness take on the same idea, for mapping how the runtime's lifecycle works.

## License

[MIT](LICENSE). The ChatGPT app and its computer-use runtime are OpenAI's and keep their own terms;
undertow doesn't include or redistribute them.
