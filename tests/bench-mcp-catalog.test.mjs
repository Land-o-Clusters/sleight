import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpCatalogProblems, sleightInitProblems } from '../bench/mcp-catalog.mjs';

const own = 'plugin:sleight:computer';
const row = (name, status = 'connected') => ({ name, status });
const init = mcp_servers => ({ type: 'system', subtype: 'init', mcp_servers });
const config = (...names) => ({ mcpServers: Object.fromEntries(names.map(name => [name, {}])) });

for (const names of [[own], [own, 'sleight-turbo'], ['fowlbrowser', own]]) {
  test(`init catalog accepts exactly ${names.join(', ')}`, () => {
    assert.deepEqual(sleightInitProblems([init(names.map(name => row(name)).reverse())], config(...names)), []);
  });
}
for (const status of ['connected', 'failed', 'pending', undefined]) {
  test(`clean catalog refuses a foreign server with status ${status}`, () => {
    assert.match(mcpCatalogProblems([row(own), { name: 'foreign', status }], [own]).join('; '), /also loads foreign/);
  });
}
test('init catalog refuses missing, failed, duplicate and malformed rows', () => {
  for (const [servers, pattern] of [[[], /missing/], [[row(own, 'failed')], /failed/],
    [[row(own), row(own)], /repeats/], [[null], /unnamed/], [undefined, /malformed/]]) {
    assert.match(sleightInitProblems([init(servers)], config(own)).join('; '), pattern);
  }
});
test('init catalog requires exactly one init and every companion', () => {
  assert.match(sleightInitProblems([], config(own)).join('; '), /received 0/);
  assert.match(sleightInitProblems([init([row(own)]), init([row(own)])], config(own)).join('; '), /received 2/);
  assert.match(sleightInitProblems([init([row(own)])], config(own, 'sleight-turbo')).join('; '), /sleight-turbo is missing/);
  assert.deepEqual(sleightInitProblems([{ type: 'assistant' }, init([row(own)])], config(own)), []);
});
test('rival and Codex runs retain their existing catalog contracts', () => {
  assert.deepEqual(sleightInitProblems([], null), []);
  assert.deepEqual(sleightInitProblems([], config('fowlbrowser')), []);
});
