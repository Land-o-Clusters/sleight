// Handwritten observations for the twelve away rows, with no guest processes.
import { readFileSync } from 'node:fs';
import { collectRow } from '../../bench/windows/uc3f-collect.mjs';
import { fakeWindows } from './windows-driver-fake.mjs';

export const revision = 'a'.repeat(40);
const stamp = Date.parse('2026-11-02T01:00:00.000Z');
const templates = readFileSync(new URL('./uc3f-observer-lines.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const lines = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const counters = () => ({ postedMessages: 0, patternCalls: 0, uiaFetches: 0, captures: 0, finalReads: 0 });

function observations(row, caseId, start) {
  const reply = (method, offset, fields = {}) => ({ tickMs: start + offset, replyTickMs: start + offset + 20, method,
    ...method === 'typeText' ? { requestedUnits: 3000 } : {}, raw: { ok: true, windowMatched: true, counters: counters(), ...fields } });
  const refused = (after = false) => ({ ok: false, code: 'PERSON_TOOK_OVER', reason: 'person-active', unhealthy: false,
    delivery: after ? 'sent-unverified' : 'not-sent', retry: after ? 'read-first' : 'safe', ...after ? { typed: 128 } : {} });
  const injector = key => JSON.stringify({ schema: 'sleight.windows-uc3f-inject/1', kind: 'injector', invocation: '2',
    operation: 'key', key, tickMs: start + 100, eventTickMs: start + 100, vk: key === 'escape' ? 27 : 81, sentInputs: 2, code: 'OK' });
  const facts = { driver: [reply('getAXState', 50)], fixture: { effectObserved: true, keyUpsDelivered: true, postsAfterStop: 0 } };
  if (row === 'person-idle') facts.driver.push(reply('typeText', 200));
  if (caseId === 'calculator-refused') facts.driver = [...Array(5).fill(undefined), ...Array(2).fill(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']).flat()]
    .map((admissionFor, i) => ({ ...reply('getApp', 50 + 25 * i, { ok: false, code: 'HOSTED_APP_UNRESOLVED' }), ...admissionFor ? { admissionFor } : {} }));
  if (row === 'person-key-before' || row === 'person-key-during') {
    facts.driver.push(reply('typeText', 200, refused(row === 'person-key-during')));
    facts.injector = injector('other'); facts.injectorInvocation = '2';
  }
  if (row === 'escape-ignored-injected') {
    facts.driver.push(reply('typeText', 200, { escapeStops: 0 }));
    facts.injector = injector('escape'); facts.injectorInvocation = '2';
  }
  if (row === 'escape-ignored-posted') facts.driver.push(reply('stuckMenuEscape', 200, { escapeStops: 0 }));
  if (row === 'cancel-frame') {
    facts.driver.push(reply('typeText', 200, { ...refused(true), code: 'USER_STOPPED', reason: 'cancel' }));
    facts.parent = { jobId: 1, jobReplyId: 1, cancelId: 2, cancelReplyId: 2, flagMs: 5 };
  }
  if (row.startsWith('direct-launch')) {
    const override = row === 'direct-launch-override', direct = caseId.startsWith('direct');
    facts.launch = { source: direct ? 'scheduled-direct' : 'parent', override, ...direct ? { nonceSha256: '9'.repeat(64) } : {} };
    facts.driver = [reply('getAXState', 200, override && caseId.endsWith('terminal') ? {} :
      { ok: false, code: caseId.endsWith('settings') ? 'FORBIDDEN_SETTINGS' : 'FORBIDDEN_TARGET' })];
  }
  if (row.startsWith('browser-refused')) {
    facts.parent = { cards: 0, leases: 0, contentReads: 0 };
    if (!['notepad', 'wpf'].includes(caseId)) facts.driver = [reply('getAXState', 200, { ok: false, code: 'BROWSER_TARGET_REFUSED' })];
    if (caseId === 'renamed') facts.pe = { originalFilenamePreserved: true, productNamePreserved: true };
  }
  if (row === 'checkpoint-cost') facts.costSamples = caseId === 'hook-callback' ? [{ elapsedUs: 25 }] : [{ elapsedMs: 2.75 }];
  return facts;
}

export async function rowObservations(rowId) {
  let tick = 100, output, count = 0;
  // Legacy observer metadata is fixture data, never a runner lease or gate.
  const lease = { row: rowId, presence: 'away', token: '2'.repeat(32),
    issuedUtc: new Date(stamp).toISOString(), expiresUtc: new Date(stamp + 900000).toISOString() };
  const observer = [];
  const poll = at => { count += 50; observer.push({ ...templates.find(r => r.kind === 'poll'),
    tickMs: at, pollCount: count, maxGapMs: 10, lastInputTickMs: 50 }); };
  const backend = {
    now: () => stamp, tick: () => tick++, guard: async () => {}, lease: async () => lease,
    preflight: async () => {}, setup: async (_r, { register }) => register({ ...fakeWindows[0] }),
    inspect: async f => f, closeFixture: async () => {}, removeTasks: async () => {}, removeRenamedCopy: async () => {}, closeClients: async () => {},
    cleanupCheck: async () => ({ tasks: [], fixturePids: [], bankFiles: [], renamedCopies: [], hookRemoved: true, sessionRestored: true }),
    startObserver: async () => ({ ready: true, invocation: '1', finish: async () => {
      const all = [{ ...templates[0], tickMs: 99, rowId, rowToken: lease.token, invocation: '1', leaseExpiresUtc: lease.expiresUtc },
        ...observer, { ...templates.at(-1), tickMs: tick + 1, pollCount: count }];
      all.forEach((r, n) => { r.seq = n + 1; }); all.at(-1).records = all.length;
      return lines(all);
    } }),
    measure: async ({ caseId }) => {
      const start = tick - 1;
      poll(start); poll(start + 100);
      if (rowId === 'escape-ignored-injected') observer.push({ ...templates.find(r => r.kind === 'key'),
        tickMs: start + 100, eventTickMs: start + 100, key: 'escape', phase: 'down', injected: true, lowerIntegrityInjected: false });
      poll(start + 400); poll(start + 500); tick = start + 500;
      return observations(rowId, caseId, start);
    },
    writeRaw: async (_id, rows) => { output = lines(rows); },
  };
  const result = await collectRow({ revision, rowId, ownerAway: true, lease, rowToken: lease.token, transportInvocation: '1' }, backend);
  if (result.status !== 'recorded') throw Error(JSON.stringify(result));
  return output;
}
