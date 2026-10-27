// Strict MCP mode disables $.mcp.connect(), even for a server supplied by --plugin-dir.
// Use the host's connection policy instead, retaining the plugin's own server identity.
export function sleightPluginLaunch(plan) {
  const servers = Object.keys(plan.mcpConfig.mcpServers);
  if (!servers.includes('plugin:sleight:computer') || servers.some(name =>
    !['plugin:sleight:computer', 'sleight-turbo', 'fowlbrowser'].includes(name))) {
    throw new Error('Unexpected sleight benchmark MCP servers');
  }
  if (!plan.args.includes('--plugin-dir')) throw new Error('Sleight benchmark requires its plugin');
  const args = plan.args.filter(arg => arg !== '--strict-mcp-config');
  if (!args.includes('--setting-sources')) args.push('--setting-sources', '');
  else if (args[args.indexOf('--setting-sources') + 1] !== '') throw new Error('Sleight benchmark requires empty setting sources');
  if (!args.includes('--no-chrome')) args.push('--no-chrome');
  return { ...plan, args,
    settingsOverrides: { ...plan.settingsOverrides,
      allowedMcpServers: servers.map(serverName => ({ serverName })) },
    env: { ...plan.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } };
}
