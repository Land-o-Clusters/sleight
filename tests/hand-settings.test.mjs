import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { handConfigPath, handDoctorLines, handSetting, handStatusLines, readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';
import { handCommand } from '../plugins/sleight/lib/hand/command.mjs';
import { writeHandSetting } from '../plugins/sleight/lib/hand/command.mjs';

test('cursor style and character use the private v1 settings file and style environment precedence', t => {
  const w = world(t);
  w.write({ version: 1, enabled: true, style: 'sprite', character: 'test-cat', stream: true, labels: 'role' });
  assert.equal(w.setting().style, 'sprite');
  assert.equal(w.setting().character, 'test-cat');
  assert.equal(w.setting({ SLEIGHT_CURSOR_STYLE: 'ring' }).style, 'ring');
  assert.equal(w.setting({ SLEIGHT_CURSOR_STYLE: 'bogus' }).style, 'glove');
  assert.equal(w.setting({ SLEIGHT_CURSOR_STYLE: 'bogus' }).styleReason, 'env-invalid');
  writeHandSetting({ capture: 'visible' }, { path: w.path });
  assert.equal(w.setting().style, 'sprite');
  assert.equal(w.setting().character, 'test-cat');
  for (const extra of [{ style: 'other' }, { style: null }, { character: '../x' }, { character: '' }, { character: 'Cat' }]) {
    w.write({ version: 1, enabled: true, ...extra });
    assert.equal(readHandConfig(w.path).state, 'unsafe');
  }
  w.write({ version: 1, enabled: true, style: 'ring' }, 0o644);
  assert.equal(w.setting().style, undefined);
});

function world(t) {
  const home = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hand-settings-')))));
  const path = handConfigPath(home);
  const lines = [], out = text => lines.push(text);
  const command = (args, options = {}) => handCommand(args, { out, path, env: {}, platform: 'darwin', built: () => false, ...options });
  const setting = (env = {}, platform = 'darwin') => handSetting({ env, platform, path });
  const write = (data, mode = 0o600) => {
    mkdirSync(join(home, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
    writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data), { mode }); chmodSync(path, mode);
  };
  return { home, path, lines, command, setting, write, output: () => lines.join('') };
}

test('precedence: platform, explicit env 0 or 1, unsafe file, saved choice, then off by default', t => {
  const w = world(t);
  assert.deepEqual(w.setting(), { enabled: false, reason: 'default', capture: 'hidden', captureReason: 'default', narration: 'off' });
  assert.deepEqual(w.setting({ SLEIGHT_HAND: '1' }, 'linux'), { enabled: false, reason: 'platform', capture: 'hidden', captureReason: 'default', narration: 'off' });
  for (const value of ['', 'false', 'off', 'true', '2']) {
    assert.deepEqual([w.setting({ SLEIGHT_HAND: value }).enabled, w.setting({ SLEIGHT_HAND: value }).reason], [false, 'default'], value);
  }
  assert.deepEqual([w.setting({ SLEIGHT_HAND: '1' }).enabled, w.setting({ SLEIGHT_HAND: '1' }).reason], [true, 'env']);
  w.write({ version: 1, enabled: false });
  assert.deepEqual([w.setting().enabled, w.setting().reason], [false, 'user']);
  assert.deepEqual([w.setting({ SLEIGHT_HAND: '1' }).enabled, w.setting({ SLEIGHT_HAND: '1' }).reason], [true, 'env']);
  w.write({ version: 1, enabled: true });
  assert.deepEqual([w.setting().enabled, w.setting().reason], [true, 'user']);
  assert.deepEqual([w.setting({ SLEIGHT_HAND: '0' }).enabled, w.setting({ SLEIGHT_HAND: '0' }).reason], [false, 'env']);
  w.write({ version: 1, enabled: true }, 0o644);
  assert.deepEqual([w.setting().enabled, w.setting().reason], [false, 'unsafe']);
  assert.equal(w.setting({ SLEIGHT_HAND: '0' }).reason, 'env');
  assert.deepEqual([w.setting({ SLEIGHT_HAND: '1' }).enabled, w.setting({ SLEIGHT_HAND: '1' }).reason], [true, 'env']);
});

test('capture precedence: SLEIGHT_HAND_CAPTURE wins over the file, an unknown value keeps the panel hidden, default hidden', t => {
  const w = world(t);
  const capture = env => { const s = w.setting(env); return [s.capture, s.captureReason]; };
  assert.deepEqual(capture({}), ['hidden', 'default']);
  assert.deepEqual(capture({ SLEIGHT_HAND_CAPTURE: 'visible' }), ['visible', 'env']);
  assert.deepEqual(capture({ SLEIGHT_HAND_CAPTURE: 'hidden' }), ['hidden', 'env']);
  for (const value of ['Visible', 'readOnly', 'none', '1', ' visible']) assert.deepEqual(capture({ SLEIGHT_HAND_CAPTURE: value }), ['hidden', 'env-invalid'], value);
  assert.deepEqual(capture({ SLEIGHT_HAND_CAPTURE: '' }), ['hidden', 'default']);
  w.write({ version: 1, enabled: true, capture: 'visible' });
  assert.deepEqual(capture({}), ['visible', 'user']);
  assert.deepEqual(capture({ SLEIGHT_HAND_CAPTURE: 'hidden' }), ['hidden', 'env']);
  assert.deepEqual(capture({ SLEIGHT_HAND_CAPTURE: 'bogus' }), ['hidden', 'env-invalid']);
  w.write({ version: 1, enabled: true, capture: 'shown' });
  assert.deepEqual([w.setting().enabled, w.setting().reason, ...capture({})], [false, 'unsafe', 'hidden', 'default']);
});

test('hand.json reads strictly: links, other modes and any other shape are unsafe', t => {
  const w = world(t);
  assert.deepEqual(readHandConfig(w.path), { state: 'absent' });
  for (const data of ['{', '[]', 'null', { version: 2, enabled: false }, { version: 1, enabled: 'false' }, { version: 1 },
    { version: 1, enabled: false, extra: 1 }, { version: 1, enabled: false, capture: null }, { version: 1, enabled: false, capture: 'readOnly' }]) {
    w.write(data); assert.deepEqual(readHandConfig(w.path), { state: 'unsafe' }, JSON.stringify(data));
  }
  w.write({ version: 1, enabled: false }, 0o640); assert.deepEqual(readHandConfig(w.path), { state: 'unsafe' });
  w.write({ version: 1, enabled: false, capture: 'hidden' }); assert.deepEqual(readHandConfig(w.path), { state: 'off', capture: 'hidden' });
  const target = join(w.home, 'elsewhere.json'); writeFileSync(target, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
  const link = join(w.home, 'linked.json'); symlinkSync(target, link);
  assert.deepEqual(readHandConfig(link), { state: 'unsafe' });
  assert.deepEqual(readHandConfig(w.path, process.getuid() + 1), { state: 'unsafe' });
});

test('fresh status is off and changing capture alone preserves that default', t => {
  const w = world(t);
  assert.equal(w.command(['status']), 0);
  assert.equal(w.output(), 'hand      off (the default; sleight-mcp hand on turns it on)\n');
  assert.equal(w.command(['capture', 'visible']), 0);
  assert.deepEqual(JSON.parse(readFileSync(w.path, 'utf8')), { version: 1, enabled: false, capture: 'visible' });
  assert.equal(w.command(['off'], { env: { SLEIGHT_HAND: '1' } }), 0);
  assert.match(w.output(), /SLEIGHT_HAND=1 in this environment still keeps it on/);
  assert.deepEqual(handStatusLines(w.setting({ SLEIGHT_HAND: '1' }), true), [
    'hand      on (SLEIGHT_HAND=1)', 'capture   visible (your screenshots and recordings show the hand)', 'host      compiled']);
});

test('hand off, on and capture write hand.json privately, each keeping the other field, and status reads it', t => {
  const w = world(t);
  assert.equal(w.command(['off']), 0);
  assert.deepEqual(JSON.parse(readFileSync(w.path, 'utf8')), { version: 1, enabled: false });
  assert.equal(lstatSync(w.path).mode & 0o777, 0o600);
  assert.match(w.output(), /ghost hand is off/);
  assert.equal(w.command(['capture', 'visible']), 0);
  assert.deepEqual(JSON.parse(readFileSync(w.path, 'utf8')), { version: 1, enabled: false, capture: 'visible' });
  assert.equal(w.command(['on']), 0);
  assert.deepEqual(JSON.parse(readFileSync(w.path, 'utf8')), { version: 1, enabled: true, capture: 'visible' });
  assert.equal(w.command(['capture', 'hidden']), 0);
  assert.deepEqual(JSON.parse(readFileSync(w.path, 'utf8')), { version: 1, enabled: true, capture: 'hidden' });
  w.lines.length = 0;
  assert.equal(w.command(['status'], { built: () => true }), 0);
  assert.equal(w.output(), 'hand      on\ncapture   hidden (no screenshot or recording shows the hand)\nhost      compiled\n');
  w.lines.length = 0;
  assert.equal(w.command(['on'], { env: { SLEIGHT_HAND: '0' } }), 0);
  assert.match(w.output(), /SLEIGHT_HAND=0 in this environment still keeps it off/);
  for (const args of [[], ['toggle'], ['on', 'now'], ['capture'], ['capture', 'none'], ['capture', 'visible', 'x'], ['status', '-v']]) {
    w.lines.length = 0; assert.equal(w.command(args), 2, args.join(' ')); assert.match(w.output(), /^usage: sleight-mcp hand on/);
  }
});

test('hand on refuses a linked hand.json and leaves the link and its target alone; capture refuses an unsafe file', t => {
  const w = world(t);
  mkdirSync(join(w.home, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
  const target = join(w.home, 'target.json'); writeFileSync(target, 'keep', { mode: 0o600 });
  symlinkSync(target, w.path);
  assert.equal(w.command(['on']), 1);
  assert.match(w.output(), /hand on failed: HAND_CONFIG_LINKED/);
  assert.equal(lstatSync(w.path).isSymbolicLink(), true); assert.equal(readFileSync(target, 'utf8'), 'keep');
  w.lines.length = 0;
  assert.equal(w.command(['capture', 'visible']), 1);
  assert.match(w.output(), /unsafe to read/);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('doctor and status lines name each state, and only an unsafe file or capture value is a problem', () => {
  const on = { enabled: true, reason: 'user', capture: 'hidden', captureReason: 'default' };
  assert.deepEqual(handDoctorLines(on, false), ['ghost hand', 'ok        hand: on, sleight-mcp hand off turns it off',
    'ok        hand capture: hidden (no screenshot or recording shows the hand), the default',
    'ok        hand host: not compiled yet (it compiles in the background the first time sleight acts, and that session has no hand)']);
  assert.deepEqual(handDoctorLines({ ...on, reason: 'user', capture: 'visible', captureReason: 'user' }, true), ['ghost hand',
    'ok        hand: on, sleight-mcp hand off turns it off', 'ok        hand capture: visible (your screenshots and recordings show the hand)',
    'ok        hand host: compiled']);
  assert.deepEqual(handDoctorLines({ ...on, enabled: false, reason: 'user' }, true), ['ghost hand', 'ok        hand: off (you turned it off), sleight-mcp hand on turns it back on']);
  assert.deepEqual(handDoctorLines({ ...on, enabled: false, reason: 'env' }, true), ['ghost hand', 'ok        hand: off (SLEIGHT_HAND=0)']);
  const unsafe = handDoctorLines({ ...on, enabled: false, reason: 'unsafe' }, true);
  assert.match(unsafe[1], /^PROBLEM   hand: off \(hand\.json is a link/); assert.match(unsafe[2], /fix: delete .*hand\.json, then run sleight-mcp hand on/);
  const invalid = handDoctorLines({ ...on, captureReason: 'env-invalid' }, true);
  assert.match(invalid[2], /^PROBLEM   hand capture: hidden .*neither hidden nor visible/); assert.match(invalid[3], /fix: set SLEIGHT_HAND_CAPTURE/);
  assert.deepEqual(handStatusLines({ ...on, capture: 'visible', captureReason: 'env' }, true),
    ['hand      on', 'capture   visible (your screenshots and recordings show the hand), from SLEIGHT_HAND_CAPTURE', 'host      compiled']);
  assert.deepEqual(handStatusLines({ ...on, enabled: false, reason: 'platform' }, false), ['hand      off (macOS only)']);
});

test('doctor prints the ghost hand section after turbo, read-only', async t => {
  const w = world(t), lines = [];
  const { doctor } = await import('../plugins/sleight/lib/launch.mjs');
  const code = await doctor({ settings: () => [], env: { CODEX_HOME: '/no-such-sleight-home', SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' }, log: x => lines.push(x),
    turbo: async () => ['turbo (direct browser path)'], hand: async () => handDoctorLines(w.setting(), false) });
  assert.equal(code, 1);
  assert.match(lines[0], /^sleight \d+\.\d+\.\d+$/);
  assert.deepEqual(lines.slice(1, 4), ['turbo (direct browser path)', 'ghost hand', 'ok        hand: off (the default; sleight-mcp hand on turns it on)']);
  assert.throws(() => lstatSync(w.path), /ENOENT/);
});
