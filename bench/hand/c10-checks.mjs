// C10 recipes and live checks. Native dumps share the shipped runtimes. Nothing runs on import.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { installSyntheticCharacter, characterEnv } from './synthetic-character.mjs';
import { loadCharacter, resolveCharacterStates } from '../../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../../plugins/sleight/lib/hand/character-frame.mjs';
import { assistantNarration, narrationLine, createNarrationCache } from '../../plugins/sleight/hooks/narration.mjs';
import { createSessionPause } from '../../plugins/sleight/lib/session-pause.mjs';
import { handSetting } from '../../plugins/sleight/lib/hand/settings.mjs';
import { createCursorEvents } from '../../plugins/sleight/lib/hand/events.mjs';
import { createRunRecorder, readRun } from '../../plugins/sleight/lib/runs/store.mjs';
import { downscaleScreenshot } from '../../plugins/sleight/lib/runs/screenshot.mjs';
import { buildRunHTML, replayFrame } from '../../plugins/sleight/lib/runs/viewer.mjs';
import { createCursorPicker } from '../../plugins/sleight/lib/hand/cursor-picker.mjs';
import { InputLease } from '../../plugins/sleight/lib/input-lease.mjs';
import { createRelay } from '../../plugins/sleight/lib/relay.mjs';

const nonce = 'a'.repeat(64), token = () => randomBytes(16).toString('hex');
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const parsed = text => text.trim().split('\n').filter(Boolean).map(JSON.parse);
export const textMatches = (rows, expected) => {
  const normalize = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!expected || !normalize(expected)) return false;
  return (rows ?? []).some((_, i) => normalize(rows.slice(i, i + 2).join(' ')).includes(normalize(expected)));
};
const menu = (narration = 'off', voice) => ({ hand: 'menu', nonce, enabled: true, capture: 'visible', version: '1.5.0', narration, ...voice ? { voice } : {} });
const options = (perch, lines = true) => ({ hand: 'picker', nonce, op: 'options', perch, lines });
const clock = dumpClock => ({ dumpClock });
export function frames(target) {
  let seq = 1;
  const [x, y, w, h] = target.frame, at = [x + w / 2, y + h / 2];
  const base = () => ({ nonce, seq: ++seq, pid: target.pid, windowId: target.id, at });
  return {
    character: value => ({ ...value, seq: ++seq }),
    aim: extra => ({ ...base(), hand: 'aim', kind: 'click', ...extra }),
    act: extra => ({ ...base(), hand: 'act', kind: 'click', path: [at], delayMs: 0, beats: 1, ...extra }),
    status: (state, extra) => ({ ...base(), hand: 'status', state, ...extra }),
    clear: () => ({ hand: 'clear', nonce, token: token() }),
  };
}
export function narrationFixture() {
  const sentence = 'I will inspect the menu first.', fakeCard = '4111 1111 1111 1111';
  const rows = [
    { role: 'user', content: [{ type: 'tool_result', content: 'WITHHELD-C10 result' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'WITHHELD-C10 thinking' }, { type: 'text', text: sentence },
      { type: 'tool_use', id: 'c10-call', name: 'sleight', input: {} }, { type: 'text', text: 'Future prose.' }] },
  ];
  const cache = createNarrationCache(); cache.configure('bubbles');
  cache.observe({ uuid: 'c10', origin: { kind: 'model' }, message: rows[1] });
  return { rows, fakeCard, line: assistantNarration(rows, 'c10-call'), cacheLine: cache.take({ tool_use_id: 'c10-call' }),
    future: assistantNarration([{ role: 'assistant', content: [{ type: 'tool_use', id: 'future' }, { type: 'text', text: sentence }] }], 'future'),
    redacted: narrationLine(`Checking ${fakeCard} now.`) };
}
export function buildCharacter(base, id = 'c10-synthetic') {
  const c = installSyntheticCharacter({ base, id });
  const manifest = { format: 'sleight-character', version: 1, id, name: 'C10 synthetic', description: '', author: 'sleight', license: 'MIT',
    sheet: 'sheet.png', frame: { w: 128, h: 128 }, grid: { cols: 8, rows: 1 }, scale: 0.5, anchor: { x: 64, y: 110 }, hotspot: { x: 64, y: 64 },
    states: { idle: { row: 0, frames: 8, ms: 120, loop: true } },
    lines: { start: ['Ready to begin.'], 'first-click': ['First step done.'], error: ['That needs a look.'], done: ['All done.'] } };
  writeFileSync(join(c.folder, 'character.json'), JSON.stringify(manifest), { mode: 0o600 });
  const pack = loadCharacter(c.folder, { installed: true });
  return { ...c, pack, env: characterEnv(c.root), frame: characterFrame(pack, { nonce, seq: 1, resolve: resolveCharacterStates }) };
}
export function dumpScenarios(target, character) {
  const scene = (cover = false) => ({ dumpWorld: { windows: [...cover ? [{ id: target.id + 1, pid: target.pid, frame: [target.frame[0] - 30, target.frame[1] - 160, target.frame[2] + 60, target.frame[3] + 320] }] : [],
    { id: target.id, pid: target.pid, frame: target.frame }], displays: target.displays } });
  const prefix = () => [character, options(true), scene()];
  const ringArgs = ['--ring-plan-dump', '--cursor-style=ring', `--clip=${target.frame.join(',')}`];
  const perchArgs = ['--perch-dump', '--seed=1'];
  let f = frames(target); const n = narrationFixture();
  const narration = { id: 'narration-plan', args: ringArgs, frames: [menu('bubbles'), f.act({ say: n.line, label: 'Fixture menu' })] };
  f = frames(target);
  const redact = { id: 'redaction-plan', args: ringArgs, frames: [menu('bubbles'), f.act({ say: `Checking ${n.fakeCard} now.` })] };
  f = frames(target);
  const clear = { id: 'clear-plan', args: ringArgs, frames: [menu('bubbles'), f.act({ say: n.line }), clock(1), f.clear(), clock(1.1)] };
  f = frames(target);
  const covered = { id: 'covered-sleep-plan', args: perchArgs, frames: [...prefix(), f.aim(), clock(2), scene(true), clock(604)] };
  const boundaries = [
    ['lines-3-before', 2.999, 'error'], ['lines-3-at', 3, 'error'],
    ['lines-8-before', 7.999, 'done'], ['lines-8-at', 8, 'done'],
  ].map(([id, at, state]) => { const f = frames(target); return { id, args: perchArgs, frames: [...prefix(), f.aim(), clock(at), f.status(state, state === 'done' ? { ok: true } : {})] }; });
  f = frames(target);
  const moments = { id: 'lines-moments', args: perchArgs, frames: [...prefix(), f.aim(), clock(8), f.status('done', { ok: true }),
    clock(11), f.status('error'), clock(14), f.act(), f.status('done', { ok: true }), clock(17), f.status('done')] };
  return [narration, redact, clear, covered, ...boundaries, moments];
}
export function evaluateDump(id, rows) {
  const draws = rows.filter(r => r.effect === 'draw'), lines = rows.filter(r => r.effect === 'line');
  if (id === 'narration-plan') {
    const p = draws[0], b = p?.bubble, c = p?.chip;
    const gap = b && c ? c.frame[1] - b.frame[1] - b.frame[3] : -1;
    return { pass: b?.text?.replace(/\n/g, ' ') === narrationFixture().line && gap === 4,
      numbers: { draws: draws.length, gapPt: gap, bubbleRows: b?.text?.split('\n').length ?? 0 } };
  }
  if (id === 'redaction-plan') return { pass: draws[0]?.bubble?.text === 'Checking now.', numbers: { bubbles: draws.filter(p => p.bubble).length, leakedDigits: (draws.map(p => p.bubble?.text ?? '').join(' ').match(/4111/g) ?? []).length } };
  if (id === 'clear-plan') return { pass: rows.some(r => r.effect === 'hide' && r.time === 1) && !draws.some(r => r.time >= 1), numbers: { hides: rows.filter(r => r.effect === 'hide').length, drawsDuringClear: draws.filter(r => r.time >= 1).length } };
  if (id === 'covered-sleep-plan') {
    const hide = rows.filter(r => r.effect === 'perch-hide'), end = rows.at(-1);
    return { pass: hide.some(r => r.reason === 'covered') && end.poll === null && end.shown === false,
      numbers: { coverHides: hide.filter(r => r.reason === 'covered').length, shownAtEnd: Number(end.shown), pollingAtEnd: Number(end.poll !== null), simulatedSeconds: 604 } };
  }
  const expected = id === 'lines-moments' ? ['start', 'first-click', 'error', 'done'] : ['start', ...id.endsWith('-at') ? [id.startsWith('lines-3') ? 'error' : 'first-click'] : []];
  const moments = lines.map(r => r.moment);
  return { pass: JSON.stringify(moments) === JSON.stringify(expected), numbers: { lines: lines.length, expectedLines: expected.length,
    lastLineAtS: lines.at(-1)?.time ?? -1, minimumGapS: lines.length > 1 ? Math.min(...lines.slice(1).map((r,i) => r.time - lines[i].time)) : 0 } };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
/** Real relay transport and private run writer, with authored engine responses. No engine, apps or browser connection. */
export async function replayProbe({ root, lease, image, encode, target = { id: 7, pid: 42, frame: [100, 200, 200, 100] } }) {
  let offWriters = 0, withheldRecorded = 0;
  const off = createCursorEvents({ env: {}, setting: () => handSetting({ env: {}, platform: 'darwin', path: join(root, 'absent-hand.json') }),
    recorder: () => { offWriters++; throw Error('Off writer constructed'); } });
  off.status('thinking'); off.screenshot([image]); await off.close();
  let recorder;
  const events = createCursorEvents({ env: {}, setting: () => ({ record_runs: true, narration: 'bubbles' }),
    recorder: opts => recorder = createRunRecorder({ ...opts, root, encode: async input => {
      if (Buffer.from(input.data, 'base64').toString().startsWith('WITHHELD-C10')) withheldRecorded++;
      return (encode ?? downscaleScreenshot)(input);
    } }) });
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const delivered = []; serverIn.resume();
  clientOut.on('data', chunk => { for (const line of chunk.toString().trim().split('\n')) if (line) delivered.push(JSON.parse(line)); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'c10', changeReview: false,
    cursor: { status: (...args) => events.status(...args), close: () => events.close(),
      screenshot: (content, detail) => events.screenshot(content, { ...detail, windowId: target.id }) },
    inputLease: new InputLease({ directory: lease, holder: 'c10' }), permissions: { app: query => query?.bundleId === 'com.example.c10-blocked' ? 'C10 fixture blocked.' : undefined } });
  try {
    events.status('thinking', { say: 'I will inspect the fixture.' });
    const call = events.call(), [x, y, w, h] = target.frame;
    const action = { call, index: 0, kind: 'click', source: 'native', point: [x + w / 2, y + h / 2],
      window: { id: target.id, pid: target.pid, rect: target.frame } };
    events.action({ ...action, phase: 'aim' }); events.action({ ...action, phase: 'act' });
    for (const [id, appId] of [[1, 'com.example.c10-allowed'], [2, 'com.example.c10-blocked'], [3, 'com.apple.LocalAuthentication.UIAgent'], [4, 'consent-host']]) {
      clientIn.write(jsonl([{ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: '1+1' } } }])); await settle();
      serverOut.write(jsonl([{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Fixture response.' },
        id === 1 ? image : { type: 'image', mimeType: 'image/png', data: Buffer.from('WITHHELD-C10-' + id).toString('base64') }],
        _meta: { 'codex/toolSurface': { app: { appId } } } } }])); await settle();
    }
    events.action({ ...action, phase: 'done' });
    await events.flushRecording(); await events.close();
    const records = await readRun(recorder.stats().id, { root });
    const html = buildRunHTML(records);
    return { offWriters, records, html, delivered: delivered.filter(r => r.id === 1).flatMap(r => r.result?.content ?? []).filter(c => c.type === 'image').length,
      withheldDelivered: delivered.filter(r => [2,3,4].includes(r.id)).flatMap(r => r.result?.content ?? []).filter(c => c.type === 'image').length,
      withheldRecorded,
      shots: records.filter(r => r.type === 'screenshot').length,
      replies: delivered.length, positions: records.length,
      pointPositions: records.map((_, i) => replayFrame(records, i)).filter(r => r.point).length, bytes: recorder.stats().bytes };
  } finally { relay.close(); await events.close(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); }
}

export async function runCheck(id, ctx) {
  const { children, fixture, ready, directory, bin, work, sleep } = ctx;
  const character = buildCharacter(work), target = ready, f = frames(target), checks = [];
  let host;
  const request = async row => { const key = token(); fixture.send({ ...row, token: key }); const answer = await fixture.wait(r => r.token === key); if (answer.error) throw Error(answer.error); return answer; };
  const start = async () => {
    host = children.start(join(bin, 'consent-host'), ['--hand', '--capture=visible', '--cursor-style=sprite', '--menu'], { env: { ...children.env, ...character.env } });
    host.send(menu()); host.send(character.frame);
    const loaded = await host.wait(r => r.hand === 'character' && r.id === character.id);
    if (loaded.loaded !== true) throw Error('Synthetic character refused');
    return host;
  };
  const shot = async name => {
    const result = await request({ op: 'shot', name: `${name}.png`, host: host.child.pid });
    writeFileSync(join(directory, `${name}.capture.json`), JSON.stringify(result), { mode: 0o600 });
    return result;
  };
  const check = (name, pass, numbers, evidence, reason) => checks.push({ name, status: pass ? 'pass' : 'fail', numbers, screenshot: evidence.screenshot, ...reason ? { reason } : {} });
  const skip = (name, reason, numbers = { observations: 0 }, required = true, evidence) => checks.push({ name, status: 'skip', required, reason, numbers, screenshot: evidence?.screenshot ?? null });
  const dump = async scenario => {
    const raw = await children.run(join(bin, 'consent-host'), scenario.args, { input: jsonl(scenario.frames) });
    writeFileSync(join(directory, `${scenario.id}.jsonl`), raw, { mode: 0o600 });
    return evaluateDump(scenario.id, parsed(raw));
  };
  try {
    await start(); await sleep(500);
    const baseline = await shot('baseline');
    if (id === 'pause') {
      const pause = createSessionPause(), stale = pause.checkpoint(); pause.set(true);
      let blocked = 0; try { stale(); } catch (e) { blocked += Number(e.notRun === true); }
      const restore = async value => {
        const key = token(); host.send({ hand: 'pause-ack', nonce, phase: 'restore', token: key, paused: value });
        return host.wait(r => r.hand === 'pause' && r.phase === 'restored' && r.token === key && r.paused === value);
      };
      await restore(true); host.send(f.status('paused')); await sleep(500); const pausedShot = await shot('paused');
      await host.close(); await start(); await restore(pause.paused);
      host.send(f.status('paused')); await sleep(500); const restoredShot = await shot('respawn-paused');
      try { pause.checkpoint()(); } catch (e) { blocked += Number(e.notRun === true); }
      pause.set(false); try { stale(); } catch (e) { blocked += Number(e.notRun === true); }
      pause.checkpoint()(); await restore(false);
      check('pause checkpoint before next action', blocked === 3, { blockedActions: blocked, resumedCheckpoints: 1 }, pausedShot, 'Session checkpoint fixture, no engine action was dispatched.');
      check('paused host respawn restore acknowledgment', pause.paused === false, { hosts: 2, pauseRestoreAcks: 2, resumeAcks: 1 }, restoredShot, 'Parent restore protocol; relay crash recovery and physical controls still need a person.');
      skip('menu row and character hardware click', 'Both controls require fresh hardware input. Injected input or an AX press cannot qualify them in an owner-away run.', { clicks: 0 }, true, pausedShot);
    } else if (id === 'narration') {
      const n = narrationFixture();
      host.send(menu('bubbles')); host.send(f.act({ say: n.line, label: 'Fixture menu' })); await sleep(350);
      const picture = await shot('sentence');
      const plan = await dump(dumpScenarios(target, character.frame).find(s => s.id === 'narration-plan'));
      check('sentence row order and bubble above label', plan.pass && textMatches(picture.texts, n.line) && n.future === undefined && n.cacheLine === n.line, { ...plan.numbers, recognized: Number(textMatches(picture.texts, n.line)), precedingRows: 1, futureRowsUsed: Number(n.future !== undefined), cacheMatches: Number(n.cacheLine === n.line) }, picture, 'Authored assistant rows through the production parser and response cache; no Claude turn run.');
      const redaction = await dump(dumpScenarios(target, character.frame).find(s => s.id === 'redaction-plan'));
      host.send(f.act({ say: `Checking ${n.fakeCard} now.` })); await sleep(350);
      const redactedShot = await shot('redaction');
      check('fake card redaction', redaction.pass && n.redacted === 'Checking now.' && textMatches(redactedShot.texts, n.redacted) && !redactedShot.texts.join(' ').includes('4111'),
        { ...redaction.numbers, cardDigits: 16, recognized: Number(textMatches(redactedShot.texts, n.redacted)) }, redactedShot);
      const key = token(); host.send({ hand: 'clear', nonce, token: key }); await host.wait(r => r.hand === 'clear-ready' && r.token === key); await sleep(250);
      const cleared = await shot('clear'), planClear = await dump(dumpScenarios(target, character.frame).find(s => s.id === 'clear-plan'));
      check('nothing shown during clear', planClear.pass && cleared.spritePixels === baseline.spritePixels && cleared.hostWindows === 0,
        { ...planClear.numbers, spritePixels: cleared.spritePixels, baselinePixels: baseline.spritePixels, hostWindows: cleared.hostWindows }, cleared);
    } else if (id === 'voice') {
      const defaults = handSetting({ env: {}, platform: 'darwin', path: join(work, 'absent-hand.json') });
      check('voice off by default', defaults.narration === 'off', { defaultVoiceEnabled: Number(defaults.narration === 'voice') }, baseline);
      const voices = JSON.parse(await children.run(join(bin, 'consent-host'), ['--narration-voices']));
      writeFileSync(join(directory, 'voices.json'), JSON.stringify(voices), { mode: 0o600 });
      if (!voices.length) skip('one spoken line and pause', 'No installed system voice; C10 never downloads one.', { installedVoices: 0 });
      else {
        host.send(menu('voice', { id: voices[0].id, rate: 0.5 }));
        host.send(f.act({ say: 'I will inspect this fixture before taking the next step.' })); await sleep(800);
        const speaking = await shot('voice-requested');
        const key = token(); host.send({ hand: 'pause-ack', nonce, phase: 'restore', token: key, paused: true }); await host.wait(r => r.token === key && r.phase === 'restored');
        host.send(f.status('paused')); await sleep(200); const paused = await shot('voice-paused');
        const cancellation = JSON.parse(await children.run(join(bin, 'consent-host'), ['--narration-selftest'], { input: jsonl([{ installed: ['fixture'], voice: { id: 'fixture', rate: 0.5 }, lines: ['One line.', { cancel: true }] }]) }));
        check('narrator cancellation model', cancellation.started.length === 1 && cancellation.active === null, { requestedLines: 1, installedVoices: voices.length, modelStarts: cancellation.started.length, modelStops: cancellation.stops }, paused, 'Selftest cancellation, not physical pause or audible playback.');
        skip('audible start and pause cutting a speaking line', 'The host exposes no speaking acknowledgment. No microphone capture is allowed. Known low: an active line may continue for up to 15 s after pause.', { requestedLines: 1, audioRecordings: 0, pauseAfterMs: 800 }, true, speaking);
      }
    } else if (id === 'picker') {
      // C8 may land at integration. Use only bundled data, never the owner\'s installed characters or Codex pets.
      const source = new URL('../../plugins/sleight/characters/', import.meta.url).pathname;
      const home = join(work, 'picker-home'); mkdirSync(home, { mode: 0o700 });
      let selected;
      const picker = createCursorPicker({ root: character.root, home, env: {}, writeSetting: value => { selected = value; } });
      const catalog = await picker.catalog();
      const nativeCatalog = parsed(await children.run(join(bin, 'consent-host'), ['--cursor-menu-dump'],
        { input: jsonl([{ hand: 'picker', nonce, op: 'catalog', rows: catalog.rows }]) }))[0];
      host.send({ hand: 'picker', nonce, op: 'catalog', rows: catalog.rows });
      writeFileSync(join(directory, 'catalog.json'), JSON.stringify(nativeCatalog), { mode: 0o600 });
      if (!existsSync(source)) skip('built-in character list', 'C8 built-ins are absent from this checkout.', { builtins: 0 }, false, baseline);
      else {
        const names = readdirSync(source).filter(name => existsSync(join(source, name, 'character.json')));
        const listed = catalog.installed.filter(c => c.builtin).map(c => c.id);
        const nativeRows = nativeCatalog.rows.filter(r => names.includes(r.character));
        writeFileSync(join(directory, 'builtins.json'), JSON.stringify({ bundled: names, listed }), { mode: 0o600 });
        check('built-in character list', names.length > 0 && names.every(name => listed.includes(name)) && nativeRows.length === names.length,
          { bundled: names.length, listed: listed.length, nativeRows: nativeRows.length }, baseline, 'Catalog through the real native parser. Opening the hardware menu remains unverified.');
      }
      await picker.apply({ op: 'select', style: 'ring' });
      host.send({ hand: 'picker', nonce, op: 'style', style: 'ring' }); host.send(f.aim()); await sleep(500);
      const ring = await shot('ring-before-switch');
      const applied = await picker.apply({ op: 'select', style: 'sprite', character: character.id });
      const after = host.rows.length;
      host.send({ hand: 'picker', nonce, op: 'style', style: 'sprite' }); host.send(f.character(character.frame));
      await host.wait(r => r.hand === 'character' && r.id === character.id && r.loaded, 5000, after);
      host.send(f.aim()); await sleep(500); const next = await shot('next-frame');
      check('selection plumbing and next sprite frame', applied.ok && selected?.character === character.id && ring.spritePixels === baseline.spritePixels && next.spritePixels > ring.spritePixels,
        { catalogRows: catalog.rows.length, installedCharacters: catalog.installed.length, selected: Number(selected?.character === character.id), ringPixels: ring.spritePixels, spritePixels: next.spritePixels }, next,
        'Synthetic catalog and parent-issued style frame. Does not prove a hardware menu selection.');
      skip('hardware picker selection', 'Fresh hardware input is required for native menu selection; no injected click is substituted.', { clicks: 0 }, true, next);
    } else if (id === 'perch') {
      host.send(options(true, false)); host.send(f.aim()); await sleep(1200);
      const seated = await shot('seated'), geometry = await request({ op: 'state' });
      const raw = await children.run(join(bin, 'consent-host'), ['--perch-dump'], { input: jsonl([character.frame, options(true), { dumpWorld: { windows: [{ id: target.id, pid: target.pid, frame: target.frame }], displays: target.displays } }, { dumpDecode: true }, f.aim()]) });
      writeFileSync(join(directory, 'seat-plan.jsonl'), raw, { mode: 0o600 });
      const rows = parsed(raw), seat = rows.find(r => r.effect === 'perch')?.seat, legs = rows.find(r => r.effect === 'legs')?.legs;
      const legLeft = seat && legs ? seat.x - legs[0] - target.frame[0] : -1;
      check('seat and traffic-light margin', seated.spritePixels > baseline.spritePixels && geometry.clusterRightPt <= 80 && legLeft >= geometry.clusterRightPt + 8,
        { spritePixels: seated.spritePixels, measuredClusterRightPt: geometry.clusterRightPt, constantPt: 80, spriteLegLeftPt: legLeft, gapPt: legLeft - geometry.clusterRightPt }, seated,
        'Cluster measured from all three real fixture title-bar buttons. Seat and leg footprint measured by the shipped dump.');
      await request({ op: 'cover', covered: true }); await sleep(1500); const covered = await shot('covered');
      check('cover by another fixture window', covered.spritePixels === baseline.spritePixels, { seatedPixels: seated.spritePixels, coveredPixels: covered.spritePixels, coverWindows: 1 }, covered);
      await request({ op: 'cover', covered: false }); await sleep(1500); const uncovered = await shot('uncovered');
      check('uncover restores seat', uncovered.spritePixels > baseline.spritePixels, { uncoveredPixels: uncovered.spritePixels }, uncovered);
      if (ready.displays.length < 2) skip('second display', 'Only one display is present.', { displays: ready.displays.length }, false, uncovered);
      else {
        const second = await request({ op: 'display', index: 1 });
        host.send(f.aim({ at: [second.frame[0] + second.frame[2] / 2, second.frame[1] + second.frame[3] / 2] })); await sleep(1200);
        const image = await shot('second-display'); check('second display seat', image.spritePixels > 0, { displays: ready.displays.length, displayIndex: 1, spritePixels: image.spritePixels }, image);
      }
      const deep = await dump(dumpScenarios(target, character.frame).find(s => s.id === 'covered-sleep-plan'));
      check('600 second stop in runtime dump', deep.pass, deep.numbers, covered, 'Simulated clock only.');
      skip('10 minute covered live sleep', 'No test-only live sleep-duration flag exists in this host. The 600 s runtime dump ran; wall-clock sleep was not run.', { liveSeconds: 0, dumpSeconds: 604 }, false, covered);
    } else if (id === 'lines') {
      host.send(options(true, true));
      const actions = [[0, f.aim(), 'start'], [8000, f.status('done', { ok: true }), 'first-click'], [11000, f.status('error'), 'error'],
        [14000, f.act(), null], [14001, f.status('done', { ok: true }), null], [17000, f.status('done'), 'done']];
      const began = Date.now(), expected = { start: 'Ready to begin.', 'first-click': 'First step done.', error: 'That needs a look.', done: 'All done.' };
      for (const [at, frame, name] of actions) {
        await sleep(Math.max(0, at - (Date.now() - began))); host.send(frame); const sentAt = Date.now() - began;
        if (name) {
          await sleep(150); const image = await shot(name);
          check(`live ${name} text`, textMatches(image.texts, expected[name]),
            { scheduledAtMs: at, actualAtMs: sentAt, recognized: Number(textMatches(image.texts, expected[name])), spritePixels: image.spritePixels }, image,
            'OCR of the owned fixture capture; failed OCR keeps the image for review.');
        }
      }
      for (const scenario of dumpScenarios(target, character.frame).filter(s => s.id.startsWith('lines-'))) {
        const answer = await dump(scenario); check(scenario.id, answer.pass, answer.numbers, { screenshot: 'done.png' }, 'Shipped runtime on a simulated clock, beside the live frame screenshots.');
      }
    } else if (id === 'replay') {
      const image = { type: 'image', mimeType: 'image/png', data: readFileSync(join(directory, baseline.screenshot)).toString('base64') };
      const probe = await replayProbe({ root: join(work, 'runs'), lease: join(work, 'leases'), image,
        target: { ...target, frame: baseline.captureFrame } });
      writeFileSync(join(directory, 'replay.html'), probe.html, { mode: 0o600 });
      writeFileSync(join(directory, 'recorded.jsonl'), jsonl(probe.records), { mode: 0o600 });
      check('recording off by default', probe.offWriters === 0, { offWriters: probe.offWriters }, baseline);
      check('withheld content excluded and timeline replayed', probe.replies === 4 && probe.shots === 1 && probe.delivered === 1 && probe.pointPositions > 0 && probe.withheldDelivered === 0 && probe.withheldRecorded === 0 && !probe.html.includes('WITHHELD-C10'),
        { records: probe.records.length, replayPositions: probe.positions, pointPositions: probe.pointPositions, replies: probe.replies, deliveredShots: probe.delivered, recordedShots: probe.shots, withheldDelivered: probe.withheldDelivered, withheldRecorded: probe.withheldRecorded, bytes: probe.bytes }, baseline,
        'Authored actions and engine replies traverse the production relay, writer and replay reducer. Fixture geometry annotates the delivered image.');
      const page = await request({ op: 'replay' }); await sleep(300); const replayShot = await shot('replay');
      check('replay page in fixture WebKit viewer', page.positions === probe.positions && page.withheld === 0 && page.imageShown === true,
        { viewerPositions: page.positions, reducerPositions: probe.positions, withheldPositions: page.withheld, imageShown: Number(page.imageShown) }, replayShot);
    }
    writeFileSync(join(directory, 'host-events.jsonl'), jsonl(host.rows), { mode: 0o600 });
    return { id, checks };
  } finally { if (host) { const end = await host.close(); if (end.code !== 0) throw Error(`Hand host exited ${end.code ?? end.signal}`); } }
}
