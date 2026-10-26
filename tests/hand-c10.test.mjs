// Offline C10 coverage. These tests never start the live fixture or a hand window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = new URL('../', import.meta.url).pathname;
const modulePath = new URL('../bench/hand/c10-night.mjs', import.meta.url);
const temp = () => trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'c10-test-'))));
async function api() {
  assert.ok(existsSync(modulePath), 'C10 runner exists');
  return import(modulePath);
}

test('the plan covers all seven features and makes hardware and audio limits visible', async () => {
  const { steps, dryRunPlan } = await api();
  assert.deepEqual(steps.map(s => s.id), ['pause', 'narration', 'voice', 'picker', 'perch', 'lines', 'replay']);
  const plan = dryRunPlan({ root, night: '<night>' }).join('\n');
  for (const text of ['--owner-away', 'hardware', '80 pt', '600', '3 s', '8 s', 'withheld', 'off by default', 'summary.md', 'screenshot', 'respawn']) assert.ok(plan.includes(text), text);
  for (const mode of ['--narration-voices', '--narration-selftest', '--cursor-menu-dump', '--perch-dump', '--ring-plan-dump', '/usr/bin/sips']) assert.ok(plan.includes(mode), mode);
  assert.ok(steps.every(s => s.estimateSeconds > 0));
});

test('CLI dry-run and missing owner flag do not create an output bank or invoke a compiler', async () => {
  await api(); const dir = temp();
  for (const args of [['--dry-run'], [], ['--surprise']]) {
    const p = spawnSync(process.execPath, ['bench/hand/c10-night.mjs', '--night', dir, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.equal(p.status, args.includes('--dry-run') ? 0 : 2, p.stderr);
    assert.deepEqual(readdirSync(dir), []);
    assert.doesNotMatch(p.stderr, /spawn|compiler|swiftc.*error/);
  }
});

test('result validation requires finite counts, real evidence and an explicit reason for skipped checks', async () => {
  const { validateResult, totals } = await api(); const dir = temp();
  // A PNG signature alone is insufficient evidence.
  writeFileSync(join(dir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const r = { id: 'pause', checks: [{ name: 'restore', status: 'pass', numbers: { acknowledgments: 2 }, screenshot: 'shot.png' }] };
  assert.throws(() => validateResult(r, dir), /PNG/);
  const { encodePng } = await import('../bench/hand/synthetic-character.mjs');
  writeFileSync(join(dir, 'shot.png'), encodePng(2, 2, new Uint8Array(16).fill(255)));
  assert.doesNotThrow(() => validateResult(r, dir));
  for (const check of [ { ...r.checks[0], numbers: { n: NaN } }, { ...r.checks[0], numbers: {} },
    { ...r.checks[0], screenshot: '../escape.png' }, { ...r.checks[0], status: 'skip' }, { ...r.checks[0], screenshot: 'absent.png' } ])
    assert.throws(() => validateResult({ ...r, checks: [check] }, dir));
  assert.deepEqual(totals([{ ...r, checks: [...r.checks, { name: 'hardware', status: 'skip', required: true, reason: 'needs hardware', numbers: { clicks: 0 }, screenshot: null }] }]),
    { pass: 1, fail: 0, skip: 1, requiredSkipped: 1 });
});

test('resume refuses a changed checkout and only reuses passed checks with intact evidence', async () => {
  const { assertIdentity, reusable, evidenceDigest } = await api(); const dir = temp();
  const identity = { root: '/checkout', head: 'a'.repeat(40) };
  assert.doesNotThrow(() => assertIdentity(identity, identity));
  assert.throws(() => assertIdentity(identity, { ...identity, head: 'b'.repeat(40) }), /checkout/);
  writeFileSync(join(dir, 'result.json'), '{}');
  const marker = { status: 'pass', directory: dir, digest: evidenceDigest(dir) };
  assert.equal(reusable(marker), true);
  writeFileSync(join(dir, 'result.json'), '{"changed":true}');
  assert.equal(reusable(marker), false);
  assert.equal(reusable({ ...marker, status: 'fail' }), false);
  assert.equal(reusable({ ...marker, status: 'incomplete' }), false);
});

test('step execution continues after a measured failure, saves each marker, and stops on owner return', async () => {
  const { executeSteps } = await api(); const saved = [], called = [];
  const result = status => ({ checks: [{ name: 'probe', status, numbers: { samples: 1 }, screenshot: 'shot.png' }] });
  const run = async step => { called.push(step.id); if (step.id === 'third') throw Object.assign(Error('owner returned'), { code: 'OWNER' }); return result(step.id === 'first' ? 'fail' : 'pass'); };
  const state = { markers: {} };
  const outcome = await executeSteps([{ id: 'first' }, { id: 'second' }, { id: 'third' }, { id: 'fourth' }], state,
    { run, save: () => saved.push(structuredClone(state)), canReuse: () => false });
  assert.deepEqual(called, ['first', 'second', 'third']);
  assert.deepEqual(saved.map(s => Object.keys(s.markers).length), [1, 2, 3]);
  assert.equal(state.markers.first.status, 'fail'); assert.equal(state.markers.second.status, 'pass');
  assert.equal(state.markers.third.status, 'interrupted'); assert.equal(outcome.stopped, 'OWNER');
});

test('summary counts failures and required skips as incomplete, includes evidence paths and numbers', async () => {
  const { summaryMarkdown } = await api();
  const text = summaryMarkdown({ root, head: 'a'.repeat(40), startedAt: '2026-10-26', markers: {
    pause: { status: 'incomplete', directory: '/bank/pause', checks: [{ name: 'hardware', status: 'skip', required: true, reason: 'fresh hardware input required', numbers: { clicks: 0 }, screenshot: null }] },
    narration: { status: 'fail', directory: '/bank/narration', checks: [{ name: 'clear', status: 'fail', numbers: { pixels: 30 }, screenshot: 'clear.png' }] }
  } });
  for (const part of ['0 passed', '1 failed', '1 skipped', '1 required', 'clear.png', 'pixels=30', 'fresh hardware']) assert.ok(text.includes(part), part);
});

async function checksApi() {
  const path = new URL('../bench/hand/c10-checks.mjs', import.meta.url);
  assert.ok(existsSync(path), 'C10 checks exist'); return import(path);
}
test('narration fixture binds preceding prose, rejects future prose and redacts the fake card', async () => {
  const { narrationFixture } = await checksApi(); const n = narrationFixture();
  assert.equal(n.line, 'I will inspect the menu first.');
  assert.equal(n.future, undefined); assert.equal(n.redacted, 'Checking now.');
  assert.equal(n.fakeCard.replace(/ /g, '').length, 16);
});

test('replay records only delivered pixels through the real relay and recording stays off initially', async () => {
  const { replayProbe } = await checksApi(); const dir = temp();
  const result = await replayProbe({ root: join(dir, 'runs'), lease: join(dir, 'leases'), image: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    encode: async () => ({ mimeType: 'image/jpeg', data: '/9j/2Q==', width: 200, height: 100 }) });
  assert.equal(result.offWriters, 0);
  assert.equal(result.withheldDelivered, 0); assert.equal(result.withheldRecorded, 0);
  assert.equal(result.delivered, 1); assert.equal(result.shots, 1);
  assert.equal(result.replies, 4);
  assert.deepEqual(result.records.filter(r => r.type === 'action').map(r => r.phase), ['aim', 'act', 'done']);
  assert.ok(result.pointPositions > 0);
  assert.equal(result.positions, result.records.length);
  assert.doesNotMatch(result.html, /WITHHELD-C10/);
});

let nativeBins;
async function binaries() {
  if (nativeBins) return nativeBins;
  const dir = temp(), { swiftModuleCache } = await import('../bench/swift-cache.mjs');
  const bins = { host: join(dir, 'consent-host'), fixture: join(dir, 'c10-fixture') };
  for (const [source, out] of [['plugins/sleight/lib/direct-browser/native/consent-host.swift', bins.host], ['bench/hand/c10-fixture.swift', bins.fixture]]) {
    assert.ok(existsSync(join(root, source)), source);
    const p = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), join(root, source), '-o', out], { encoding: 'utf8', timeout: 300000 });
    assert.equal(p.status, 0, p.stderr);
  }
  return nativeBins = bins;
}
const native = { skip: process.platform !== 'darwin' && 'macOS compiler only' };
test('fixture selftest and invalid args construct no application or window', native, async t => {
  const { fixture } = await binaries();
  const p = spawnSync(fixture, ['--selftest'], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
  const data = JSON.parse(p.stdout); assert.equal(data.windowsCreated, 0); assert.equal(data.margin, 80);
  assert.equal(spawnSync(fixture, ['--unknown']).status, 64);
  t.diagnostic(`fixtureBytes=${(await import('node:fs')).statSync(fixture).size}`);
});

test('native dump recipes verify narration geometry, perch cover and sleep, and 3/8 second line boundaries', native, async t => {
  const { buildCharacter, dumpScenarios, evaluateDump } = await checksApi(); const { host } = await binaries();
  const base = trackTemp(realpathSync(mkdtempSync(join('/private', 'tmp', 'c10-fixture-test-'))));
  const character = buildCharacter(base);
  const target = { pid: 42, id: 7, frame: [200, 200, 800, 500], displays: [{ frame: [0, 0, 1440, 900], top: 25 }] };
  const scenarios = dumpScenarios(target, character.frame);
  for (const s of scenarios) {
    const p = spawnSync(host, s.args, { input: s.frames.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 20000,
      env: { ...process.env, ...character.env } });
    assert.equal(p.status, 0, `${s.id}: ${p.stderr}`);
    const rows = p.stdout.trim().split('\n').map(JSON.parse);
    const answer = evaluateDump(s.id, rows);
    assert.equal(answer.pass, true, `${s.id}: ${JSON.stringify(answer)}`);
    t.diagnostic(`${s.id}: ${JSON.stringify(answer.numbers)}`);
  }
});

test('capture text matching joins at most two rows and does not accept missing text', async () => {
  const { textMatches } = await checksApi();
  assert.equal(textMatches(['I will inspect', 'the menu first.'], 'I will inspect the menu first.'), true);
  assert.equal(textMatches(['Unrelated', 'text'], 'Checking now.'), false);
  assert.equal(textMatches(undefined, 'All done.'), false);
  assert.equal(textMatches(['anything'], ''), false);
});

test('child channel waits for fresh acknowledgments and closes through EOF', async () => {
  const { Children } = await api(); const dir = temp(), script = join(dir, 'child.mjs');
  writeFileSync(script, "import {createInterface} from 'node:readline';\nconst lines=createInterface({input:process.stdin});\nlines.on('line', text=>process.stdout.write(text+'\\n'));\n");
  const children = new Children(process.env, new AbortController().signal);
  try {
    const channel = children.start(process.execPath, [script]);
    channel.send({ ack: true, serial: 1 }); await channel.wait(r => r.ack);
    const after = channel.rows.length; channel.send({ ack: true, serial: 2 });
    assert.equal((await channel.wait(r => r.ack, 1000, after)).serial, 2);
    assert.equal((await channel.close()).code, 0);
    assert.equal(children.live.size, 0);
  } finally { await children.close(); }
});

test('a timeout collects an owned child that ignores SIGTERM', async () => {
  const { Children } = await api(); const dir = temp(), script = join(dir, 'hang.mjs');
  writeFileSync(script, "process.on('SIGTERM',()=>{});\nsetInterval(()=>{},100);\n");
  const children = new Children(process.env, new AbortController().signal);
  try {
    await assert.rejects(Promise.race([children.run(process.execPath, [script], { timeout: 100 }),
      new Promise((_, reject) => setTimeout(() => reject(Error('uncollected child')), 3500))]), /timed out/);
    assert.equal(children.live.size, 0);
  } finally { await children.close(); }
});

test('evidence banks reject a foreign or linked destination', async () => {
  const { assertBank } = await api(); const dir = temp(), bank = join(dir, 'c10-bank');
  const { mkdirSync, symlinkSync } = await import('node:fs'); mkdirSync(bank, { mode: 0o700 });
  assert.doesNotThrow(() => assertBank(bank, dir));
  assert.throws(() => assertBank(dir, bank));
  const alias = join(dir, 'alias'); symlinkSync(bank, alias);
  assert.throws(() => assertBank(alias, dir));
});

test('synthetic character validates through the shipped native decoder without showing a panel', native, async t => {
  const { buildCharacter } = await checksApi(), { host } = await binaries();
  const base = trackTemp(realpathSync(mkdtempSync(join('/private', 'tmp', 'c10-decode-test-')))), c = buildCharacter(base);
  const p = spawnSync(host, ['--check-character'], { input: JSON.stringify(c.frame) + '\n', encoding: 'utf8', timeout: 20000, env: { ...process.env, ...c.env } });
  assert.equal(p.status, 0, p.stderr); assert.equal(JSON.parse(p.stdout).loaded, true);
  t.diagnostic(`hostBytes=${(await import('node:fs')).statSync(host).size}`);
});

test('all seven check drivers emit frames accepted by the native validator through simulated GUI boundaries', native, async t => {
  const { runCheck } = await checksApi(), { host: binary } = await binaries();
  const { Children, steps, validateResult } = await api();
  const { encodePng } = await import('../bench/hand/synthetic-character.mjs');
  const work = trackTemp(realpathSync(mkdtempSync(join('/private', 'tmp', 'c10-driver-test-'))));
  const real = new Children(process.env, new AbortController().signal);
  let traces = 0;
  try {
    for (const step of steps) {
      const directory = join(work, step.id); (await import('node:fs')).mkdirSync(directory, { mode: 0o700 });
      const sessions = [];
      let shown = false, style = 'sprite', covered = false, active;
      const ready = { pid: 42, id: 7, frame: [200, 200, 800, 500], displays: [{ frame: [0, 0, 1440, 900], top: 25 }], clusterRightPt: 68 };
      const children = { env: process.env,
        run: (command, args, options) => args[0] === '--narration-voices' ? Promise.resolve('[{"id":"fixture","name":"Fixture","language":"en"}]') : real.run(binary, args, options),
        start: (_command, _args, options) => {
          const input = [], rows = []; sessions.push({ input, env: options.env });
          const channel = { child: { pid: 100 }, rows,
            send(frame) {
              input.push(frame);
              if (frame.hand === 'character') { rows.push({ hand: 'character', id: frame.id, loaded: true }); input.push({ dumpAwait: 'character' }); }
              if (frame.hand === 'pause-ack') rows.push({ hand: 'pause', token: frame.token, phase: 'restored', paused: frame.paused });
              if (frame.hand === 'clear') { shown = false; rows.push({ hand: 'clear-ready', token: frame.token }); }
              if (frame.hand === 'picker' && frame.op === 'style') style = frame.style;
              if (['aim', 'act', 'status'].includes(frame.hand)) shown = true;
            },
            wait(predicate, _ms, after = 0) { const row = rows.slice(after).find(predicate); assert.ok(row, 'ack emitted'); return Promise.resolve(row); },
            close: async () => ({ code: 0 }),
          }; active = channel; return channel;
        },
      };
      const fixture = {
        send(row) {
          if (row.op === 'cover') covered = row.covered;
          this.reply = { ...ready, token: row.token };
          if (row.op === 'shot') {
            writeFileSync(join(directory, row.name), encodePng(2, 2, new Uint8Array(16).fill(255)));
            this.reply = { ...this.reply, screenshot: row.name, captureFrame: [0,0,2,2], spritePixels: shown && style === 'sprite' && !covered ? 100 : 0,
              hostWindows: shown ? 1 : 0, texts: ['I will inspect the menu first.', 'Checking now.', 'Ready to begin.', 'First step done.', 'That needs a look.', 'All done.'] };
          }
          if (row.op === 'replay') {
            const html = readFileSync(join(directory, 'replay.html'), 'utf8');
            const data = JSON.parse(html.match(/<script[^>]*id="run-data"[^>]*>([\s\S]*?)<\/script>/)[1]);
            this.reply = { ...this.reply, positions: data.length, withheld: 0, imageShown: true };
          }
        },
        wait(predicate) { assert.ok(predicate(this.reply)); return Promise.resolve(this.reply); },
      };
      const result = await runCheck(step.id, { children, fixture, ready, directory, bin: work, work, sleep: async () => {}, signal: new AbortController().signal });
      validateResult(result, directory);
      assert.ok(result.checks.length > 0);
      for (const session of sessions) {
        real.env = session.env;
        const dump = await real.run(binary, ['--ring-plan-dump', '--cursor-style=sprite'], { input: session.input.map(r => JSON.stringify(r)).join('\n') + '\n' }).catch(e => { throw Error(`${step.id}: ${e.message}`); });
        assert.ok(dump.includes('"effect":"end"'));
        assert.ok(dump.includes('"loaded":true'), `${step.id}: synthetic sheet decoded`);
        traces++;
      }
      if (['pause', 'picker', 'voice'].includes(step.id)) assert.ok(result.checks.some(c => c.required && c.status === 'skip'));
      assert.ok(active);
    }
    t.diagnostic(`validatedDriverSessions=${traces}; GUI observations are simulated, no windows opened`);
  } finally { await real.close(); }
});
