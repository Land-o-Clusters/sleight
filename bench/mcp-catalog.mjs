// Compare the host's observed catalog with the launch descriptor, including disconnected extras.
export function mcpCatalogProblems(servers, expected) {
  if (!Array.isArray(servers)) return ['MCP init catalog is missing or malformed'];
  const problems = [], seen = new Set();
  for (const server of servers) {
    const name = server?.name;
    if (typeof name !== 'string') { problems.push('MCP init catalog has an unnamed server'); continue; }
    if (seen.has(name)) problems.push(`MCP init catalog repeats ${name}`);
    seen.add(name);
    if (!expected.includes(name)) problems.push(`MCP init catalog also loads ${name}`);
    else if (server.status !== 'connected') problems.push(`MCP init catalog: ${name} is ${server.status ?? 'missing status'}`);
  }
  for (const name of expected) if (!seen.has(name)) problems.push(`MCP init catalog: ${name} is missing`);
  return problems;
}

// Only Claude sleight arms need this guard. Codex and rival catalogs have their own contracts.
export function sleightInitProblems(events, mcpConfig) {
  const expected = Object.keys(mcpConfig?.mcpServers ?? {});
  if (!expected.includes('plugin:sleight:computer')) return [];
  const inits = events.filter(event => event?.type === 'system' && event.subtype === 'init');
  if (inits.length !== 1) return [`MCP init catalog: expected 1 init event, received ${inits.length}`];
  return mcpCatalogProblems(inits[0].mcp_servers, expected);
}
