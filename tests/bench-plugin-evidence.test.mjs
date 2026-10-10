import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../bench/plugin-evidence.mjs').catch(() => ({}));

test('publication filters connector catalogs and every serialized copy, preserving own tools', () => {
  const catalog = { type: 'system', subtype: 'init', model: 'fixture-model', apiKeySource: 'ANTHROPIC_API_KEY',
    tools: ['mcp__sleight-plain__js', 'mcp__claude_ai_PrivateCalendar__search'],
    mcp_servers: [{ name: 'sleight-plain', status: 'connected' }, { name: 'PrivateCalendar', status: 'connected', source: 'claudeai' }],
    skills: ['unrelated-personal-skill'] };
  const { value, counts } = api.filterPluginEvidence({ catalog, stdout: JSON.stringify(catalog) + '\n', stderr: 'PrivateCalendar failed' });
  const text = JSON.stringify(value);
  for (const privateText of ['PrivateCalendar', 'unrelated-personal-skill']) assert.equal(text.includes(privateText), false);
  assert.deepEqual(value.catalog.tools, ['mcp__sleight-plain__js']);
  assert.equal(value.catalog.apiKeySource, 'ANTHROPIC_API_KEY');
  assert.equal(counts.connectorServerRecords, 2);
  assert.equal(counts.connectorToolNames, 2);
});

test('publication filters inventories within text, nested JSON and transcript copies', () => {
  const apps = [{ displayName: 'PrivateAppAlpha', useCount: 91 }, { displayName: 'PrivateAppBeta', useCount: 14 }];
  const event = { type: 'user', message: { content: [{ type: 'tool_result', content: `Engine docs\n${JSON.stringify({ apps })}` }] },
    tool_use_result: { content: [{ type: 'text', text: JSON.stringify({ apps }) }] } };
  const input = { transcript: JSON.stringify(event) + '\n', trace: { result: { apps } }, error: 'cgWindowNotFound' };
  const { value, counts } = api.filterPluginEvidence(input);
  const text = JSON.stringify(value);
  for (const privateText of ['PrivateAppAlpha', 'PrivateAppBeta', 'useCount']) assert.equal(text.includes(privateText), false);
  assert.equal(value.error, 'cgWindowNotFound');
  assert.equal(counts.appInventoryEntries, 6);
  assert.deepEqual(api.filterPluginEvidence(value).value, value, 'filtering published evidence is stable');
});

test('publication filters supplied private terms without retaining their names in receipts', () => {
  const { value, counts } = api.filterPluginEvidence({ hold: 'Window for Private Project', destination: 'owner/private-source' },
    { privateTerms: ['Private Project', 'owner/private-source'] });
  assert.equal(JSON.stringify(value).includes('Private Project'), false);
  assert.equal(JSON.stringify(value).includes('owner/private-source'), false);
  assert.equal(counts.privateTermOccurrences, 2);
});

test('publication removes rate-limit events and their serialized copies without changing results', () => {
  const event = { type: 'rate_limit_event', rate_limit_info: { utilization: 0.91 }, session_id: 'private-session-fixture', request_id: 'private-request-fixture' };
  const result = { type: 'result', result: '391', total_cost_usd: 0.01 };
  const { value, counts } = api.filterPluginEvidence({ events: [event, result], single: JSON.stringify(event),
    stdout: [event, result].map(row => JSON.stringify(row)).join('\n') + '\n' });
  for (const term of ['rate_limit_event', 'utilization', 'private-session-fixture', 'private-request-fixture']) assert.equal(JSON.stringify(value).includes(term), false);
  assert.deepEqual(value.events, [result]);
  assert.equal(value.stdout, JSON.stringify(result) + '\n');
  assert.equal(counts.rateLimitEvents, 3);
  assert.deepEqual(api.filterPluginEvidence(value).value, value);
});
