# Installing sleight

Coding agents: [read Agent notes first](#agent-notes).

## Installing it yourself

Install the ChatGPT app first, then use the section for your coding agent. Run the doctor, run setup if it asks,
allow the macOS permissions, and start a new agent session. If Computer Use is already on in ChatGPT or Codex, skip setup.
`installPath` means the installed sleight plugin folder, reported by your host's plugin listing.
`setup` runs OpenAI's helper installer and opens Accessibility and Screen Recording for your approval.

The [install validation limits](README.md#install-validation) apply here. Setup asks for an administrator's password or
Touch ID, and Chrome's browser connection needs its debugging switch and your consent, so you need to be at the Mac.

sleight is MIT-licensed and uses your coding agent's account or API access. It doesn't need a ChatGPT account or separate
Codex sign-in. Typical task cost, install disk use, background CPU and operation with ChatGPT's UI quit remain unmeasured.

## Agent notes

If you're installing for someone else, follow the host's commands below and stop for these user steps:

- typing an administrator's password or Touch ID during `sleight-mcp setup`,
- allowing Codex Computer Use under Accessibility and Screen Recording in System Settings,
- clicking Allow or Always allow on the first approval card for each app,
- turning on Chrome's remote debugging at `chrome://inspect/#remote-debugging` and allowing Chrome's prompt, for turbo.

At each step, tell the user what to do and wait. End with the steps that remain for the user, the first approval card for
each app included. Don't run `sudo` or `sleight-mcp setup`, and don't script System Settings
or work around a prompt or approval card. Run each command below on its own. You may inspect setup with `--dry-run`.

Always allow, payment and sleight consent buttons accept only a person's click or key press. VoiceOver, Switch Control,
Voice Control and screen-sharing users need a physical keyboard or pointer for these cards.
See [accessibility limits and the planned alternative](docs/known-problems.md#protected-consent-input).

## Requirements

- macOS on Apple Silicon. We've tested on macOS 27 and haven't measured a minimum version. Intel builds are untested.
- The [ChatGPT desktop app](https://chatgpt.com/download/) in `/Applications`. It holds the engine.
- Claude Code 2.1.288 or later, Codex CLI (tested on 0.160.0), Cursor, Grok CLI or another stdio MCP client.
- Grok Bot uses its local shell on this Mac, through the route below, and needs Apple's clang from Xcode Command Line Tools.

sleight runs on the Node runtime inside ChatGPT, so there's nothing to install with npm.

## Claude Code

```bash
claude --version
claude plugin marketplace add Land-o-Clusters/sleight
claude plugin install sleight@sleight
```

The version must be 2.1.288 or later. Print the installed plugin listing:

```bash
claude plugin list --json
```

Copy the `sleight@sleight` entry's `installPath` without surrounding quotes, then append `/bin/sleight-mcp`.
If it is `/Users/you/.claude/plugins/cache/sleight/sleight/1.4.0`, run:

```bash
"/Users/you/.claude/plugins/cache/sleight/sleight/1.4.0/bin/sleight-mcp" --doctor
```

To put `sleight` on PATH, run this in your own terminal and answer yes:

```bash
"<installPath>/bin/sleight-mcp" link
```

It creates `~/.local/bin/sleight`, linked to a private `.sleight-shim-v1` file beside it. If that folder is missing from PATH, the command prints the line to add yourself;
it never edits shell startup files. The shim follows the current `sleight@sleight` install after plugin updates and falls
back to the install that created it if the record is missing. `sleight unlink` removes only the shim sleight made.
Run `sleight menu` for settings without a session, then choose Quit Menu to close it. The first use compiles the menu host.
The menu runs without a computer-use engine or cursor overlay. See [settings commands](docs/settings.md#commands-you-run-yourself).

Start a new Claude Code session so the plugin loads.

## Codex

```bash
codex plugin marketplace add Land-o-Clusters/sleight
codex plugin add sleight@sleight
```

In `codex plugin list --json`, use `version` from the `installed` entry whose `pluginId` is `sleight@sleight`.
Codex keeps the plugin under its home folder, `$CODEX_HOME`
(`~/.codex` when the variable isn't set). Run the doctor from there, with the version filled in:

```bash
codex plugin list --json
"${CODEX_HOME:-$HOME/.codex}/plugins/cache/sleight/sleight/<version>/bin/sleight-mcp" --doctor
```

Start a new Codex session from a project folder and trust sleight's three hooks when Codex asks.
See [other hosts](docs/other-hosts.md#codex) for the differences in Codex.

## Cursor

The 1.4.0 Cursor plugin needs a signed-in cursor-agent 2026.09.10 or later. Its marketplace install has not run live:

```bash
cursor-agent plugin marketplace add https://github.com/Land-o-Clusters/sleight
```

Install sleight from `/plugins` in cursor-agent, or from Customize in the Cursor app, and start a new chat.
Check it from Cursor's plugin cache, where the last folder is the commit Cursor installed. The doctor's Cursor section
lists each route it finds and warns when Cursor would start sleight twice ([Cursor](docs/other-hosts.md#cursor)):

```bash
ls -d ~/.cursor/plugins/cache/sleight/sleight/*/
~/.cursor/plugins/cache/sleight/sleight/<commit>/bin/sleight-mcp --doctor
```

Use the commit folder for the active sleight entry in `/plugins` if the listing contains several copies.

Cursor can also import Claude Code's installed plugin. Keep one route. Cursor has no action pane, status line,
`/sleight` or turbo. The relay ends a used turn after 30 idle seconds or on disconnect.

## Grok CLI

Grok CLI uses a stdio MCP entry in 1.4.0. If you don't already have a clone, get one:

```bash
git clone --branch v1.4.0 https://github.com/Land-o-Clusters/sleight.git ~/sleight
~/sleight/plugins/sleight/bin/sleight-mcp --doctor
```

Replace `/absolute/path/to/sleight` with that clone's full path. The add command below is untested.
`grok mcp doctor sleight` passed a configured direct entry on Grok 1.0.13 (10 tools, 2026-10-20).

```bash
grok mcp add sleight -- /absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp
grok mcp doctor sleight
```

Keep one route. Grok may already import sleight from Claude Code's marketplace checkout, which can differ from
Claude Code's cached version. `sleight-mcp --doctor` lists these copies. In a throwaway Grok 1.0.13 home,
marketplace add and `plugin install sleight --trust` succeeded, but `grok inspect --json` still selected the Claude
import. Check its `mcpServers` target before relying on the marketplace install.

Turbo is off in Grok for 1.4.0 because its calls have no trusted binding to the user's message. Use the engine path.
See [Grok CLI](docs/other-hosts.md#grok-cli) for approval and result limits.

## Grok Bot

Clone the `v1.4.0` tag with the command under [Grok CLI](#grok-cli) and set up ChatGPT's Computer Use on the Mac where Grok Bot's local daemon runs. Give the bot the
[Grok Bot skill](docs/grokbot-skill.md) with the clone's full executable path and add the
[profile pointer](docs/other-hosts.md#grok-bot). The bot calls `sleight-mcp js '<code>'` through its local shell.
The first call starts a detached session on demand. Its hosted STDIO MCP box cannot drive your Mac, and there is no
Mac-side HTTP client placement.

The session needs Apple's clang from Xcode Command Line Tools. It collects its engine and cache images after ten idle
minutes. The next call starts it again and reports the reset. An optional `sleight-mcp session --install-agent` prints
a plist and command for the owner to save and run. It doesn't write or load the plist.

Turn Grok Bot's own computer-use helper off. sleight shows its own approval panels, turbo stays off, and payments,
bookings, settings changes and submits ask each time. Screenshot paths point to private cache files for the bot's local file tool.
Run `sleight-mcp --doctor` to check the live session's native helper
Accessibility grant without a prompt. Without a live session the result is unknown. This route has offline tests. A live Grok Bot session has not been checked.

## Other MCP clients

Install the ChatGPT desktop app in `/Applications` first. The launcher uses its Node runtime. Then clone sleight:

```bash
git clone --branch v1.4.0 https://github.com/Land-o-Clusters/sleight.git ~/sleight
~/sleight/plugins/sleight/bin/sleight-mcp --doctor
```

Add this server to the client's config, with the clone's absolute path (JSON doesn't expand `~`):

```json
{
  "mcpServers": {
    "sleight": {
      "command": "/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp"
    }
  }
}
```

## Computer Use

The doctor exits 0 and prints `live read ok (helper inventory)` when the engine works. If it prints `MISSING` lines or
prints a line with `setup` in it, Computer Use isn't on yet. Give the user this setup command to run from the same plugin folder:

```text
"<installPath>/bin/sleight-mcp" setup
```

Setup runs OpenAI's helper installer, which asks for an administrator's Touch ID or password. It then opens the
Accessibility and Screen Recording panes, where the user allows Codex Computer Use, and runs the doctor again. To preview
what it will do, add `--dry-run`. After a successful check in your own terminal, setup also offers the optional `sleight`
command. See the [install validation limits](README.md#install-validation).

For turbo in Claude Code or Codex, the user turns on remote debugging once at `chrome://inspect/#remote-debugging`. Chrome then asks
them to allow each connection. The doctor's first lines say whether turbo is ready ([settings](docs/settings.md#turbo)).
Cursor, Grok CLI and generic MCP clients use the engine path. Codex turbo also needs its three trusted hooks.
Grok Bot uses the engine path too.

## Check it works

In the new session, ask:

```text
Use sleight to open Calculator in the background and work out 12 times 12 by clicking its buttons.
```

The user sees an approval card for Calculator. Once they allow it, Calculator should end on 144 while the window the
user was working in stays in front. One Codex run on 2026-10-19 took 22.5 s.

## Update and uninstall

| Host | Update | Uninstall |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace update sleight && claude plugin update sleight@sleight`, then a new session | `claude plugin uninstall sleight@sleight && claude plugin marketplace remove sleight` |
| Codex | `codex plugin marketplace upgrade sleight && codex plugin add sleight@sleight`, then a new session | `codex plugin remove sleight@sleight && codex plugin marketplace remove sleight` |
| Cursor | Update sleight in `/plugins` or Customize, then start a new chat | Remove sleight there and check for an imported Claude Code copy |
| Grok CLI | Fetch tags and check out the next release tag in the clone, then reconnect | Remove the direct MCP entry and check imports with `grok inspect --json` |
| Grok Bot | Fetch tags and check out the next release tag after its idle session exits | Remove the bot's sleight instructions after its idle session exits |
| Other MCP clients | Fetch tags and check out the next release tag in the clone, then reconnect | Remove the `mcpServers` entry and the clone |

We've checked the Codex update against a local marketplace only. [Privacy](docs/privacy.md#deleting-everything) lists
the files sleight keeps on the Mac and how to delete them.

## Changes in 1.4.0

See the [1.4.0 changelog](CHANGELOG.md#140-todo-release-date).
