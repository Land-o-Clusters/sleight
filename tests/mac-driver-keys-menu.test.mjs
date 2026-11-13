import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';

const matching = { title: 'Save', mark: '', character: 'S', virtualKey: 1, modifiers: 0, glyph: 0 };
test('real core and action wrapper with fake keyboard, focus and AX menus', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-keyboard-menu-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'menu.swift'), binary = join(root, 'menu');
  let composed = await macDriverSource();
  if (process.env.GLC1_KEYS_MUTANT === 'message') {
    for (const name of ['failure', 'fault', 'coreFailure']) {
      const before = `["KEY_FOCUS_UNAVAILABLE", "IDENTITY_CHANGED"].contains(${name}?.code ?? "")`;
      assert.ok(composed.includes(before), 'keyboard message variant anchor');
      composed = composed.replaceAll(before, `${name}?.code == "KEY_FOCUS_UNAVAILABLE"`);
    }
  }
  const at = composed.lastIndexOf('\ndriverMain()');
  assert.notEqual(at, -1);
  await writeFile(source, composed.slice(0, at) + '\n' + await readFile(new URL('./fixtures/mac-driver-keyboard-integration.swift', import.meta.url), 'utf8'));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], {
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536,
  });
  assert.equal(compile.status, 0, compile.stderr);
  t.diagnostic(`menuBinaryBytes=${(await stat(binary)).size}`);
  await t.test('layout and production CGEvent constructors dump fields without posting', () => {
    const dump = spawnSync(binary, ['--dump-layout'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
    assert.equal(dump.status, 0, dump.stderr);
    const result = JSON.parse(dump.stdout); t.diagnostic(JSON.stringify(result));
    assert.ok(result.layoutCount > 0);
    assert.ok(result.backgroundLayoutCount > 0);
    assert.deepEqual(result.events.map(e => e.type), [12, 10, 11]);
    assert.deepEqual(result.events.map(e => e.flags), [0x100000, 0x100000, 0]);
    assert.deepEqual(result.events.map(e => e.keyCode), [55, 1, 0]);
    assert.equal(result.events[2].unicode, '🪄');
    for (const event of result.events) {
      assert.equal(event.keyboardType, result.keyboardType); assert.equal(event.sourceState, result.sourceState);
    }
    assert.ok(![0, 1].includes(result.sourceState));
    assert.deepEqual(result.belief, [{ sourceState: result.sourceState, subtype: 1, type: 13 }, { sourceState: result.sourceState, subtype: 2, type: 13 }]);
  });
  const run = (control = {}, chord = 'cmd+s', read = 'full', preceding = []) => {
    const frame = { x: 0, y: 0, width: 100, height: 100 };
    const fixture = { control, apps: [{ id: 'test.fake', name: 'Fixture', pid: 42, processStart: 'start' }],
      windows: [{ windowId: '7', pid: 42, processStart: 'start', app: 'Fixture', title: 'Untitled', bounds: frame,
        onScreen: !control.offSpace, layer: 0, hidden: false }],
      trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Untitled', AXMinimized: false, AXFullScreen: false, frame, children: [] } } };
    const binding = { windowId: '7', processStart: 'start' };
    const requests = [{ method: 'getAXState', params: binding }, ...preceding.map(params => ({ method: 'modifiers', params: { ...binding, readId: 1, args: [params] } })),
      { method: control.typeText === undefined ? 'pressKey' : 'typeText', params: { ...binding, readId: 1, args: [control.typeText ?? chord], read } }].map((request, i) => ({ ...request,
        protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64), id: i + 1, deadline: Date.now() + 30000 }));
    const fixturePath = join(root, 'fixture.json'); writeFileSync(fixturePath, JSON.stringify(fixture));
    const result = spawnSync(binary, [fixturePath], { input: requests.map(JSON.stringify).join('\n') + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, control.focusTimeoutAfterPosts === undefined ? 0 : 70, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, requests.length, result.stdout + result.stderr);
    return { reply: JSON.parse(result.stdout.trim().split('\n').at(-1)), presses: (result.stderr.match(/menu:press/g) ?? []).length,
      keyDowns: (result.stderr.match(/key:keyDown/g) ?? []).length,
      keyCodes: [...result.stderr.matchAll(/key:keyDown:(\d+)/g)].map(match => Number(match[1])),
      traces: result.stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)),
      log: result.stderr.trim().split('\n').filter(line => !line.startsWith('{')) };
  };
  const fallbackRun = (control = {}, ...args) => run({ ...control, beliefTimeout: true }, ...args);
  await t.test('identity failure after a menu press keeps its step and uncertain delivery', () => {
    const r = fallbackRun({ menus: [matching], pressIdentity: true });
    assert.equal(r.reply.ok, false); assert.equal(r.reply.error.code, 'IDENTITY_CHANGED');
    assert.equal(r.reply.error.message, 'IDENTITY_CHANGED step=window-id');
    assert.equal(r.reply.error.delivery, 'unknown'); assert.equal(r.reply.error.retry, 'read-first');
    assert.equal(r.presses, 1); assert.equal(r.keyDowns, 0);
  });
  await t.test('focus failure after two characters keeps the step, partial delivery and cleanup trace', () => {
    const r = run({ typeText: 'ssss', focusTimeoutAfterPosts: 4 });
    assert.equal(r.reply.ok, false);
    assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE');
    assert.equal(r.reply.error.message, 'KEY_FOCUS_UNAVAILABLE step=snapshot-timeout');
    assert.equal(r.reply.error.delivery, 'sent-unverified');
    assert.equal(r.reply.error.retry, 'read-first');
    assert.equal(r.reply.error.charactersDelivered, 2);
    assert.equal(r.reply.error.unhealthy, true);
    assert.equal(r.keyDowns, 2); assert.equal(r.presses, 0);
    assert.equal(r.traces.length, 1);
    assert.equal(r.traces[0].fault, 'KEY_FOCUS_UNAVAILABLE step=snapshot-timeout');
    assert.equal(r.traces[0].beliefCleared, false);
  });
  await t.test('the real keyboard registrar refuses off-Space input before events, belief or menu fallback', () => {
    const r = run({ offSpace: true, menus: [matching] });
    assert.equal(r.reply.ok, false); assert.equal(r.reply.error.code, 'NO_WINDOWS_AVAILABLE');
    assert.equal(r.reply.error.delivery, 'not-sent'); assert.equal(r.reply.error.retry, 'safe');
    assert.equal(r.keyDowns, 0); assert.equal(r.presses, 0); assert.deepEqual(r.log.filter(Boolean), []);
  });
  const assertNotSent = r => {
    assert.equal(r.reply.ok, false);
    assert.equal(r.keyDowns, 0); assert.equal(r.presses, 0);
    assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE');
    assert.equal(r.reply.error.delivery, 'not-sent'); assert.equal(r.reply.error.retry, 'safe');
    assert.equal(r.reply.error.cleanupComplete, true); assert.equal(r.reply.error.menuFallbackCount, 0);
  };
  for (const [personTookOver, focusChanged, code] of [[true, false, 'PERSON_TOOK_OVER'],
    [true, true, 'PERSON_TOOK_OVER'], [false, true, 'KEY_FOCUS_UNAVAILABLE'], [false, false, 'KEY_FOCUS_UNAVAILABLE']]) {
    await t.test(`belief failure without a menu press preserves takeover=${personTookOver}, focusChanged=${focusChanged}`, () => {
      const r = fallbackRun({ menus: [matching], personTookOver, focusChanged, settled: false });
      assert.equal(r.reply.ok, false); assert.equal(r.reply.error.code, code);
      assert.equal(r.reply.error.personTookOver, personTookOver); assert.equal(r.reply.error.focusChanged, focusChanged);
      assert.equal(r.keyDowns, 0); assert.equal(r.presses, 0);
      assert.equal(r.reply.error.delivery, 'not-sent'); assert.equal(r.reply.error.retry, 'safe');
      assert.equal(r.reply.error.cleanupComplete, true); assert.equal(r.reply.error.menuFallbackCount, 0);
    });
  }
  for (const chord of ['cmd+s', 'cmd+z']) await t.test(`delivered ${chord} reports no visible change without a menu candidate`, () => {
    const r = run({}, chord);
    assert.equal(r.reply.ok, true); assert.equal(r.keyDowns, 1); assert.equal(r.presses, 0);
    assert.equal(r.reply.result.note, 'shortcut delivered with no visible change');
    assert.equal(r.reply.result.menuFallbackCount, 0);
  });
  await t.test('native strict Paste chord refuses before key or menu input', () => {
    const r = run({ menus: [{ ...matching, character: 'V', virtualKey: 9 }] }, 'cmd+v');
    assert.equal(r.reply.ok, false); assert.equal(r.reply.error.code, 'ACTION_UNSUPPORTED');
    assert.equal(r.keyDowns, 0); assert.equal(r.presses, 0); assert.equal(r.reply.error.delivery, 'not-sent');
  });
  for (const [chord, character, virtualKey] of [['cmd+d', 'D', 2], ['cmd+s', 'S', 1]]) {
    await t.test(`delivered ${chord} with no tree change presses nothing`, () => {
      const r = run({ menus: [{ ...matching, character, virtualKey }] }, chord);
      assert.equal(r.reply.ok, true); assert.equal(r.keyDowns, 1); assert.equal(r.presses, 0);
      assert.equal(r.reply.result.menuFallbackCount, 0);
      assert.equal(r.reply.result.note, 'shortcut delivered with no visible change');
      assert.equal(r.reply.result.delivery, 'sent-unverified');
    });
  }
  await t.test('a belief read fault before posting can press the exact menu once', () => {
    const r = run({ menus: [matching], beliefThrows: true });
    assert.equal(r.reply.ok, true); assert.equal(r.keyDowns, 0); assert.equal(r.presses, 1);
    assert.equal(r.reply.result.menuFallbackCount, 1);
  });
  await t.test('belief-failed Cmd-S presses exactly one match once after quiet unchanged settle', () => {
    const r = fallbackRun({ menus: [matching] });
    assert.equal(r.reply.ok, true, JSON.stringify(r)); assert.equal(r.presses, 1);
    assert.equal(r.keyDowns, 0); assert.equal(r.reply.result.menuFallbackCount, 1);
    assert.equal(r.reply.result.note, 'pressed the matching menu item');
    assert.equal(r.reply.result.delivery, 'sent-unverified'); assert.equal(r.reply.result.focusChanged, false);
    assert.equal(r.reply.result.reason, undefined);
    assert.ok(r.reply.result.fakeActiveMs >= 0);
    assert.equal(r.traces[0].fakeActiveMs, r.reply.result.fakeActiveMs);
    assert.equal(r.traces[0].beliefCleared, true);
  });
  for (const [name, control] of [['zero', { menus: [] }], ['two', { menus: [matching, matching] }],
    ['not quiet', { menus: [matching], reason: 'cap' }], ['not settled', { menus: [matching], settled: false }],
    ['wrong char', { menus: [{ ...matching, character: 'X' }] }], ['wrong virtual key', { menus: [{ ...matching, virtualKey: 2 }] }],
    ['wrong modifiers', { menus: [{ ...matching, modifiers: 1 }] }], ['unknown glyph', { menus: [{ ...matching, glyph: 999 }] }],
    ['disabled', { menus: [{ ...matching, enabled: false }] }], ['missing modifiers', { menus: [{ character: 'S' }] }],
    ['changed tree', { menus: [matching], changedTree: true }], ['partial pre-chord tree', { menus: [matching], partialTree: true }],
    ['a disabled duplicate', { menus: [matching, { ...matching, enabled: false }] }],
    ['malformed character', { menus: [{ ...matching, character: 8 }] }],
    ['malformed virtual key', { menus: [{ ...matching, virtualKey: 'wrong' }] }],
    ['malformed glyph', { menus: [{ ...matching, glyph: 'wrong' }] }],
    ['malformed duplicate', { menus: [matching, { ...matching, virtualKey: 'wrong' }] }],
    ['malformed enabled flag', { menus: [{ ...matching, enabled: 1 }] }],
    ['empty equivalent', { menus: [{ ...matching, character: '' }] }],
    ['ambiguous virtual zero', { sCode: 0, menus: [{ virtualKey: 0, modifiers: 0 }] }]]) {
    for (const beliefTimeout of [false, true]) await t.test(`${name} never presses a menu (beliefTimeout=${beliefTimeout})`, () => {
      const r = run({ ...control, beliefTimeout });
      const observed = !beliefTimeout;
      assert.equal(r.reply.ok, observed, JSON.stringify(r)); assert.equal(r.presses, 0);
      assert.equal(r.keyDowns, beliefTimeout ? 0 : 1);
      if (!observed) assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE');
      if (beliefTimeout) assertNotSent(r);
    });
  }
  for (const [name, patch] of [['mark', { mark: '✓' }], ['title', { title: 'Undo Save' }], ['enabled', { enabled: false }]]) {
    await t.test(`a chord that changes the matching menu ${name} is never applied twice`, () => {
      const r = fallbackRun({ menus: [matching], menusAfter: [{ ...matching, ...patch }] });
      assertNotSent(r);
    });
  }
  for (const chord of ['cmd+z', 'shift+cmd+z', 'Command+Z']) await t.test(`${chord} never falls back`, () => {
    const r = fallbackRun({ menus: [{ title: 'Undo', mark: '', character: 'Z', virtualKey: 6,
      modifiers: chord.includes('shift') || chord.endsWith('Z') ? 1 : 0, glyph: 0 }] }, chord);
    assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.presses, 0); assert.equal(r.keyDowns, 0);
  });
  for (const menuReadFailure of ['AX_UNAVAILABLE', 'IDENTITY_CHANGED']) {
    for (const menuReadPhase of ['before', 'after']) await t.test(`${menuReadFailure} ${menuReadPhase} the chord reports whether input was sent`, () => {
      const r = (menuReadPhase === 'before' ? run : fallbackRun)({ menus: [matching], menuReadFailure, menuReadPhase });
      if (menuReadPhase === 'after') assertNotSent(r);
      else {
        assert.equal(r.reply.ok, true, JSON.stringify(r)); assert.equal(r.presses, 0);
        assert.equal(r.reply.result.reason, 'quiet'); assert.equal(r.reply.result.settled, true);
        assert.equal(r.reply.result.menuFallbackCount, 0); assert.equal(r.keyDowns, 1);
      }
    });
  }
  for (const metadataReadFailure of ['AX_UNAVAILABLE', 'IDENTITY_CHANGED']) await t.test(`${metadataReadFailure} in final menu validation reports no input`, () => {
    const r = fallbackRun({ menus: [matching], metadataReadFailure });
    assertNotSent(r);
  });
  for (const paceMs of [4, 13]) await t.test(`500 characters use measured intervals at ${paceMs} ms per stroke`, () => {
    const r = run({ typeText: 's'.repeat(500), paceMs }, '', 'none');
    assert.equal(r.reply.ok, true, JSON.stringify(r.reply)); assert.equal(r.keyDowns, 500);
    assert.equal(r.reply.result.charactersDelivered, 500);
    assert.equal(r.traces.length, paceMs === 4 ? 10 : 32);
    t.diagnostic(JSON.stringify({ paceMs, intervals: r.traces.length, maxFakeActiveMs: Math.max(...r.traces.map(trace => trace.fakeActiveMs)) })); assert.ok(r.traces.every(trace => trace.fakeActiveMs < 400 && trace.beliefCleared));
    assert.ok(r.traces.every(trace => trace.fakeActiveMs <= 230));
  });
  await t.test('a mid-chunk transport stall cleans up with the delivered character count', () => {
    const r = run({ typeText: 's'.repeat(500), paceMs: 4, stallPost: 141 }, '', 'none');
    assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE');
    assert.equal(r.reply.error.charactersDelivered, 71); assert.equal(r.keyDowns, 71);
    assert.equal(r.reply.error.cleanupComplete, true);
    assert.equal(r.presses, 0);
    assert.equal(r.traces[0].beliefCleared, true);
    assert.equal(r.log.at(-1), 'belief:deactivate'); assert.equal(r.log.at(-2), 'key:keyUp:1');
  });
  for (const betweenChunkFailure of ['PERSON_TOOK_OVER', 'IDENTITY_CHANGED', 'ACTION_UNSUPPORTED']) {
    await t.test(`${betweenChunkFailure} between chunks stops further text`, () => {
      const r = run({ typeText: 's'.repeat(500), paceMs: 4, betweenChunkFailure }, '', 'none');
      assert.equal(r.reply.error.code, betweenChunkFailure); assert.ok(r.keyDowns > 0 && r.keyDowns < 500);
      assert.equal(r.reply.error.charactersDelivered, r.keyDowns); assert.equal(r.reply.error.cleanupComplete, true);
      assert.equal(r.traces.length, 1);
    });
  }
  const assertReleased = r => {
    const down = new Set();
    for (const line of r.log) {
      const key = /^key:(keyDown|keyUp):(\d+)$/.exec(line);
      if (key) { if (key[1] === 'keyDown') down.add(key[2]); else down.delete(key[2]); }
    }
    assert.equal(down.size, 0, JSON.stringify(r.log));
    assert.equal(r.reply.error.cleanupComplete, true);
    assert.equal(r.log.filter(line => line === 'belief:activate').length, 1);
    assert.equal(r.log.filter(line => line === 'belief:deactivate').length, 1);
  };
  for (const [control, code, changed] of [
    ['betweenChunkIdentity', 'IDENTITY_CHANGED', false],
    ['betweenChunkPersonInput', 'PERSON_TOOK_OVER', false],
    ['betweenChunkPreflight', 'SECURE_INPUT_ACTIVE', false],
    ['betweenChunkModifier', 'PERSON_HOLDS_MODIFIER', false],
    ['betweenChunkSnapshot', 'PERSON_TOOK_OVER', true],
  ]) await t.test(`${control} checks the actual provider between chunks`, () => {
    const r = run({ typeText: 's'.repeat(500), paceMs: 4, [control]: true }, '', 'none');
    assert.equal(r.reply.error.code, code); assert.equal(r.keyDowns, 50);
    if (code === 'IDENTITY_CHANGED') assert.match(r.reply.error.message, /IDENTITY_CHANGED step=(?:pid|keyboard-pid)/);
    assert.equal(r.reply.error.charactersDelivered, 50); assert.equal(r.traces.length, 1);
    assert.equal(r.reply.error.focusChanged, changed); assert.equal(r.reply.error.focusRestored, false);
    assertReleased(r);
  });
  await t.test('a restore at the chunk boundary survives the stopping fault', () => {
    const r = run({ typeText: 's'.repeat(500), paceMs: 4, focusDuringRestore: true }, '', 'none');
    assert.equal(r.reply.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.keyDowns, 50);
    assert.equal(r.reply.error.charactersDelivered, 50);
    assert.equal(r.reply.error.focusChanged, true); assert.equal(r.reply.error.focusRestored, true);
    assert.equal(r.log.filter(line => line === 'focus:restore').length, 1);
    assertReleased(r);
  });
  await t.test('the active non-US mapping supplies both the posted key and menu comparison', () => {
    const delivered = run({ sCode: 31, menus: [{ ...matching, virtualKey: 31 }] });
    assert.equal(delivered.reply.ok, true); assert.deepEqual(delivered.keyCodes, [31]); assert.equal(delivered.presses, 0);
    const r = fallbackRun({ sCode: 31, menus: [{ ...matching, virtualKey: 31 }] });
    assert.equal(r.reply.ok, true); assert.equal(r.presses, 1); assert.deepEqual(r.keyCodes, []);
  });
  await t.test('named keys match their public menu glyph and virtual key', () => {
    const r = fallbackRun({ menus: [{ character: '', virtualKey: 36, modifiers: 0, glyph: 11 }] }, 'cmd+Return');
    assert.equal(r.reply.ok, true); assert.equal(r.presses, 1);
  });
  await t.test('Return matches its control-character equivalent as well as its glyph', () => {
    const r = fallbackRun({ menus: [{ character: '\r', virtualKey: 36, modifiers: 0, glyph: 11 }] }, 'cmd+Return');
    assert.equal(r.reply.ok, true); assert.equal(r.presses, 1);
  });
  await t.test('Unicode case folding cannot make a different menu character match', () => {
    const r = fallbackRun({ menus: [{ character: '\u212a', virtualKey: 40, modifiers: 0, glyph: 0 }] }, 'cmd+k');
    assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.presses, 0); assert.equal(r.keyDowns, 0);
  });
  await t.test('RTL delete glyphs require unambiguous character or virtual-key evidence', () => {
    const known = fallbackRun({ menus: [{ character: '\u007f', virtualKey: 51, modifiers: 0, glyph: 10 }] }, 'cmd+BackSpace');
    assert.equal(known.reply.ok, true); assert.equal(known.presses, 1);
    const ambiguous = fallbackRun({ menus: [{ character: '', modifiers: 0, glyph: 10 }] }, 'cmd+Delete');
    assert.equal(ambiguous.reply.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(ambiguous.presses, 0);
  });
  for (const control of ['focusAtMenu', 'takeoverAtMenu']) await t.test(`${control} aborts the fallback after settling`, () => {
    const r = fallbackRun({ menus: [matching], [control]: true });
    assert.equal(r.reply.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.reply.error.delivery, 'not-sent');
    assert.equal(r.presses, 0); assert.equal(r.keyDowns, 0);
  });
  await t.test('a focus change during final menu metadata validation prevents AXPress', () => {
    const r = fallbackRun({ menus: [matching], focusDuringMetadata: true });
    assert.equal(r.reply.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.reply.error.focusChanged, true);
    assert.equal(r.reply.error.delivery, 'not-sent'); assert.equal(r.presses, 0);
    assert.equal(r.reply.error.menuFallbackCount, 0);
  });
  await t.test('an accidental target activation suppresses fallback even after restoration', () => {
    const r = run({ menus: [matching], focusDuringRestore: true });
    assert.equal(r.reply.ok, true); assert.equal(r.reply.result.focusChanged, true);
    assert.equal(r.reply.result.focusRestored, true); assert.equal(r.presses, 0);
  });
  for (const pressThrows of [false, true]) await t.test(`menu activation is restored after ${pressThrows ? 'uncertain' : 'successful'} delivery`, () => {
    const r = fallbackRun({ menus: [matching], menuActivates: true, pressThrows });
    const disposition = pressThrows ? r.reply.error : r.reply.result;
    assert.equal(r.reply.ok, !pressThrows); assert.equal(disposition.focusChanged, true);
    assert.equal(disposition.focusRestored, true); assert.equal(disposition.menuFallbackCount, 1);
    assert.equal(r.presses, 1);
  });
  await t.test('an uncertain menu press is not retried', () => {
    const r = fallbackRun({ menus: [matching], pressThrows: true });
    assert.equal(r.reply.error.code, 'ACTION_UNCONFIRMED'); assert.equal(r.reply.error.delivery, 'unknown');
    assert.equal(r.presses, 1); assert.equal(r.keyDowns, 0);
    assert.equal(r.reply.error.menuFallbackCount, 1);
    assert.equal(r.reply.error.fakeActiveMs, r.traces[0].fakeActiveMs);
  });
  await t.test('mid-chord takeover releases pending keys before deactivating belief', () => {
    const r = run({ takeoverAfterKeyDown: true }, 'cmd+s', 'none');
    assert.equal(r.reply.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.reply.error.cleanupComplete, true);
    assert.deepEqual(r.log, ['belief:activate', 'key:flagsChanged:55', 'key:keyDown:1',
      'key:keyUp:1', 'key:flagsChanged:55', 'belief:deactivate']);
  });
  await t.test('read none never falls back and keeps focus diagnostics', () => {
    const r = run({ menus: [matching] }, 'cmd+s', 'none');
    assert.equal(r.reply.ok, true); assert.equal(r.presses, 0); assert.equal(r.reply.result.focusChanged, false);
    assert.equal(r.reply.result.text, undefined);
    assert.equal(r.reply.result.fakeActiveMs, r.traces[0].fakeActiveMs);
  });
  for (const stallPost of [1, 4]) await t.test(`400 ms abort after key post ${stallPost} cleans up before deactivation`, () => {
    const r = run({ stallPost }, 'cmd+s', 'none');
    assert.equal(r.reply.error.code, 'KEY_FOCUS_UNAVAILABLE');
    assert.equal(r.reply.error.delivery, 'sent-unverified');
    assert.equal(r.reply.error.cleanupComplete, true); assert.equal(r.reply.error.fakeActiveMs, 401);
    assert.equal(r.traces[0].fakeActiveMs, 401); assert.equal(r.traces[0].beliefCleared, true);
    assert.equal(r.log.at(-1), 'belief:deactivate');
    assert.equal(r.log.at(-2), 'key:flagsChanged:55');
    assert.equal(r.keyDowns, stallPost === 1 ? 0 : 1);
  });
  for (const chord of ['cmd+q', 'cmd+ctrl+q', 'cmd+shift+q', 'cmd+alt+Escape']) await t.test(`${chord} refuses before all key delivery`, () => {
    const r = run({ menus: [matching] }, chord);
    assert.equal(r.reply.error.code, 'ACTION_UNSUPPORTED'); assert.equal(r.reply.error.delivery, 'not-sent');
    assert.equal(r.presses, 0); assert.equal(r.keyDowns, 0);
  });
  await t.test('held Command cannot bypass quit refusal', () => {
    const r = run({}, 'q', 'none', [{ keys: ['meta'], state: 'down' }]);
    assert.equal(r.reply.error.code, 'ACTION_UNSUPPORTED'); assert.equal(r.keyDowns, 0); assert.equal(r.presses, 0);
  });
  for (const [control, code] of [[{ secure: true }, 'SECURE_INPUT_ACTIVE'], [{ held: 0x100000 }, 'PERSON_HOLDS_MODIFIER']]) {
    await t.test(`${code} preserves not-sent through the runtime`, () => {
      const r = run(control); assert.equal(r.reply.error.code, code); assert.equal(r.reply.error.delivery, 'not-sent');
      assert.equal(r.keyDowns, 0); assert.equal(r.presses, 0);
    });
  }
});
