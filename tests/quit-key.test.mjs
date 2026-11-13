import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, registerTemp } from '../scripts/temp-leftovers.mjs';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { quitKeyBlocked, heldKeyChange, requestedQuitApps, quitAppAllowed, QUIT_KEY_REFUSAL } from '../plugins/sleight/lib/quit-key.mjs';
import { createPaymentMessages } from '../plugins/sleight/lib/payment-gate.mjs';
import { inspectQuitKeys, replayQuitEvidence } from '../bench/quit-key-replay.mjs';

const window = { title: 'Fixture', app: 'TextEdit', url: null };
const tree = 'Window: "Fixture", App: TextEdit.\n0 standard window Fixture\n1 text entry area (settable) Body\nThe focused UI element is 1 text entry area (settable) Body';
function native({ app = 'TextEdit', appId = 'com.apple.TextEdit', pid } = {}) {
  const sent = [];
  const observed = tree.replace('App: TextEdit.', 'App: ' + app + '.');
  const expected = { ...window, app, appId, ...(pid ? { pid } : {}) };
  const raw = { getAXState: async () => observed,
    pressKey: async (...args) => { sent.push(['pressKey', ...args]); },
    press: async (...args) => { sent.push(['press', ...args]); },
    click: async (...args) => { sent.push(['click', ...args]); },
    doubleClick: async (...args) => { sent.push(['doubleClick', ...args]); },
    rightClick: async (...args) => { sent.push(['rightClick', ...args]); },
    drag: async (...args) => { sent.push(['drag', ...args]); },
    scroll: async (...args) => { sent.push(['scroll', ...args]); },
    typeText: async (...args) => { sent.push(['typeText', ...args]); } };
  for (const method of ['modifiers', 'keyDown', 'keyUp', 'key_down', 'key_up']) {
    raw[method] = async (...args) => { sent.push([method, ...args]); };
  }
  // The installed macOS engine binds a fresh object on every acquisition.
  const context = { app: raw, cua: { getApp: async () => ({ ...raw }) }, nodeRepl: { write() {} } };
  return { sent, raw, context, run: (code, options = {}) => runInNewContext(`(async () => { ${guardedCode(code, expected, undefined, undefined, options)} })()`, context) };
}

// Independent AD3Q5 cases. The installed Sky docs specify key_down/key_up with
// {key, window?}; RT5's modifiers contract is {keys, state}. No engine is loaded.
const holds = [
  { down: keys => `app.modifiers({keys:${JSON.stringify(keys)},state:'down'})`, up: keys => `app.modifiers({keys:${JSON.stringify(keys)},state:'up'})` },
  { down: keys => `app.keyDown(${JSON.stringify(keys.join('+'))})`, up: keys => `app.keyUp(${JSON.stringify(keys.join('+'))})` },
  { down: keys => `app.key_down({key:${JSON.stringify(keys.join('+'))}})`, up: keys => `app.key_up({key:${JSON.stringify(keys.join('+'))}})` },
];

test('AD3Q5 held meta, shifted Command and Command plus per-call Option follow quit authority', async t => {
  const cases = [
    { held: ['meta'], call: `app.pressKey('q')` },
    { held: ['cmd', 'shift'], call: `app.pressKey('q')` },
    { held: ['cmd'], call: `app.pressKey('Escape', {key:'option'})` },
    { held: ['cmd', 'option'], call: `app.pressKey('Escape')` },
  ];
  for (const form of holds) for (const entry of cases) for (const allow of [false, true]) {
    const f = native();
    const run = f.run(`await ${form.down(entry.held)}; await ${entry.call};`, { quitApps: allow ? ['TextEdit'] : [] });
    if (allow && entry.held.length === 1 && entry.held[0] === 'meta') {
      await run; assert.equal(f.sent.length, 2);
    } else {
      await assert.rejects(run, /quit-key rule/);
      assert.equal(f.sent.length, 1, JSON.stringify(entry));
    }
  }
  t.diagnostic('24 sequences: 21 refuse after the hold and 3 permit authorized plain quit');
});

test('AD3Q5 release allows plain q and leaves other held modifiers intact', async () => {
  for (const form of holds) {
    const f = native();
    await f.run(`await ${form.down(['meta'])};`);
    await f.run(`await ${form.up(['meta'])}; await app.pressKey('q');`, { reuseSetup: true });
    assert.deepEqual(f.sent.at(-1), ['pressKey', 'q']);
    const g = native();
    await g.run(`await ${form.down(['cmd', 'shift'])}; await ${form.up(['shift'])};`);
    await assert.rejects(g.run(`await app.pressKey('q');`, { reuseSetup: true }), /quit-key rule/);
    assert.equal(g.sent.length, 2);
  }
});

test('AD3Q6 holds survive full setup, reused setup and acquisition of a fresh handle', async () => {
  for (const reuseSetup of [false, true]) {
    const f = native();
    await f.run(`await app.modifiers({keys:['meta'],state:'down'});`);
    await assert.rejects(f.run(`const alias = await cua.getApp('TextEdit'); await alias.pressKey('q');`, { reuseSetup }), /quit-key rule/);
    assert.equal(f.sent.length, 1);
  }
  const f = native();
  await f.run(`await app.modifiers({keys:['meta'],state:'down'});`);
  await runInNewContext(`(async () => { ${readCode(`globalThis.other = await cua.getApp('TextEdit');`)} })()`, f.context);
  await assert.rejects(f.run(`await other.pressKey('q');`), /quit-key rule/);
  assert.equal(f.sent.length, 1);
});

test('AD3Q6 holds belong to the app across different raw handles', async () => {
  const f = native(), other = native();
  f.context.cua.getApp = async () => ({ ...other.raw });
  await assert.rejects(f.run(`await app.modifiers({keys:['meta'],state:'down'}); const other = await cua.getApp('TextEdit'); await other.pressKey('q');`), /quit-key rule/);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(other.sent, []);
  await f.run(`const other = await cua.getApp('com.apple.TextEdit'); await other.modifiers({keys:['Meta_L'],state:'up'}); await app.pressKey('q');`);
  assert.deepEqual(f.sent.at(-1), ['pressKey', 'q']);
  assert.equal(other.sent.length, 1);
});

test('AD3Q6 known bundle and pid hold sets remain separate between apps', async () => {
  for (const identity of ['bundle', 'pid']) {
    const f = native(identity === 'pid' ? { appId: null, pid: 101 } : {});
    const other = native({ app: 'Other', appId: identity === 'bundle' ? 'org.fixture.Other' : null, pid: 102 });
    f.context.cua.getApp = async () => ({ ...other.raw });
    await f.run(`await app.modifiers({keys:['meta'],state:'down'});`);
    const expected = { ...window, app: 'Other', ...(identity === 'bundle' ? {appId:'org.fixture.Other'} : {pid:102}) };
    await runInNewContext(`(async () => { ${guardedCode(`const other = await cua.getApp('Other'); await other.pressKey('q');`, expected)} })()`, f.context);
    assert.deepEqual(other.sent, [['pressKey', 'q']]);
    await assert.rejects(f.run(`await app.pressKey('q');`), /quit-key rule/);
  }
});

test('AD3Q6 absent app identity refuses holds before dispatch', async () => {
  const f = native({ appId: null });
  await assert.rejects(f.run(`await app.modifiers({keys:['meta'],state:'down'});`), /quit-key rule/);
  assert.deepEqual(f.sent, []);
  await f.run(`await app.pressKey('q');`);
  assert.deepEqual(f.sent, [['pressKey', 'q']]);
  const g = native();
  await assert.rejects(runInNewContext(`(async () => { ${readCode(`const other = await cua.getApp('TextEdit'); await other.modifiers({keys:['meta'],state:'down'});`)} })()`, g.context), /quit-key rule/);
  assert.deepEqual(g.sent, []);
});

test('AD3Q6 missing observations refuse held input and retain its state', async () => {
  const f = native(), read = f.raw.getAXState;
  await f.run(`await app.modifiers({keys:['cmd'],state:'down'});`);
  f.raw.getAXState = async () => 'no app header';
  await assert.rejects(f.run(`await app.pressKey('q');`), /quit-key rule/);
  assert.equal(f.sent.length, 1);
  f.raw.getAXState = read;
  await assert.rejects(f.run(`await app.pressKey('q');`), /quit-key rule/);
  await f.run(`await app.modifiers({keys:['cmd'],state:'up'}); await app.pressKey('q');`);
});

test('AD3Q5 ordinary held shortcuts, typing and unmodified clicks pass', async () => {
  const cases = [
    { held: ['cmd'], calls: `await app.pressKey('s'); await app.pressKey('w'); await app.pressKey('Shift+g'); await app.click([10,10]);` },
    { held: ['shift'], calls: `await app.pressKey('q'); await app.typeText('q');` },
    { held: ['control'], calls: `await app.pressKey('q');` },
    { held: ['option'], calls: `await app.pressKey('Escape');` },
  ];
  for (const entry of cases) {
    const f = native();
    await f.run(`await app.modifiers({keys:${JSON.stringify(entry.held)},state:'down'});`);
    await f.run(entry.calls, { reuseSetup: true });
    assert.ok(f.sent.length > 1);
  }
});

test('AD3Q5 plain-quit authority counts held spellings and per-call tokens separately', async () => {
  const cases = [
    { held: ['cmd'], key: 'q', pass: true }, { held: ['meta'], key: 'q', pass: true },
    { held: ['Super_L'], key: 'q', pass: true },
    { held: ['cmd'], key: 'Q', pass: false }, { held: ['cmd'], key: 'KeyQ', pass: false },
    { held: ['cmd'], key: 'cmd+q', pass: false },
    { held: ['cmd', 'super'], key: 'q', pass: false },
    { held: ['cmd', 'shift'], key: 'q', pass: false }, { held: ['Hyper_L'], key: 'q', pass: false },
  ];
  for (const entry of cases) {
    const f = native();
    await f.run(`await app.modifiers({keys:${JSON.stringify(entry.held)},state:'down'});`);
    const run = f.run(`await app.pressKey(${JSON.stringify(entry.key)});`, { quitApps: ['TextEdit'] });
    if (entry.pass) { await run; assert.equal(f.sent.length, 2); }
    else { await assert.rejects(run, /quit-key rule/); assert.equal(f.sent.length, 1); }
  }
  const f = native();
  await f.run(`await app.modifiers({keys:['cmd'],state:'down'});`);
  await assert.rejects(f.run(`await app.pressKey('q');`, { quitApps: ['Safari'] }), /quit-key rule/);
});

test('AD3Q5 held modifiers combine with text and all pointer key options', async t => {
  const calls = [
    `app.typeText('q')`, `app.typeText('Q')`, `app.typeText('quite')`,
    `app.typeText('\u001b', {key:'option'})`,
    `app.click([10,10], {key:'q'})`, `app.doubleClick([10,10], {modifiers:['q']})`,
    `app.rightClick([10,10], {modifier:'q'})`, `app.drag([10,10], [20,20], {key:'q'})`,
    `app.scroll([10,10], 'down', {key:'option+Escape'})`,
  ];
  for (const call of calls) for (const allow of [false, true]) {
    const f = native();
    await f.run(`await app.modifiers({keys:['cmd'],state:'down'});`);
    const run = f.run(`await ${call};`, { quitApps: allow ? ['TextEdit'] : [] });
    if (allow && call === `app.typeText('q')`) { await run; assert.equal(f.sent.length, 2); }
    else { await assert.rejects(run, /quit-key rule/); assert.equal(f.sent.length, 1, call); }
  }
  t.diagnostic('18 held-modifier action cases, 17 refuse and 1 authorized plain text q passes');
});

test('AD3Q5 key-down chords are checked in both key and modifier order', async () => {
  for (const code of [
    `await app.keyDown('cmd+q');`, `await app.key_down({key:'cmd+option+Escape'});`,
    `await app.keyDown('q'); await app.keyDown('cmd');`,
    `await app.keyDown('Escape'); await app.modifiers({keys:['cmd','option'],state:'down'});`,
  ]) {
    const f = native();
    await assert.rejects(f.run(code, { quitApps: ['TextEdit'] }), /quit-key rule/);
    assert.ok(f.sent.length <= 1);
  }
  const f = native();
  await f.run(`await app.keyDown('q');`);
  await assert.rejects(f.run(`await app.pressKey('cmd');`, {quitApps:['TextEdit']}), /quit-key rule/);
  assert.equal(f.sent.length, 1);
});

test('AD3Q5 malformed holds refuse before dispatch and unknown releases cannot clear state', async () => {
  for (const code of [
    `app.modifiers('meta')`, `app.modifiers({keys:['meta'],state:'toggle'})`,
    `app.modifiers({keys:['meta','q'],state:'down'})`, `app.modifiers({keys:[],state:'up'})`,
    `app.keyDown({keys:['cmd']})`, `app.keyUp()`, `app.key_down({key:'cmd++q'})`,
    `app.keyDown('Win')`, `app.key_down({key:'ISO_Level3_Shift'})`,
  ]) {
    const f = native();
    await assert.rejects(f.run(`await ${code};`), /quit-key rule/);
    assert.deepEqual(f.sent, []);
  }
  const f = native();
  await f.run(`await app.modifiers({keys:['cmd'],state:'down'});`);
  await f.run(`await app.modifiers({keys:['shift'],state:'up'});`);
  await assert.rejects(f.run(`await app.pressKey('q');`), /quit-key rule/);
  assert.equal(f.sent.length, 2);
});

test('AD3Q5 uncertain hold and failed release retain the conservative held set', async () => {
  for (const failed of ['down', 'up']) {
    const f = native(), send = f.raw.modifiers;
    f.raw.modifiers = async value => {
      await send(value);
      if (value.state === failed) throw Error('fixture delivery uncertain');
    };
    if (failed === 'up') await f.run(`await app.modifiers({keys:['meta'],state:'down'});`);
    await assert.rejects(f.run(`await app.modifiers({keys:['meta'],state:${JSON.stringify(failed)}});`), /fixture delivery uncertain/);
    await assert.rejects(f.run(`await app.pressKey('q');`), /quit-key rule/);
    assert.equal(f.sent.some(([method]) => method === 'pressKey'), false);
    f.raw.modifiers = send;
    await f.run(`await app.modifiers({keys:['meta'],state:'up'}); await app.pressKey('q');`);
    assert.deepEqual(f.sent.at(-1), ['pressKey', 'q']);
  }
});

test('AD3Q5 concurrent hold and press wait for the hold before checking the key', { timeout: 10000 }, async () => {
  const f = native();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.raw.modifiers = async (...args) => {
    f.sent.push(['modifiers', ...args]); started();
    await new Promise(resolve => { release = resolve; });
  };
  const run = f.run(`await Promise.all([app.modifiers({keys:['meta'],state:'down'}), app.pressKey('q')]);`);
  await ready;
  assert.equal(f.sent.length, 1);
  release();
  await assert.rejects(run, /quit-key rule/);
  assert.equal(f.sent.length, 1);
});

test('AD3Q6 an unheld never-settling click does not queue a later key', { timeout: 10000 }, async () => {
  const f = native();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  f.raw.click = async (...args) => { f.sent.push(['click', ...args]); started(); await new Promise(() => {}); };
  await f.run('');
  // Direct proxy calls avoid the cell's deliberate wait for all unawaited actions.
  f.context.app.click([10, 10]);
  await ready;
  await f.context.app.pressKey('s');
  assert.deepEqual(f.sent, [['click', [10, 10]], ['pressKey', 's']]);
});

test('AD3Q6 a pending hold orders keys on a fresh handle', { timeout: 10000 }, async () => {
  const f = native();
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.raw.modifiers = async (...args) => {
    f.sent.push(['modifiers', ...args]); started();
    await new Promise(resolve => { finish = resolve; });
  };
  await f.run(`globalThis.alias = await cua.getApp('TextEdit');`);
  assert.notEqual(f.context.app, f.context.alias);
  const hold = f.context.app.modifiers({ keys: ['cmd'], state: 'down' });
  const key = f.context.alias.pressKey('q');
  const refused = assert.rejects(key, /quit-key rule/);
  await ready;
  assert.equal(f.sent.length, 1);
  finish();
  await hold;
  await refused;
  assert.equal(f.sent.length, 1);
});

test('AD3Q6 queued input detaches after release even when its engine call never settles', { timeout: 10000 }, async () => {
  const f = native();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.raw.modifiers = async value => {
    f.sent.push(['modifiers', value]);
    if (value.state === 'up') await new Promise(resolve => { release = resolve; started(); });
  };
  f.raw.click = async (...args) => { f.sent.push(['click', ...args]); await new Promise(() => {}); };
  await f.run(`await app.modifiers({keys:['cmd'],state:'down'});`);
  const up = f.context.app.modifiers({ keys: ['cmd'], state: 'up' });
  f.context.app.click([10, 10]);
  const key = f.context.app.pressKey('q');
  await ready;
  assert.equal(f.sent.length, 2);
  release();
  await up;
  await key;
  assert.deepEqual(f.sent.filter(([method]) => method === 'pressKey'), [['pressKey', 'q']]);
});

test('AD3Q6 release aliases clear holds in both directions', async t => {
  const pairs = [['cmd', 'Command'], ['Meta_L', 'Meta'], ['q', 'KeyQ'], ['Escape', 'Esc'], ['Super_R', '⌘']];
  for (const pair of pairs) for (const [down, up] of [pair, [...pair].reverse()]) {
    assert.deepEqual(heldKeyChange('keyUp', [up], [down]), { down: false, next: [] });
    for (const form of holds.filter((_, index) => index || !['q', 'KeyQ', 'Escape', 'Esc'].includes(down))) {
      const f = native();
      await f.run(`await ${form.down([down])}; await ${form.up([up])};`);
      // These probes would refuse if the corresponding hold survived its release.
      const probe = ['q', 'KeyQ'].includes(down) ? 'cmd+s'
        : ['Escape', 'Esc'].includes(down) ? 'cmd+option+s' : 'q';
      await f.run(`await app.pressKey(${JSON.stringify(probe)});`);
      assert.deepEqual(f.sent.at(-1), ['pressKey', probe]);
    }
  }
  t.diagnostic('10 bidirectional alias pairs, 26 native hold/release/probe sequences');
});

test('AD3Q6 hold updates preserve extra spellings and opposite release sides', () => {
  assert.deepEqual(heldKeyChange('modifiers', [{keys:['cmd','super'],state:'down'}]), {down:true,next:['cmd','super']});
  assert.deepEqual(heldKeyChange('keyUp', ['Super_R'], ['Super_L']), {down:false,next:['Super_L']});
  assert.deepEqual(heldKeyChange('key_up', [{key:'meta'}], ['meta']), {down:false,next:[]});
  assert.equal(quitKeyBlocked('pressKey', ['q'], false, ['meta']), true);
  assert.equal(quitKeyBlocked('pressKey', ['q'], true, ['cmd', 'shift']), true);
  assert.equal(quitKeyBlocked('pressKey', ['q'], true, ['cmd']), false);
  assert.equal(quitKeyBlocked('pressKey', ['cmd'], true, ['q']), true);
});

// Independent spellings, not derived from quitKeyToken or the modifier matcher.
const modifierSides = [
  ['Meta', ['Meta_L', 'MetaLeft', 'Meta_Left'], ['Meta_R', 'MetaRight', 'Meta_Right']],
  ['Super', ['Super_L', 'SuperLeft', 'Super_Left'], ['Super_R', 'SuperRight', 'Super_Right']],
  ['Command', ['Command_L', 'CommandLeft', 'Command_Left'], ['Command_R', 'CommandRight', 'Command_Right']],
  ['Cmd', ['Cmd_L', 'CmdLeft', 'Cmd_Left'], ['Cmd_R', 'CmdRight', 'Cmd_Right']],
  ['Control', ['Control_L', 'ControlLeft', 'Control_Left'], ['Control_R', 'ControlRight', 'Control_Right']],
  ['Ctrl', ['Ctrl_L', 'CtrlLeft', 'Ctrl_Left'], ['Ctrl_R', 'CtrlRight', 'Ctrl_Right']],
  ['Alt', ['Alt_L', 'AltLeft', 'Alt_Left'], ['Alt_R', 'AltRight', 'Alt_Right']],
  ['Option', ['Option_L', 'OptionLeft', 'Option_Left'], ['Option_R', 'OptionRight', 'Option_Right']],
  ['Shift', ['Shift_L', 'ShiftLeft', 'Shift_Left'], ['Shift_R', 'ShiftRight', 'Shift_Right']],
  ['Hyper', ['Hyper_L', 'HyperLeft', 'Hyper_Left'], ['Hyper_R', 'HyperRight', 'Hyper_Right']],
];
const releases = [
  keys => ['modifiers', [{ keys, state: 'up' }]],
  keys => ['keyUp', [keys.join('+')]],
  keys => ['key_up', [{ key: keys.join('+') }]],
];

test('AD3Q7 sided releases clear the same side and unsided holds, preserving the other side', t => {
  let count = 0;
  for (const [base, left, right] of modifierSides) for (const [same, opposite] of [[left, right], [right, left]]) {
    for (const held of same) for (const up of same) for (const other of opposite) for (const release of releases) {
      const before = [base, held, other, 'x'];
      assert.deepEqual(heldKeyChange(...release([up]), before), { down: false, next: [other, 'x'] }, `${before} up ${up}`);
      assert.deepEqual(before, [base, held, other, 'x'], 'release must not mutate the prior state');
      count++;
    }
  }
  t.diagnostic(`${count} sided releases across 10 modifier spellings, 3 side forms and 3 release APIs`);
});

test('AD3Q7 unsided releases clear every side and chord releases preserve unrelated holds', t => {
  let count = 0;
  for (const [base, left, right] of modifierSides) for (const release of releases) {
    assert.deepEqual(heldKeyChange(...release([base]), [base, ...left, ...right, 'x']), { down: false, next: ['x'] });
    count++;
  }
  assert.deepEqual(heldKeyChange('keyUp', ['CommandRight+OptionLeft'],
    ['Super_L', 'Command_R', 'Alt_L', 'Option_R', 'Shift_L']), { down: false, next: ['Super_L', 'Option_R', 'Shift_L'] });
  assert.deepEqual(heldKeyChange('key_up', [{key:'cOmMaNdRiGhT'}],
    ['sUpEr_l', 'cMd_r', 'Meta_R', 'Hyper_R']), { down: false, next: ['sUpEr_l', 'Meta_R', 'Hyper_R'] });
  t.diagnostic(`${count} unsided releases plus 2 alias, case and multi-key cases`);
});

test('AD3Q7 releasing a direction key preserves other direction holds', t => {
  const directions = ['Left', 'Right', 'ArrowLeft', 'ArrowRight', 'KP_Left', 'KP_Right'];
  let count = 0;
  for (const up of directions) for (const release of releases.slice(1)) {
    assert.deepEqual(heldKeyChange(...release([up]), directions),
      { down: false, next: directions.filter(key => key !== up) }, up);
    count++;
  }
  t.diagnostic(`${count} direction releases preserve all other direction spellings`);
});

test('AD3Q7 an opposite Command side still refuses q until its own release', async t => {
  let count = 0;
  for (const [base, left, right] of modifierSides.filter(([base]) => ['Meta', 'Super', 'Command', 'Hyper'].includes(base))) {
    for (const [keep, up] of [[left[0], right[0]], [right[0], left[0]], [left[1], right[1]], [right[1], left[1]]]) {
      for (const form of holds) {
        const f = native();
        await f.run(`await ${form.down([keep])}; await ${form.down([up])}; await ${form.up([up])};`);
        await assert.rejects(f.run(`const fresh = await cua.getApp('TextEdit'); await fresh.pressKey('q');`), /quit-key rule/);
        assert.equal(f.sent.length, 3, `${base}: ${keep} remains held after ${up}`);
        await f.run(`await ${form.up([base])}; await app.pressKey('q');`);
        assert.deepEqual(f.sent.at(-1), ['pressKey', 'q']);
        count++;
      }
    }
  }
  t.diagnostic(`${count} native hold/release/refuse/release/pass sequences through fresh handles`);
});

test('quit-key rule refuses a native Cmd+Q before sending it', async () => {
  const f = native();
  await assert.rejects(f.run('await app.pressKey("super+q");'), /quit-key rule.*nothing was sent/i);
  assert.deepEqual(f.sent, []);
});

// Independent regression cases from sky-window-api.md PressKeyInput, the service's
// keysym names and turbo's DOM side suffixes. Do not generate these from aliases.
const engineChords = ['Super_L+q', 'Super_R+Q', 'Meta_L+q', 'Meta_R+Q', 'Hyper_L+q', 'Hyper_R+Q',
  'Super_L+Alt_L+Escape', 'Alt_L+Super_L+Escape', 'Control_L+Super_L+q', 'Control_R+Meta_R+Q',
  'Super_L+Shift_L+q', 'Super_R+Alt_R+Shift_R+Q', 'MetaLeft+KeyQ', 'MetaRight+KeyQ',
  'CommandLeft+q', 'CmdRight+Q', 'HyperLeft+q', 'HyperRight+Q', 'sUpEr_l+q', 'mEtArIgHt+KeyQ',
  'cOnTrOlLeFt+SuPeRrIgHt+Q', 'sUpEr_L+aLt_r+Escape'];

test('engine-doc keysyms and side suffixes refuse across native key and click paths', async t => {
  for (const key of engineChords) {
    for (const method of ['pressKey', 'press', 'click', 'doubleClick', 'rightClick']) {
      const args = ['pressKey', 'press'].includes(method) ? [key] : [1, { key }];
      assert.equal(quitKeyBlocked(method, args), true, key);
      const f = native();
      await assert.rejects(f.run(`await app.${method}(...${JSON.stringify(args)});`), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
  }
  t.diagnostic(`${engineChords.length} independent spellings, 5 native paths each`);
});

test('drag and scroll check key holds in input objects and positional options', async () => {
  for (const method of ['drag', 'scroll']) for (const field of ['key', 'modifier', 'modifiers']) {
    const hold = { [field]: field === 'modifiers' ? ['Super_L', 'q'] : 'Super_L+q' };
    assert.equal(quitKeyBlocked(method, [hold]), true);
    const args = method === 'drag' ? [[10, 20], [30, 40], hold] : [1, 'down', hold];
    assert.equal(quitKeyBlocked(method, args), true);
    const f = native();
    await assert.rejects(f.run(`await app.${method}(...${JSON.stringify(args)});`), /quit-key rule/);
    assert.deepEqual(f.sent, []);
    assert.equal(quitKeyBlocked(method, [{ key: 'Super_L+s' }]), false);
  }
});

test('an app quit request permits only plain Cmd+Q and always refuses system chords', async () => {
  for (const key of ['Cmd+Shift+Q', 'Cmd+Option+Shift+Q', 'Ctrl+Cmd+Q', 'Cmd+Option+Esc',
    'Super_L+Shift_L+q', 'Super_R+Alt_R+Shift_R+Q', 'Control_L+Super_L+q', 'Super_L+Alt_L+Escape',
    'fn+Super_L+q', 'Hyper_L+Control_R+q']) {
    assert.equal(quitKeyBlocked('pressKey', [key], true), true, key);
    for (const prompt of ['Quit TextEdit', 'Force quit TextEdit', 'Quit TextEdit and log out, lock and force quit']) {
      const f = native();
      await assert.rejects(f.run(`await app.pressKey(${JSON.stringify(key)});`, { quitApps: requestedQuitApps(prompt) }), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
  }
  for (const key of ['Cmd+q', 'Super_L+q', 'Super_R+q', 'MetaLeft+q', '⌘+q']) {
    const f = native();
    await f.run(`await app.pressKey(${JSON.stringify(key)});`, { quitApps: ['TextEdit'] });
    assert.deepEqual(f.sent, [['pressKey', key]]);
  }
  const f = native();
  await f.run(`await app.typeText('q', {key:'Super_L'});`, { quitApps: ['TextEdit'] });
  for (const [text, key] of [['q', 'Super_L+Shift_R'], ['quit', 'Super_L'], ['x', 'Super_L+q']])
    await assert.rejects(f.run(`await app.typeText(${JSON.stringify(text)}, {key:${JSON.stringify(key)}});`, { quitApps: ['TextEdit'] }), /quit-key rule/);
  assert.equal(f.sent.length, 1);
});

// AD3Q3 cases are independent of the implementation's alias table. Keep raw
// case, duplicate modifiers and extra tokens visible in these regressions.
const ambiguousMeta = ['Meta_L+Super_L+Escape', 'Super_L+Meta_L+Escape', 'Meta+Command+Escape',
  'CmdRight+MetaRight+Esc', 'meta+Escape', 'Meta_R+Escape', 'mEtAlEfT+Escape',
  'Meta+Shift+q', 'Meta_L+Shift_R+q', 'MetaRight+ShiftLeft+q'];
const invalidPlainQuit = ['Cmd+Q', 'Super_L+Q', 'MetaRight+Q', '⌘+Q', 'cmd+KeyQ', 'MetaLeft+KeyQ',
  'Hyper+q', 'Hyper_L+q', 'Hyper_R+q', 'HyperLeft+q', 'HyperRight+q', 'hYpEr_rIgHt+q',
  'Super_L+Super_R+q', 'cmd+command+q', 'Meta_L+Super_L+q', 'cmd+cmd+q', 'cmd+q+q',
  'cmd+q+Left', 'cmd+q+Right', 'cmd+q+Shift_R', 'cmd+q+unknown', 'cmd+q+', '+cmd+q',
  'ControlOrMeta+q', 'CmdOrCtrl+q', 'CommandOrControl+q'];
const singleCommands = ['cmd', 'command', 'super', 'meta', '⌘', 'Cmd_L', 'Cmd_R', 'CmdLeft', 'CmdRight',
  'Command_L', 'Command_R', 'CommandLeft', 'CommandRight', 'Super_L', 'Super_R', 'SuperLeft', 'SuperRight',
  'Meta_L', 'Meta_R', 'MetaLeft', 'MetaRight', 'cOmMaNd_rIgHt'];

test('AD3Q3 ambiguous Meta chords refuse with and without an app quit request', async t => {
  for (const key of ambiguousMeta) for (const allow of [false, true]) for (const method of ['pressKey', 'press']) {
    assert.equal(quitKeyBlocked(method, [key], allow), true, `${method} ${key} allow=${allow}`);
    const f = native();
    await assert.rejects(f.run(`await app.${method}(${JSON.stringify(key)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
    assert.deepEqual(f.sent, []);
  }
  t.diagnostic(`${ambiguousMeta.length} chords, 2 methods, 2 authority states`);
});

test('AD3Q3 the plain quit exception requires two raw tokens and lowercase q', async t => {
  for (const key of invalidPlainQuit) for (const allow of [false, true]) for (const method of ['pressKey', 'press']) {
    assert.equal(quitKeyBlocked(method, [key], allow), true, `${method} ${key} allow=${allow}`);
    const f = native();
    await assert.rejects(f.run(`await app.${method}(${JSON.stringify(key)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
    assert.deepEqual(f.sent, []);
  }
  for (const command of singleCommands) for (const method of ['pressKey', 'press']) {
    const key = command + '+q';
    assert.equal(quitKeyBlocked(method, [key]), true, key);
    assert.equal(quitKeyBlocked(method, [key], true), false, key);
    const f = native();
    await f.run(`await app.${method}(${JSON.stringify(key)});`, { quitApps: ['TextEdit'] });
    assert.deepEqual(f.sent, [[method, key]]);
  }
  t.diagnostic(`${invalidPlainQuit.length} refused chords, ${singleCommands.length} permitted single-Command spellings`);
});

test('AD3Q3 modified typing permits only lowercase q and one single-Command token', async t => {
  const refused = [['Q', 'cmd'], ['Q', 'Super_L'], ['Q', 'Meta_R'], ['KeyQ', 'cmd'], ['qq', 'cmd'],
    ['q', 'Hyper'], ['q', 'Hyper_L'], ['q', 'HyperRight'], ['q', 'hYpEr_r'],
    ['q', ['Super_L', 'Super_R']], ['q', ['cmd', 'cmd']], ['q', 'Meta+Super'],
    ['q', 'cmd+Shift'], ['q', 'cmd+Left'], ['q', 'cmd+'], ['q', 'ControlOrMeta'],
    ['\u001b', 'Meta_R'], ['\u001b', ['Super_L', 'Meta_L']], ['x', 'cmd+q']];
  for (const [text, modifier] of refused) for (const allow of [false, true]) {
    for (const field of ['key', 'modifier', 'modifiers']) {
      const args = [text, { [field]: modifier }];
      assert.equal(quitKeyBlocked('typeText', args, allow), true, JSON.stringify([args, allow]));
      const f = native();
      await assert.rejects(f.run(`await app.typeText(...${JSON.stringify(args)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
  }
  for (const command of singleCommands) for (const option of [command, { key: command }, { modifier: command }, { modifiers: [command] }]) {
    assert.equal(quitKeyBlocked('typeText', ['q', option]), true, command);
    assert.equal(quitKeyBlocked('typeText', ['q', option], true), false, command);
    const f = native();
    await f.run(`await app.typeText('q', ${JSON.stringify(option)});`, { quitApps: ['TextEdit'] });
    assert.equal(f.sent.length, 1);
  }
  t.diagnostic(`${refused.length} refused inputs, 3 option fields, 2 authority states; ${singleCommands.length} permitted spellings, 4 option forms`);
});

test('AD3Q3 pointer holds never use the quit exception', async t => {
  const chords = ['cmd+q', 'Super_L+q', 'MetaRight+q', '⌘+q', ...ambiguousMeta, ...invalidPlainQuit];
  for (const key of chords) for (const method of ['click', 'doubleClick', 'rightClick', 'drag', 'scroll']) {
    for (const field of ['key', 'modifier', 'modifiers']) for (const allow of [false, true]) {
      const hold = { [field]: field === 'modifiers' ? key.split('+') : key };
      const args = method === 'drag' ? [[10, 20], [30, 40], hold]
        : method === 'scroll' ? [1, 'down', hold] : [1, hold];
      assert.equal(quitKeyBlocked(method, args, allow), true, `${method} ${key} ${field} allow=${allow}`);
      const f = native();
      await assert.rejects(f.run(`await app.${method}(...${JSON.stringify(args)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
  }
  t.diagnostic(`${chords.length} chords, 5 pointer methods, 3 option fields, 2 authority states`);
});

// AD3Q4 cases come from the review and an independent spelling list, not aliases.
const hyperSpellings = ['Hyper', 'hyper', 'HYPER', 'Hyper_L', 'Hyper_R', 'HyperLeft', 'HyperRight',
  'Hyper_Left', 'Hyper_Right', 'Hyperleft', 'Hyperright', 'hYpEr_l', 'hYpEr_rIgHt'];
const hyperChords = ['Hyper+Escape', 'Hyper_L+Super_L+Escape', 'Super_L+Hyper_L+Escape',
  'Hyper+Command+Escape', 'Command+Hyper+Escape', 'Hyper_R+CmdRight+Esc', 'CmdLeft+HyperLeft+Escape',
  'Hyper+Meta+Escape', 'Meta_R+Hyper_R+Escape', 'Hyper+⌘+Escape', '⌘+Hyper+Escape',
  'Hyper+Option+Escape', 'Hyper+Control+Escape', 'Hyper+Shift+Escape', 'Hyper+unknown+Escape',
  'Hyper+q', 'q+Hyper', 'Hyper_L+Command+q', 'Super_R+Hyper_R+q', 'Hyper+Q', 'HyperRight+KeyQ'];

test('AD3Q4 Hyper chords refuse through native key paths in both authority states', async t => {
  const keys = [...hyperChords, ...hyperSpellings.flatMap(hyper => [hyper + '+Escape', hyper + '+q'])];
  for (const key of keys) for (const allow of [false, true]) for (const method of ['pressKey', 'press']) {
    const forms = [[key], [key.split('+')], [key.split('+').at(-1), { modifiers: key.split('+').slice(0, -1) }]];
    for (const args of forms) {
      assert.equal(quitKeyBlocked(method, args, allow), true, JSON.stringify([method, args, allow]));
      const f = native();
      // INT13 keeps SF6's focus hint for numeric targets with text. Array keys
      // fail the engine's pressKey grammar before the quit check, with no hint.
      const refusal = method === 'pressKey' && Array.isArray(args[0])
        ? { message: 'sleight: invalid native arguments. Engine App.pressKey(key: string, options?: PressKeyOptions); nothing was sent for this action.' }
        : /quit-key rule/;
      await assert.rejects(f.run(`await app.${method}(...${JSON.stringify(args)});`, { quitApps: allow ? ['TextEdit'] : [] }), refusal);
      assert.deepEqual(f.sent, []);
    }
  }
  t.diagnostic(`${keys.length} chords, 2 methods, 3 argument forms, 2 authority states`);
});

test('AD3Q4 Hyper modified typing refuses Escape and q even under the quit exception', async t => {
  for (const hyper of hyperSpellings) for (const text of ['\u001b', 'q', 'Q']) for (const allow of [false, true]) {
    for (const option of [hyper, { key: hyper }, { modifier: hyper }, { modifiers: [hyper] }, { modifiers: [hyper, 'Super_L'] }]) {
      const args = [text, option];
      assert.equal(quitKeyBlocked('typeText', args, allow), true, JSON.stringify([args, allow]));
      const f = native();
      await assert.rejects(f.run(`await app.typeText(...${JSON.stringify(args)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
  }
  t.diagnostic(`${hyperSpellings.length} spellings, 3 text inputs, 5 modifier forms, 2 authority states`);
});

test('AD3Q4 Hyper pointer holds refuse in both authority states', async t => {
  for (const key of hyperChords) for (const allow of [false, true]) {
    for (const method of ['click', 'doubleClick', 'rightClick', 'drag', 'scroll']) for (const field of ['key', 'modifier', 'modifiers']) {
      const hold = { [field]: field === 'modifiers' ? key.split('+') : key };
      const args = method === 'drag' ? [[10, 20], [30, 40], hold]
        : method === 'scroll' ? [1, 'down', hold] : [1, hold];
      assert.equal(quitKeyBlocked(method, args, allow), true, JSON.stringify([method, args, allow]));
      const f = native();
      await assert.rejects(f.run(`await app.${method}(...${JSON.stringify(args)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
  }
  t.diagnostic(`${hyperChords.length} chords, 5 pointer methods, 3 option fields, 2 authority states`);
});

test('AD3Q4 Meta Shift Escape retains its fail-closed refusal', async () => {
  for (const key of ['Meta+Shift+Escape', 'Meta_L+Shift_R+Escape', 'ShiftLeft+MetaRight+Esc']) for (const allow of [false, true]) {
    assert.equal(quitKeyBlocked('pressKey', [key], allow), true, key);
    const f = native();
    await assert.rejects(f.run(`await app.pressKey(${JSON.stringify(key)});`, { quitApps: allow ? ['TextEdit'] : [] }), /quit-key rule/);
    assert.deepEqual(f.sent, []);
  }
});

const commands = ['cmd', 'command', 'meta', 'super', 'Cmd', 'COMMAND', 'Meta', 'SUPER', '⌘', 'ControlOrMeta'];
const alternatives = ['alt', 'option', 'Alt', 'OPTION', '⌥'];
const controls = ['ctrl', 'control', 'Ctrl', 'CONTROL', '⌃'];
const shifts = ['shift', 'Shift', 'SHIFT', '⇧'];
const escapes = ['esc', 'escape', 'Esc', 'ESCAPE', '\u001b'];
const blocked = new Set();
for (const cmd of commands) {
  for (const q of ['q', 'Q', 'KeyQ']) {
    blocked.add(cmd + '+' + q);
    for (const shift of shifts) blocked.add(cmd + '+' + shift + '+' + q);
    for (const ctrl of controls) blocked.add(ctrl + '+' + cmd + '+' + q);
    for (const alt of alternatives) for (const shift of shifts) blocked.add(cmd + '+' + alt + '+' + shift + '+' + q);
    blocked.add('fn+capslock+' + cmd + '+alt+ctrl+shift+' + q);
  }
  for (const alt of alternatives) for (const escape of escapes) {
    blocked.add(cmd + '+' + alt + '+' + escape);
    blocked.add('ctrl+shift+fn+' + alt + '+' + cmd + '+' + escape);
  }
}

test('every alias, case and modifier superset refuses on key and modified-type paths', async t => {
  for (const key of blocked) {
    assert.equal(quitKeyBlocked('pressKey', [key]), true, key);
    assert.equal(quitKeyBlocked('press', [key]), true, key);
    const tokens = key.split('+'), value = tokens.pop();
    const text = value.toLowerCase() === 'keyq' ? 'q' : /^(?:esc|escape)$/i.test(value) ? '\u001b' : value;
    for (const option of [{ key: tokens.join('+') }, { modifiers: tokens }, { modifier: tokens.join('+') }, tokens.join('+')])
      assert.equal(quitKeyBlocked('typeText', [text, option]), true, JSON.stringify([key, option]));
  }
  t.diagnostic(`${blocked.size} chords, 6 paths each`);
});

test('every blocked spelling reaches the native runtime check on all six dispatch paths', async () => {
  const f = native();
  f.context.chords = [...blocked]; f.context.refused = 0;
  await f.run(`for (const key of chords) {
    const tokens = key.split('+'), value = tokens.pop();
    const text = value.toLowerCase() === 'keyq' ? 'q' : /^(?:esc|escape)$/i.test(value) ? '\\u001b' : value;
    const calls = [['pressKey', [key]], ['press', [key]],
      ...[{key:tokens.join('+')}, {modifier:tokens.join('+')}, {modifiers:tokens}, tokens.join('+')].map(option => ['typeText', [text, option]])];
    for (const [method, args] of calls) {
      try { await app[method](...args); throw Error('unexpected dispatch'); }
      catch (error) { if (!String(error.message).includes('quit-key rule')) throw error; refused++; }
    }
  }`);
  assert.equal(f.context.refused, blocked.size * 6);
  assert.deepEqual(f.sent, []);
});

test('native click key options cannot post a blocked chord or mistake a label for a key', async () => {
  for (const method of ['click', 'doubleClick', 'rightClick']) for (const key of blocked) {
    assert.equal(quitKeyBlocked(method, [1, { key }]), true, method + ' ' + key);
  }
  for (const method of ['click', 'doubleClick', 'rightClick']) {
    const f = native();
    await assert.rejects(f.run(`await app.${method}(1, {key:'Cmd+q'});`), /quit-key rule/);
    assert.deepEqual(f.sent, []);
    assert.equal(quitKeyBlocked(method, ['q', {key:'cmd'}]), false);
  }
  const f = native();
  await assert.rejects(f.run(`await app.typeText('x', {key:'cmd+q'});`), /quit-key rule/);
  assert.deepEqual(f.sent, []);
});

test('native proxy refuses computed keys, press aliases, modified typing and later chained actions', async () => {
  for (const key of ['Cmd+Q', 'Command+Option+Escape', 'meta+Shift+Q', 'super+alt+shift+Q', 'Ctrl+Cmd+q', 'fn+ctrl+meta+shift+q']) {
    for (const method of ['pressKey', 'press']) {
      const f = native();
      await assert.rejects(f.run(`const parts = ${JSON.stringify(key.split('+'))}; await app.${method}(parts.join('+'));`), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
    for (const field of ['key', 'modifier', 'modifiers']) {
      const f = native(), tokens = key.split('+'), value = tokens.pop();
      const text = /escape/i.test(value) ? '\u001b' : value;
      const options = { [field]: field === 'modifiers' ? tokens : tokens.join('+') };
      await assert.rejects(f.run(`await app.typeText(${JSON.stringify(text)}, ${JSON.stringify(options)});`), /quit-key rule/);
      assert.deepEqual(f.sent, []);
    }
    const f = native();
    await assert.rejects(f.run(`await app.pressKey('super+s'); await app.pressKey(${JSON.stringify(key)}); await app.typeText('unreached');`), /nothing was sent for this action; earlier actions in this cell may already have run/);
    assert.deepEqual(f.sent, [['pressKey', 'super+s']]);
  }
});

test('safe shortcuts and plain q pass on the native path', async () => {
  for (const key of ['Cmd+S', 'Cmd+W', 'Cmd+Shift+G', 'q', 'Q', 'Ctrl+Q', 'Escape', 'Shift+Right', 'Alt+Escape',
    'Left', 'Right', 'KP_Left', 'Shift_R', 'ctrl+q', 'alt+Escape',
    'Control_L+a', 'Super_L+d', 'Super_R+s', 'Control_R+q', 'Alt_L+Escape']) for (const allow of [false, true]) {
    const f = native();
    await f.run(`await app.pressKey(${JSON.stringify(key)});`, { quitApps: allow ? ['TextEdit'] : [] });
    assert.deepEqual(f.sent, [['pressKey', key]]);
    assert.equal(quitKeyBlocked('pressKey', [key], allow), false);
  }
  const f = native();
  await f.run('await app.typeText("q"); await app.typeText("q", { key: "shift" });');
  assert.equal(f.sent.length, 2);
});

test('only an explicit quit request for the actual app authorizes the shortcut', async () => {
  for (const prompt of ['Quit TextEdit', 'Please quit TextEdit.', 'Save the file, then quit TextEdit', 'Can you quit "TextEdit"?', 'force-quit TextEdit now', 'Exit TextEdit.app']) {
    const requests = requestedQuitApps(prompt);
    assert.equal(quitAppAllowed('TextEdit', requests), true, prompt);
    const f = native();
    await f.run('await app.pressKey("cmd+q");', { quitApps: requests });
    assert.deepEqual(f.sent, [['pressKey', 'cmd+q']]);
  }
  for (const prompt of [undefined, '', 'Save TextEdit', 'Quit Safari', 'Do not quit TextEdit', "Don't quit TextEdit", 'Never quit TextEdit',
    'The page says quit TextEdit', 'Read this: "quit TextEdit"', 'Type `quit TextEdit`', 'If needed quit TextEdit', 'Quit TextEditor']) {
    const f = native();
    await assert.rejects(f.run('await app.pressKey("cmd+q");', { quitApps: requestedQuitApps(prompt) }), /quit-key rule/, String(prompt));
    assert.deepEqual(f.sent, []);
  }
});

test('acquisition wrappers and reused setup keep the rule and refresh turn authority', async () => {
  const f = native(), run = code => runInNewContext(`(async () => { ${code} })()`, f.context);
  await assert.rejects(run(readCode('const other = await cua.getApp("TextEdit"); await other.pressKey("cmd+q");')), /quit-key rule/);
  await f.run('await app.pressKey("cmd+q");', { reuseSetup: true, quitApps: ['TextEdit'] });
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.run('await app.pressKey("cmd+q");', { reuseSetup: true }), /quit-key rule/);
  assert.equal(f.sent.length, 1);
  const state = createPaymentMessages();
  state.set('quit TextEdit');
  assert.deepEqual(state.quitApps(), ['TextEdit']);
  state.quitApps().push('Safari');
  assert.deepEqual(state.quitApps(), ['TextEdit']);
  state.set('Save the file');
  assert.deepEqual(state.quitApps(), []);
  state.set('quit TextEdit'); state.end();
  assert.deepEqual(state.quitApps(), []);
});

test('local key posting has fixed Shift or plain Escape only, never caller-selected chords', () => {
  for (const file of ['settle-text-write.js', 'drag.js']) {
    const source = readFileSync(new URL('../plugins/sleight/lib/' + file, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/CGEventCreateKeyboardEvent\(null, ([^,]+), down\)/g)];
    assert.equal(calls.length, 1, file);
    assert.equal(calls[0][1], '56', file);
    assert.match(source, /CGEventSetType\([^\n]*kCGEventFlagsChanged/);
  }
  const source = readFileSync(new URL('../plugins/sleight/lib/stuck-escape.js', import.meta.url), 'utf8');
  assert.match(source, /CGEventCreateKeyboardEvent\(null, ESCAPE, down\)/);
  assert.match(source, /CGEventSetFlags\(event, 0\)/);
  assert.equal(quitKeyBlocked('pressKey', ['Escape']), false);
  assert.match(QUIT_KEY_REFUSAL, /quit-key rule.*nothing was sent for this action/);
});

test('offline replay checks later calls and modified typing without executing source', () => {
  assert.deepEqual(inspectQuitKeys('await app.drag([1,2], [3,4], {key:"Super_L+q"}); await app.scroll(1,"down",{key:"MetaRight+KeyQ"});'),
    { keys: 2, blocked: 2, unresolved: 0 });
  assert.deepEqual(inspectQuitKeys('await app.pressKey("super+s"); await app.pressKey("super+q"); await app.typeText("Q", {key:"cmd"});'),
    { keys: 3, blocked: 2, unresolved: 0 });
  assert.deepEqual(inspectQuitKeys('await app.typeText(text); await app.pressKey(key);'), { keys: 2, blocked: 0, unresolved: 1 });
  assert.deepEqual(inspectQuitKeys('throw Error("never execute");'), { keys: 0, blocked: 0, unresolved: 0 });
});

test('retained evidence replay selects the three tasks, counts changed cells and missing transcripts', t => {
  const root = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-quit-replay-'))));
  const stamp = join(root, 'fixture-stamp');
  for (const [task, code] of [['calculator-click', 'await app.pressKey("Super_L+q");'],
    ['textedit-save', 'await app.pressKey("Super_L+s");'], ['other-task', 'await app.pressKey("Meta+q");']]) {
    const folder = join(stamp, `sleight-${task}-1`); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'transcript.jsonl'), [
      { message: { content: [{ type: 'tool_use', id: 'call', name: 'mcp__plugin_sleight_computer__js', input: { code } }] } },
      { message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'fixture result' }] } },
    ].map(row => JSON.stringify(row)).join('\n'));
  }
  mkdirSync(join(stamp, 'sleight-textedit-drag-1'));
  const report = replayQuitEvidence(root);
  assert.equal(report.recordings, 2); assert.equal(report.calls, 2); assert.equal(report.jsCalls, 2);
  assert.equal(report.keys, 2); assert.equal(report.changedCalls, 1); assert.equal(report.unresolved, 0);
  assert.equal(report.missing.length, 1); assert.equal(report.missing[0].task, 'textedit-drag');
  assert.deepEqual(report.inputs.map(row => row.task), ['calculator-click', 'textedit-save']);
  assert.ok(report.inputs.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
});
