# Other MCP hosts

sleight is a Claude Code plugin first. Its MCP server also works with Cursor and generic stdio
clients. You need the same [Mac and ChatGPT app setup](../README.md#install).

Clone the repo and use its launcher. It runs on the Node bundled with ChatGPT, without npm install.

```bash
git clone https://github.com/Land-o-Clusters/sleight.git ~/sleight
~/sleight/plugins/sleight/bin/sleight-mcp --doctor
```

For [Cursor](https://cursor.com/help/customization/mcp), put this in `~/.cursor/mcp.json`. The same
`mcpServers` entry works in a generic client that accepts this JSON format. Replace the command with
your clone's absolute path. JSON doesn't expand `~` or `${CLAUDE_PLUGIN_ROOT}`.

```json
{
  "mcpServers": {
    "sleight": {
      "command": "/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp"
    }
  }
}
```

After reconnecting the client, ask it to use sleight's `js` tool.

These clients don't get the Claude Code pane, status line, `/sleight stop` or registered skill
command. The relay still adds the bundled
skill's guidance to the first engine documentation reply. Without that file, the engine's API docs
and tools still work. Approvals use the client's form prompts when supported, otherwise sleight's
own macOS panel. That panel names Claude under Claude Code and uses generic wording in other hosts.
Without a turn hook, the relay ends a used turn after 30 idle seconds and on disconnect. Close the
server connection to stop the session.

Update the clone with `git pull --ff-only` and reconnect. See [settings](settings.md) for approval
overrides and [the design note](design/other-hosts.md) for protocol checks and host-testing limits.
