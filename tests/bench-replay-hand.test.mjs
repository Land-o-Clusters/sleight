import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertHandAway, assertSideHosts, handClientSpec, assertHandClient, prepareHandSides, handPreflight, dragHandEvidence, handRunEvidence } from '../bench/replay/hand.mjs';
import { observeHostWire } from '../bench/replay/hand-server.mjs';
import { clientsFor, options, main as productionMain } from '../bench/replay/run.mjs';
import { campaignEvidence } from '../bench/replay/checks.mjs';

const runUrl = new URL('../bench/replay/run.mjs', import.meta.url);
let replayMain = productionMain;
if (process.env.INT25C_BROKEN === 'skip-away') {
  const source = readFileSync(runUrl, 'utf8');
  const gate = "const requireHandAway = () => { if (opts['hand-on']) assertHandAway({ ownerAwayFile }); };";
  assert.equal(source.split(gate).length - 1, 1);
  const changed = source.replace(gate, 'const requireHandAway = () => {};')
    .replace(/from '(\.\.?\/[^']+)'/g, (_all, specifier) => `from '${new URL(specifier, runUrl).href}'`)
    .replace(/import\('(\.\.?\/[^']+)'\)/g, (_all, specifier) => `import('${new URL(specifier, runUrl).href}')`)
    .replace('if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)', 'if (false)')
    .replaceAll('import.meta.url', JSON.stringify(runUrl.href));
  replayMain = (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'))).main;
}

function handRecording(t) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-replay-away-')));
  const dir = join(root, 'recording');
  mkdirSync(dir);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ task: 'textedit-drag' }));
  writeFileSync(join(dir, 'events.jsonl'), [
    { message: { content: [{ type: 'tool_use', id: 'one', name: 'mcp__plugin_sleight_computer__open_file', input: { app: 'TextEdit', path: '/tmp/sleight-bench/stamp/run/1234abcd-drag.txt' } }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'opened' }] } },
  ].map(JSON.stringify).join('\n'));
  const marker = join(root, 'owner-away');
  writeFileSync(marker, '');
  return { root, dir, marker, missing: join(root, 'missing-owner-away'), bank: join(root, 'bank') };
}

function startHandOn(fixture, args, markerEnv) {
  const seen = { locked: false, held: false };
  const promise = replayMain([
    fixture.dir, '--owner-away', '--hand-on', '--old-worktree', join(fixture.root, 'old'), '--new-worktree', join(fixture.root, 'new'),
    '--out', fixture.bank, ...args,
  ], {
    markerEnv,
    identifyBuild: (_path, label) => ({ label, worktree: join(fixture.root, label), commit: 'a'.repeat(40), trackedDirty: false, trackedDiffSHA256: 'b'.repeat(64) }),
    acquireLock: async () => { seen.locked = true; throw Error('live lock'); },
    hold: () => { seen.held = true; throw Error('passed marker gate'); },
    permissionCheck: async () => { throw Error('permission observer ran'); },
  });
  return { seen, promise };
}

test('hand-on is explicit and requires the owner-away marker', () => {
  assert.equal(options([])['hand-on'], undefined);
  assert.equal(options(['--hand-on'])['hand-on'], true);
  assert.throws(() => assertHandAway({ exists: () => assert.fail('missing marker path inspected'), ownerAwayFile: '' }), /owner-away/);
  assert.throws(() => assertHandAway({ exists: () => false, ownerAwayFile: '/fixture/owner-away' }), /owner-away/);
  const checked = [];
  assertHandAway({ exists: path => { checked.push(path); return true; }, ownerAwayFile: '/fixture/owner-away' });
  assert.deepEqual(checked, ['/fixture/owner-away']);
});

test('replay accepts --owner-away-file and keeps the environment variable as its fallback', async t => {
  const marker = '/fixture/owner-away';
  assert.equal(options(['--owner-away-file', marker])['owner-away-file'], marker);
  assert.throws(() => options(['--owner-away-file']), /Missing value/);
  assert.throws(() => options(['--owner-away-file', marker, '--owner-away-file', marker]), /Repeated/);
  const absent = handRecording(t);
  const refused = startHandOn(absent, [], {});
  await assert.rejects(refused.promise, /requires an owner-away marker file/);
  assert.equal(refused.seen.held, false);
  assert.equal(refused.seen.locked, false);
  assert.equal(existsSync(absent.bank), false);
  const missingFile = handRecording(t);
  const missingEnv = startHandOn(missingFile, [], { SLEIGHT_OWNER_AWAY_FILE: missingFile.missing });
  await assert.rejects(missingEnv.promise, /requires an owner-away marker file/);
  assert.equal(missingEnv.seen.held, false);
  assert.equal(missingEnv.seen.locked, false);
  assert.equal(existsSync(missingFile.bank), false);
  const fromEnv = handRecording(t);
  const envRun = startHandOn(fromEnv, [], { SLEIGHT_OWNER_AWAY_FILE: fromEnv.marker });
  await assert.rejects(envRun.promise, /passed marker gate/);
  assert.equal(envRun.seen.held, true);
  assert.equal(envRun.seen.locked, false);
  assert.equal(existsSync(fromEnv.bank), false);
  const fromFlag = handRecording(t);
  const flagRun = startHandOn(fromFlag, ['--owner-away-file', fromFlag.marker], {});
  await assert.rejects(flagRun.promise, /passed marker gate/);
  assert.equal(flagRun.seen.locked, false);
  assert.equal(existsSync(fromFlag.bank), false);
  const overridden = handRecording(t);
  const flagWins = startHandOn(overridden, ['--owner-away-file', overridden.missing], { SLEIGHT_OWNER_AWAY_FILE: overridden.marker });
  await assert.rejects(flagWins.promise, /requires an owner-away marker file/);
  assert.equal(flagWins.seen.held, false);
  assert.equal(existsSync(overridden.bank), false);
  const planned = handRecording(t);
  const log = console.log;
  console.log = () => {};
  try {
    const plan = await replayMain([
      planned.dir, '--plan', '--hand-on', '--old-worktree', join(planned.root, 'old'), '--new-worktree', join(planned.root, 'new'), '--out', planned.bank,
    ], {
      markerEnv: {},
      identifyBuild: (_path, label) => ({ label, worktree: join(planned.root, label), commit: 'a'.repeat(40), trackedDirty: false, trackedDiffSHA256: 'b'.repeat(64) }),
      acquireLock: () => assert.fail('plan took a live lock'),
      hold: () => assert.fail('plan waited on the hold'),
    });
    assert.equal(plan.handOn, true);
    assert.equal(existsSync(planned.bank), false);
  } finally { console.log = log; }
});

const hand = { worktree: '/fixture/build', binary: '/fixture/cache/host', config: '/fixture/server.json' };
test('broken variant silently selecting hand-off is refused before connection', () => {
  const spec = handClientSpec('plugin:sleight:computer', { env: { SLEIGHT_HAND: '0' } }, hand, hand.worktree);
  assertHandClient(spec, hand);
  assert.throws(() => assertHandClient({ ...spec, env: { ...spec.env, SLEIGHT_HAND: '0' } }, hand), /must not fall back/);
  assert.throws(() => assertHandClient({ ...spec, args: ['/fixture/replay/server.mjs'] }, hand), /must not fall back/);
  assert.throws(() => handClientSpec('sleight-turbo', spec, hand, hand.worktree), /native/);
  assert.throws(() => handClientSpec('plugin:sleight:computer', spec, hand, '/fixture/other'), /does not match/);
});

test('clientsFor pins hand-on after arm overrides and leaves the default hand-off', async () => {
  for (const enabled of [false, true]) {
    const seen = [], records = [];
    const clients = await clientsFor({ policy: 'bench', env: { SLEIGHT_HAND: enabled ? '0' : '1' } }, {}, '/fixture/evidence', e => records.push(e), hand.worktree, {
      ...(enabled ? { hand } : {}), connect: async (spec, callbacks) => {
        seen.push(spec);
        return { close: async () => callbacks.record({ event: 'engine-close', code: 0 }) };
      },
    });
    assert.equal(seen[0].env.SLEIGHT_HAND, enabled ? '1' : '0');
    assert.match(seen[0].args[0], enabled ? /hand-server\.mjs$/ : /replay\/server\.mjs$/);
    await clients.close(); assert.equal(records.at(-1).code, 0);
  }
});

test('broken launch environment falling back to hand-off never connects', async () => {
  await assert.rejects(clientsFor({ policy: 'bench' }, {}, '/fixture/evidence', () => {}, hand.worktree, {
    hand, beforeLaunch: env => { env.SLEIGHT_HAND = '0'; }, connect: () => assert.fail('hand-off fallback connected'),
  }), /must not fall back/);
});

const side = (variant, cache = `/fixture/${variant}`) => ({ build: { worktree: `/build/${variant}` }, cache,
  identity: { worktree: `/build/${variant}`, cache }, binaries: { host: cache + '/host', sampler: cache + '/sampler' } });
test('broken variant using one host for both sides fails even when both hosts hash equally', () => {
  const a = side('A'), b = side('B');
  assertSideHosts(new Map([['A', a], ['B', b]]));
  for (const mutate of [value => { value.binaries.host = a.binaries.host; }, value => { value.cache = a.cache; },
    value => { value.identity.worktree = a.identity.worktree; }]) {
    const broken = structuredClone(b); mutate(broken);
    assert.throws(() => assertSideHosts(new Map([['A', a], ['B', broken]])), /must not share/);
  }
});

test('each build loads and compiles its own check-4 sources into a separate cache', async t => {
  const out = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-hand-build-')))), loaded = [], built = [];
  const variants = ['A', 'B'].map(variant => {
    const worktree = join(out, variant), folder = join(worktree, 'plugins/sleight/lib/direct-browser/native');
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'consent-host.swift'), variant);
    return { variant, build: { worktree } };
  });
  let closed = 0;
  const prepared = await prepareHandSides(variants, out, new AbortController().signal, {
    assertAway: () => {}, validateOutput: () => {},
    createGuard: () => ({ execute: () => assert.fail('unexpected executable'), close: async () => { closed++; }, abort: () => {} }),
    preflight: async () => {}, load: async url => {
      loaded.push(url);
      const worktree = variants[loaded.length - 1].build.worktree;
      return { HOST: join(worktree, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'),
        buildCheck4: async cache => {
          built.push(cache); const host = join(cache, 'host'), sampler = join(cache, 'sampler');
          writeFileSync(host, 'same-binary'); writeFileSync(sampler, 'same-sampler'); return { host, sampler };
        }, prepareMabel: async cache => ({ folder: join(cache, 'characters'), identity: { id: 'mabel' } }) };
    },
  });
  assert.equal(new Set(built).size, 2); assert.equal(new Set(loaded).size, 2);
  assert.match(loaded[0], /\/A\/bench\/hand\/check4-build.mjs$/);
  assert.match(loaded[1], /\/B\/bench\/hand\/check4-build.mjs$/);
  assert.notEqual(prepared.sides.get('A').identity.sourceSHA256, prepared.sides.get('B').identity.sourceSHA256);
  assert.equal(prepared.sides.get('A').identity.binarySHA256, prepared.sides.get('B').identity.binarySHA256);
  await prepared.close(); assert.equal(closed, 1);
});

test('wire observer preserves every byte, records matching placed ack and does not invent one', () => {
  const sent = [], rows = [], child = { pid: 42, stdin: { write: value => { sent.push(value); return true; } }, stdout: new EventEmitter() };
  let time = 100;
  observeHostWire(child, row => rows.push(row), { now: () => time, mono: () => time });
  const request = JSON.stringify({ hand: 'clear', nonce: 'a', token: 't', placed: true, placementSeq: 3 }) + '\n';
  child.stdin.write(request.slice(0, 20)); child.stdin.write(request.slice(20));
  time += 7;
  child.stdout.emit('data', '{"hand":"placed-ready","nonce":"a","token":"unknown"}\n');
  assert.equal(rows.length, 1);
  const ack = '{"hand":"placed-ready","nonce":"a","token":"t"}\n';
  child.stdout.emit('data', ack.slice(0, 15)); child.stdout.emit('data', ack.slice(15));
  assert.equal(rows.length, 2); assert.equal(rows[1].ackMs, 7); assert.equal(rows[1].kind, 'placed-ready');
  assert.equal(sent.join(''), request); assert.equal(JSON.stringify(rows).includes('nonce'), false);
});

const call = { name: 'drag', index: 2, startedAt: new Date(1000).toISOString(), finishedAt: new Date(2000).toISOString() };
const samples = () => [90, 140, 190, 240, 290, 340].map(t => ({ t, epochMs: t + 1000, valid: true,
  status: { pid: 42, shown: true, size: 'stage', seat: 'edge-hang' }, panel: { onScreen: true }, intersections: [] }));
const trace = [
  { t: new Date(1100).toISOString(), direction: 'local-approval', msg: { key: '["sleight","drag","TextEdit"]', action: 'accept' } },
  ...['start', 'end'].map((edge, i) => ({ t: new Date(1400).toISOString(), direction: 'drag-phase', msg: { phase: 'ax-move', edge, monoMs: 150 + i * 100 } })),
];
const wire = [{ event: 'request', id: 1, hostPid: 42, placed: true, requestedAtMs: 1120 },
  { event: 'ack', id: 1, hostPid: 42, kind: 'placed-ready', acknowledgedAtMs: 1130, ackMs: 10 }];
test('per-drag evidence uses monotonic movement, not delayed stderr delivery, and times placement ack', () => {
  const [row] = dragHandEvidence([call], samples(), wire, trace);
  assert.equal(row.stayedSeated, true); assert.equal(row.covered, true); assert.equal(row.samples, 4);
  assert.equal(row.approvalToAXStartMs, 50); assert.deepEqual(row.placementAckMs, [10]);
  assert.equal(row.placement[0].acknowledgedAtMs, 1130);
});

test('hidden character and missing samples stay false or unknown, never successful visibility', () => {
  const hidden = samples(); hidden[2].panel.onScreen = false;
  assert.equal(dragHandEvidence([call], hidden, [], trace)[0].stayedSeated, false);
  assert.equal(dragHandEvidence([call], [], wire, trace)[0].stayedSeated, null);
  assert.equal(dragHandEvidence([call], samples().filter((_, i) => i !== 2 && i !== 3), wire, trace)[0].covered, false);
  assert.equal(dragHandEvidence([call], samples(), [], trace)[0].placementAckMs.length, 0);
  assert.equal(dragHandEvidence([call], samples(), wire, [])[0].approvalToAXStartMs, null);
  const noSeat = samples(); noSeat[2].status.seat = null;
  assert.equal(dragHandEvidence([call], noSeat, wire, trace)[0].stayedSeated, false);
});

const evidence = () => ({ side: side('A'), calls: [call], rows: samples(), wire, trace,
  collection: { collected: true, hosts: [{ pid: 42, collected: true }] }, samplerExit: { code: 0 } });
test('hand-on requires a real owned host, independent samples, movement coverage and collection', () => {
  assert.equal(handRunEvidence(evidence()).verdict, 'measured');
  for (const mutate of [e => { e.collection.hosts = []; }, e => { e.rows = []; },
    e => { e.collection.hosts[0].pid = 43; }, e => { e.collection.collected = false; }, e => { e.samplerExit.code = 1; }]) {
    const broken = evidence(); mutate(broken); assert.equal(handRunEvidence(broken).verdict, 'unmeasured');
  }
});

test('campaign refuses a missing hand arm or shared build and reports both timing medians', () => {
  const runs = ['A', 'B'].map(variant => ({ variant, iteration: 1, verdict: 'pass', cleanupConfirmed: true, calls: [],
    hand: { ...handRunEvidence(evidence()), identity: side(variant).identity } }));
  const report = campaignEvidence(runs, undefined, {});
  assert.equal(report.verdict, 'pass'); assert.equal(report.hand.sides[1].placementAckMedianMs, 10);
  assert.equal(report.hand.sides[1].approvalToAXStartMedianMs, 50);
  const missing = structuredClone(runs); delete missing[0].hand;
  assert.equal(campaignEvidence(missing).verdict, 'diverge');
  runs[1].hand.identity = runs[0].hand.identity;
  assert.equal(campaignEvidence(runs).verdict, 'diverge');
});

test('broken variant dropping hand-on wiring cannot pass a hand-off campaign under a hand-on plan', () => {
  const runs = ['A', 'B'].map(variant => ({ variant, iteration: 1, verdict: 'pass', cleanupConfirmed: true, calls: [] }));
  assert.equal(campaignEvidence(runs).verdict, 'pass');
  const result = campaignEvidence(runs, undefined, {}, { handOn: true });
  assert.equal(result.verdict, 'diverge'); assert.match(result.reason, /missing character evidence/);
});

test('live preflight refuses an open Calculator and waits for hardware idle at boundaries', async () => {
  const closed = async () => { throw Object.assign(Error('not running'), { code: 1 }); };
  let clock = 0; const waits = [];
  await assert.rejects(handPreflight({ execute: async () => {}, readIdle: () => 40 }), /Calculator to be closed/);
  await handPreflight({ execute: closed, readIdle: () => clock / 1000, now: () => clock,
    wait: async ms => { clock += ms; }, recordWait: row => waits.push(row) });
  assert.equal(clock, 30000); assert.deepEqual(waits, [{ kind: 'idle', began: 0, ended: 30000 }]);
  clock = 0;
  await assert.rejects(handPreflight({ execute: closed, readIdle: () => 0, now: () => clock,
    wait: async ms => { clock += ms; } }), /owner-return guard/);
  assert.equal(clock, 120000);
});

test('CH4 cannot pass a hand-on candidate with a missing ack, hidden seat or panel contact', () => {
  const spec = { id: 'CH4', tool: 'drag', fixturePass: true };
  const make = variant => ({ variant, iteration: 1, verdict: 'pass', cleanupConfirmed: true, check: { verdict: 'pass' },
    calls: [{ ...call, recordedArguments: {}, toolMs: 100, result: { content: [] }, comparisonResult: { content: [] } }],
    hand: { ...handRunEvidence(evidence()), identity: side(variant).identity } });
  const baseline = make('A');
  assert.equal(campaignEvidence([baseline, make('B')], spec, { candidate: 'B', baseline: 'A' }).verdict, 'pass');
  for (const change of [row => { row.placedAcknowledgements = 0; }, row => { row.stayedSeated = false; }, row => { row.panelContacts = 1; }]) {
    const candidate = make('B'); change(candidate.hand.drags[0]);
    assert.equal(campaignEvidence([baseline, candidate], spec, { candidate: 'B', baseline: 'A' }).verdict, 'check-incomplete');
  }
});
