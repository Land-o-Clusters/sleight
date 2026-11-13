// Record reviewed source against a fake transport. No app, native host, input or renderer runs.
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const base = '73bc6b73786a9ac5b70e25aa405c6992024a8b0b';
if (process.argv.slice(2).join() !== '--baseline') throw Error('Use --baseline to record the reviewed CHRET4 source.');
const sources = new Map(), hashes = {};
for (const path of ['hand/client.mjs', 'hand/runtime-hand.mjs', 'hand/browser-hand.mjs', 'relay.mjs', 'hand/events.mjs']) {
  const source = execFileSync('/usr/bin/git', ['show', base + ':plugins/sleight/lib/' + path], {
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4 << 20 });
  sources.set(new URL('../plugins/sleight/lib/' + path, import.meta.url).href, source);
  hashes[path] = createHash('sha256').update(source).digest('hex');
}
const hook = registerHooks({ load(url, context, next) {
  const result = next(url, context);
  return sources.has(url) ? { ...result, source: sources.get(url) } : result;
} });
try {
  const { recordDefaultTurn } = await import('../tests/fixtures/default-hand-turns.mjs');
  const turns = {};
  for (const route of ['Glide', 'turbo']) turns[route] = await recordDefaultTurn(route);
  const fixture = { schema: 'sleight.int23d-default-turns/1', base, sourceHashes: hashes, turns };
  writeFileSync(new URL('../tests/fixtures/int23d-default-turns.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify({ base, frames: Object.fromEntries(Object.entries(turns).map(([route, rows]) => [route, rows.length])), sourceHashes: hashes }));
} finally { hook.deregister(); }
