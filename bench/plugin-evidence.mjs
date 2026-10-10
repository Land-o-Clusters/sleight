// This proof publishes its configured tools and measured outcomes, not account catalogs or app inventories.
export function filterPluginEvidence(input, { serverNames = ['sleight-plain', 'plugin:sleight:computer'], privateTerms = [] } = {}) {
  const counts = { connectorServerRecords: 0, connectorToolNames: 0, appInventoryEntries: 0,
    catalogFields: 0, thinkingBlocks: 0, privateTermOccurrences: 0, rateLimitEvents: 0 };
  const hidden = new Set(privateTerms.filter(Boolean));
  const prefixes = serverNames.map(name => `mcp__${name.replaceAll(':', '_')}__`);
  const foreignTool = name => typeof name === 'string' && name.startsWith('mcp__') && !prefixes.some(prefix => name.startsWith(prefix));
  const catalog = value => value && !Array.isArray(value) && typeof value === 'object' &&
    (value.type === 'system' && value.subtype === 'init' || Array.isArray(value.servers) && Array.isArray(value.tools));
  const decode = text => {
    try { return { kind: 'json', value: JSON.parse(text) }; } catch {}
    const lines = text.trim().split('\n');
    if (lines.length > 1) try { return { kind: 'jsonl', value: lines.map(JSON.parse) }; } catch {}
  };
  const collect = (value, depth = 0) => {
    if (depth > 64) throw new Error('evidence nesting exceeds the privacy filter limit');
    if (typeof value === 'string') { const decoded = decode(value); if (decoded) collect(decoded.value, depth + 1); }
    else if (value && typeof value === 'object') {
      if (catalog(value)) {
        for (const server of value.mcp_servers ?? value.servers ?? []) if (!serverNames.includes(server.name)) hidden.add(server.name);
        for (const tool of value.tools ?? []) if (foreignTool(tool)) hidden.add(tool);
      }
      for (const child of Object.values(value)) collect(child, depth + 1);
    }
  };
  collect(input);
  const visit = (value, depth = 0) => {
    if (depth > 64) throw new Error('evidence nesting exceeds the privacy filter limit');
    if (typeof value === 'string') {
      const decoded = decode(value);
      if (decoded) {
        const result = visit(decoded.value, depth + 1);
        return result === undefined ? '' : decoded.kind === 'json' ? JSON.stringify(result) + (value.endsWith('\n') ? '\n' : '') : result.map(row => JSON.stringify(row)).join('\n') + '\n';
      }
      const inventoryEntries = value.match(/\buseCount\b/g)?.length ?? 0;
      if (inventoryEntries) { counts.appInventoryEntries += inventoryEntries; return `[filtered app inventory: ${inventoryEntries} entries]`; }
      for (const term of hidden) if (typeof term === 'string' && term && value.includes(term)) {
        counts.privateTermOccurrences += value.split(term).length - 1;
        value = value.replaceAll(term, '<filtered private identity>');
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (value.some(entry => entry && typeof entry === 'object' && Object.hasOwn(entry, 'useCount'))) {
        counts.appInventoryEntries += value.length;
        return { filteredAppInventory: { entries: value.length } };
      }
      return value.map(child => visit(child, depth + 1)).filter(child => child !== undefined);
    }
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'rate_limit_event') { counts.rateLimitEvents++; return undefined; }
    if (Object.hasOwn(value, 'useCount')) { counts.appInventoryEntries++; return { filteredAppInventory: { entries: 1 } }; }
    if (value.type === 'thinking') { counts.thinkingBlocks++; return { type: 'filtered-thinking' }; }
    if (catalog(value)) {
      const serverKey = Array.isArray(value.mcp_servers) ? 'mcp_servers' : 'servers';
      const servers = value[serverKey] ?? [], tools = value.tools ?? [];
      const own = servers.filter(server => serverNames.includes(server.name));
      counts.connectorServerRecords += servers.length - own.length;
      counts.connectorToolNames += tools.filter(foreignTool).length;
      const fields = ['type', 'subtype', 'cwd', 'model', 'apiKeySource', 'claude_code_version', 'permissionMode'];
      counts.catalogFields += Object.keys(value).filter(key => ![...fields, serverKey, 'tools'].includes(key)).length;
      return { ...Object.fromEntries(fields.filter(key => key in value).map(key => [key, visit(value[key], depth + 1)])),
        [serverKey]: own.map(({ name, status }) => ({ name, status })), tools: tools.filter(tool => !foreignTool(tool)) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, depth + 1)]).filter(([, child]) => child !== undefined));
  };
  return { value: visit(input), counts };
}
