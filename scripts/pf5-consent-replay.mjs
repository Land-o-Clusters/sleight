// Offline differential replay at the protocol/action/consent boundary.
// Recorded inputs are unchanged. DOM, authority, time and snapshots are fixtures.
// This is not a browser replay, timing benchmark or release qualification.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { parseRecording } from '../bench/replay/recording.mjs';
import { createProtocol } from '../bench/turbo/v3-protocol.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { inspectConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';
import { consentDOM } from '../tests/fixtures/consent-dom.mjs';

const base = 'cab7138b5a716308fc228b09ea3bcc424cdd2b7e';
function baseline() {
  const source = execFileSync('/usr/bin/git', ['show', base + ':plugins/sleight/lib/direct-browser/consent-wall.mjs'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  const body = source.slice(source.indexOf('export function inspectConsent('), source.indexOf('\ninspectConsent.helpers'));
  return runInNewContext('(' + body.replace('export ', '') + ')',
    Object.fromEntries(inspectConsent.helpers.map(fn => [fn.name, fn])));
}

async function replay(call, labels, inspect) {
  const dom = consentDOM(inspect), actions = [], nodes = new Map();
  for (const step of call.arguments.steps) {
    const observed = labels.get(step.ref);
    nodes.set(step.ref, dom.node(observed.role === 'link' ? 'a' : 'button', observed.name));
  }
  const page = new EventEmitter(); let time = 0, number = 1;
  page.url = () => 'https://offline.invalid/'; page.mainFrame = () => page;
  page.getByRef = ref => dom.locator(nodes.get(ref), { link: labels.get(ref).role === 'link' }, actions);
  page.evaluate = async () => { time += 16; };
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } };
  const run = createActionRunner({ check: () => ({ kind: 'allow' }), now: () => time,
    sleep: async ms => { time += ms; }, snapshot: async () => ({ text: 'Offline fixture observation.', number: ++number }) });
  const replies = []; let delivered = 0, closed = 0;
  const protocol = createProtocol({ output: { write(line, done) { replies.push(JSON.parse(line)); done(); } },
    start: async () => ({
      async call(request) {
        assert.equal(request.name, 'browser_act');
        const result = await run(tab, request.arguments.steps, {}, { observe: request.arguments.observe });
        assert.equal(result.stoppedAt, null, JSON.stringify(result.lines));
        return { text: result.lines.join('\n') + '\n' + (result.observe?.text ?? ''), isError: false };
      }, delivered() { delivered++; }, close() { closed++; },
    }),
  });
  try { await protocol.message({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: call.name, arguments: call.arguments } }); }
  finally { await protocol.close(); }
  assert.equal(replies.length, 1); assert.equal(replies[0].error, undefined);
  assert.equal(replies[0].result.isError, false); assert.equal(delivered, 1); assert.equal(closed, 1);
  assert.equal(actions.length, call.arguments.steps.length);
  return { replies, actions, scans: [...dom.scans.values()].reduce((a, b) => a + b, 0),
    reads: [...dom.reads.values()].reduce((a, b) => a + b, 0) };
}

export async function replayBank(bank) {
  const before = baseline(), rows = []; let recorded = 0, runs = 0;
  for (const round of readdirSync(bank).filter(n => /-[AB]-r\d+$/.test(n)).sort()) {
    for (const task of readdirSync(join(bank, round), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      const path = join(bank, round, task, 'events.jsonl');
      let source; try { source = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const calls = parseRecording(source), tabs = new Map(); runs++; recorded += calls.length;
      for (const call of calls) {
        const steps = call.arguments.steps, labels = tabs.get(call.arguments.tab);
        const text = call.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        // Bounded branch under study: ordinary observed link/button activation.
        // Other operations and missing observations are counted, never passed.
        const selected = call.name === 'browser_act' && labels && !call.result.isError
          && !/: not run:|: not reached|unknown or releasing owned tab|effect unconfirmed/.test(text)
          && steps?.length && steps.every(step =>
          ['click', 'navigate'].includes(step.do) && step.ref && !step.modifier && labels.has(step.ref)
          && !/\b(pay|save|submit|confirm|apply|book|checkout|order|accept|reject)\b/i.test(labels.get(step.ref).name));
        if (selected) {
          const a = await replay(call, labels, before), b = await replay(call, labels, inspectConsent);
          assert.deepEqual(b.replies, a.replies); assert.deepEqual(b.actions, a.actions);
          assert.ok(b.scans < a.scans); assert.ok(b.reads < a.reads);
          rows.push({ round, task, id: call.id, transcriptSHA256: createHash('sha256').update(source).digest('hex'),
            steps: steps.length, scansBefore: a.scans, scansAfter: b.scans, readsBefore: a.reads, readsAfter: b.reads });
        }
        const opened = call.name === 'browser_open' && /^(t[a-z0-9]+) https?:\/\//.exec(text)?.[1];
        const tab = opened || call.arguments.tab;
        if (!tab) continue;
        if (opened) tabs.set(tab, new Map());
        const observed = tabs.get(tab);
        if (!observed) continue;
        if (/^# Snapshot \d+/m.test(text)) observed.clear();
        for (const removed of text.matchAll(/# Removed from this view: \[ref=([^\]]+)\]/g)) observed.delete(removed[1]);
        for (const match of text.matchAll(/- (link|button) ("(?:[^"\\]|\\.)*")[^\n]*\[ref=([^\]]+)\]/g))
          observed.set(match[3], { role: match[1], name: JSON.parse(match[2]) });
      }
    }
  }
  assert.ok(rows.length > 0, 'no replayable ordinary activations');
  return { base, mode: 'offline protocol/action replay with modeled DOM; no browser and no timing claim',
    runs, recorded, replayed: rows.length, skipped: recorded - rows.length,
    totals: Object.fromEntries(['steps', 'scansBefore', 'scansAfter', 'readsBefore', 'readsAfter'].map(key => [key, rows.reduce((n, r) => n + r[key], 0)])), rows };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 && !(process.argv.length === 4 && process.argv[3] === '--summary'))
    throw Error('usage: node scripts/pf5-consent-replay.mjs RECORDED_BANK [--summary]');
  const result = await replayBank(resolve(process.argv[2]));
  if (process.argv[3] === '--summary') {
    result.tasks = Object.fromEntries([...new Set(result.rows.map(row => row.task))].map(task =>
      [task, result.rows.filter(row => row.task === task).length]));
    delete result.rows;
  }
  console.log(JSON.stringify(result, null, 2));
}
