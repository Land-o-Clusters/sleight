// Targeted guard timing, no model or all-task benchmark pass. Owns one engine.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText, elementLines } from '../plugins/sleight/lib/document-scope.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { closeGuardFixture } from './guard-reads-cleanup.mjs';
import { guardTrialTiming } from './guard-reads-events.mjs';

const phase = process.argv[2];
assert.ok(['before', 'after', 'cleanup'].includes(phase), 'pass before, after or cleanup');
const task = phase === 'cleanup' ? 'cleanup' : process.argv[3] ?? 'all';
assert.ok(['all', 'calculator', 'textedit', 'chess', 'cleanup'].includes(task), 'unknown task');
const bank = await mkdtemp('/private/tmp/sleight-guard-reads-');
const server = resolveServer();
const report = { phase, task, engine: server.version, started: new Date().toISOString(), trials: [], probes: [], failures: [] };
report.guardSourceSha256 = createHash('sha256').update(await readFile(new URL('../plugins/sleight/lib/document-scope.mjs', import.meta.url))).digest('hex');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('interrupted')));
let client, unlock, events = [], owned;
const plain = result => (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const scrub = text => String(text).replace(/\/Users\/[^/\s"']+/g, '~')
  .replace(/Window: "(?:[^"\\]|\\.)*", App: Chess\.?/g, 'Window: "[game]", App: Chess.');
const record = event => {
  if (event.direction === 'guard-read') events.push({ t: performance.now(), direction: event.direction, ...event.msg });
  else if (['call-received', 'to-server', 'from-server', 'to-client'].includes(event.direction)) {
    events.push({ t: performance.now(), direction: event.direction, id: event.msg.id, method: event.msg.method });
  }
};
const call = async code => {
  controller.signal.throwIfAborted();
  const result = await client.call('js', { code, timeout_ms: 60000 });
  if (result.isError) throw new Error(plain(result));
  return plain(result);
};
const acquire = app => call(`var app = await cua.getApp(${JSON.stringify(app)})`);
async function closeOwned(path) {
  const receipt = await closeGuardFixture(code => client.call('js', { code }), path);
  report.probes.push(JSON.parse(scrub(JSON.stringify(receipt))));
}
async function trial(task, repetition, code, verify = () => {}) {
  events = [];
  const start = performance.now();
  const entry = { task, repetition, code };
  report.trials.push(entry);
  try {
    const result = await call(code);
    entry.totalMs = performance.now() - start;
    await verify(result);
    entry.header = windowFromText(result);
    if (entry.header?.app === 'Chess') entry.header = { ...entry.header, title: '[game]', url: entry.header.url ? '[game URL]' : null };
    entry.passed = true;
  } catch (error) { entry.error = scrub(error.message); throw error; }
  finally {
    Object.assign(entry, guardTrialTiming(events));
    entry.trace = events;
    console.log(JSON.stringify(entry));
  }
}
async function parseProbe(app) {
  const text = await call(`{ const tree = await app.getAXState({ emit: false });
    const parse = ${windowFromText.toString()}, elements = ${elementLines.toString()};
    const start = performance.now();
    for (let i = 0; i < 1000; i++) { parse(tree); elements(tree); }
    nodeRepl.write('guard-parse:' + JSON.stringify({ chars: tree.length, parseMs: (performance.now() - start) / 1000, iterations: 1000 }));
  }`);
  report.probes.push({ app, ...JSON.parse(text.match(/^guard-parse:(.*)$/m)[1]) });
}
try {
  console.log(`Waiting for the live lock. Evidence: ${bank}/results.json`);
  unlock = await acquireLiveLock(undefined, { wait: true, signal: controller.signal });
  console.log('Live lock acquired.');
  client = await probeClient(server, { relay: true, record,
    label: 'guard-reads', relayOptions: { guardTiming: true, changeReview: false } });
  if (phase === 'cleanup') {
    const path = process.argv[3];
    assert.match(path, /^\/private\/tmp\/sleight-guard-reads-[A-Za-z0-9]+\/guard-\d+\.txt$/);
    await promisify(execFile)('/usr/bin/open', ['-a', 'TextEdit', path]);
    await sleep(500, undefined, { signal: controller.signal });
    const current = await acquire('com.apple.TextEdit');
    assert.equal(windowFromText(current)?.url, pathToFileURL(path).href);
    await closeOwned(path);
    report.closedFixture = path;
  } else {
  if (['all', 'calculator'].includes(task)) {
  await acquire('com.apple.calculator');
  await parseProbe('Calculator');
  for (let i = 1; i <= 5; i++) {
    await call('await app.pressKey("Escape")');
    await trial('calculator-eight-clicks', i,
      'for (const id of ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"]) await app.click({ id });',
      text => assert.match(text, /12[, .]?345[, .]?678/));
  }
  }
  if (['all', 'textedit'].includes(task)) {
    owned = join(bank, 'guard-1.txt');
    await writeFile(owned, 'guard timing\n');
    await promisify(execFile)('/usr/bin/open', ['-a', 'TextEdit', owned]);
    // open returns before the new window is ready. This fixture-only wait is
    // outside the measured call; engine actions use their own observation wait.
    await sleep(500, undefined, { signal: controller.signal });
    const initial = await acquire('com.apple.TextEdit');
    assert.equal(windowFromText(initial)?.url, pathToFileURL(owned).href, 'TextEdit must select the owned fixture');
    await parseProbe('TextEdit');
  for (let i = 1; i <= 5; i++) {
    const token = `Guard timing ${i}`;
    await trial('textedit-type-save', i,
      `await app.pressKey("super+a"); await app.typeText(${JSON.stringify(token)}); await app.pressKey("super+s");`,
      async () => assert.equal((await readFile(owned, 'utf8')).trim(), token));
  }
    await closeOwned(owned);
    owned = undefined;
  }
  if (['all', 'chess'].includes(task)) {
  await acquire('com.apple.Chess');
  await parseProbe('Chess');
  for (let i = 1; i <= 5; i++) {
    await trial('chess-read-then-act', i,
      'await app.getAXStateAndScreenshot(); await app.pressKey("Escape");');
  }
  }
  }
} catch (error) {
  report.failures.push(scrub(error.message)); process.exitCode = 1;
  console.error(scrub(error.message));
} finally {
  if (owned) report.failures.push('Owned TextEdit fixture left open after failure; no blind cleanup action sent.');
  if (client) {
    try { await client.close(); report.engineCollected = true; }
    catch (error) { report.failures.push(scrub(error.message)); process.exitCode = 1; }
  }
  if (unlock) await unlock();
  await writeFile(join(bank, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidence: ${bank}/results.json`);
}
