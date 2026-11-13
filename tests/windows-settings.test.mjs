import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSettingsCommand, windowsSettingsRefusal, windowsSettingsExempt, validWindowsHand, validWindowsPermissions } from '../plugins/sleight/lib/windows-settings.mjs';
import { confirmationRefusal } from '../plugins/sleight/lib/person-confirm.mjs';
import { windowsCommand } from '../plugins/sleight/lib/windows-launch.mjs';

function fixture(initial = {}) {
  const data = structuredClone(initial), calls = [], lines = [];
  const options = { platform: 'win32', env: {}, built: async () => false,
    out: text => lines.push(text), error: text => lines.push(text),
    adapter: { person: { presence: async () => { calls.push('presence'); return true; }, prepareConfirm: async () => { calls.push('prepare-confirm'); return { status: 'ready' }; } } },
    gate: async (_args, options) => { calls.push(['gate', options]); },
    confirmation: confirmationRefusal,
    confirm: async (_change, options) => { calls.push('confirm'); assert.equal(options.platform, 'win32'); return 'ok'; },
    notice: () => {},
    store: { withPreapprovedLock: action => action(), read: name => { calls.push('read:' + name); return structuredClone(data[name]); },
      write: (name, value) => { calls.push('write:' + name); data[name] = structuredClone(value); } },
    discovery: { browsers: async () => { calls.push('discovery'); return [{ id: 'chrome', name: 'Google Chrome', installed: true }]; } },
  };
  return { data, calls, lines, options, run: args => windowsSettingsCommand(args, options) };
}
test('Windows revoke removes every duplicate under the preapproved transaction lock', async () => {
  const f = fixture({ 'preapproved.json': { version: 1, apps: [
    { app: 'A', riskLevel: 'high' }, { app: 'B', riskLevel: 'medium' }, { app: 'A', riskLevel: 'low' },
  ] } });
  let locked = false, locks = 0;
  f.options.store.withPreapprovedLock = action => { assert.equal(locked, false); locked = true; locks++; try { return action(); } finally { locked = false; } };
  const read = f.options.store.read, write = f.options.store.write;
  f.options.store.read = name => { if (name === 'preapproved.json') assert.equal(locked, true); return read(name); };
  f.options.store.write = (name, value) => { if (name === 'preapproved.json') assert.equal(locked, true); write(name, value); };
  assert.equal(await f.run(['permissions', 'revoke', 'A']), 0);
  assert.equal(locks, 1);
  assert.deepEqual(f.data['preapproved.json'].apps, [{ app: 'B', riskLevel: 'medium' }]);
});
const high = [
  ['turbo', 'on'], ['turbo', 'on', '--browser', 'chrome'], ['permissions', 'unblock', 'https://example.com'],
  ['permissions', 'unblock', 'com.example.App'], ['permissions', 'sites', 'only', 'https://example.com'],
  ['permissions', 'sites', 'all'], ['permissions', 'repair'], ['permissions', 'repair', '--discard'],
];
for (const args of high) test(`Windows ${args.join(' ')} checks terminal, presence and confirmation before storage`, async () => {
  const f = fixture({ 'permissions.json': { version: 1, apps: [{ id: 'com.example.App' }], sites: ['https://example.com'], only: ['https://example.com'] } });
  assert.equal(await f.run(args), 0, f.lines.join(''));
  assert.deepEqual(f.calls.slice(1, 3), ['presence', 'confirm']);
  assert.equal(f.calls[0][0], 'gate'); assert.equal(f.calls[0][1].freshMs, 10000);
  assert.equal(f.calls[0][1].platform, 'win32');
  assert.ok(f.calls.slice(3).some(call => typeof call === 'string' && call.startsWith('read:') || call === 'discovery' || typeof call === 'string' && call.startsWith('write:')));
});
for (const args of high) test(`Windows ${args.join(' ')} refuses without a terminal and touches no store`, async () => {
  const f = fixture(); f.options.gate = async () => { f.calls.push('gate'); return 'terminal refused'; };
  assert.equal(await f.run(args), 3);
  assert.deepEqual(f.calls, ['gate']); assert.deepEqual(f.data, {});
});
for (const result of ['failed', 'cancelled', 'timeout', 'unavailable', 'unverified']) test(`Windows ${result} confirmation writes nothing`, async () => {
  const f = fixture(); f.options.confirm = async () => { f.calls.push('confirm'); return result; };
  assert.equal(await f.run(['turbo', 'on']), 3);
  assert.deepEqual(f.calls.slice(1), ['presence', 'confirm']); assert.deepEqual(f.data, {});
});
for (const presence of [false, undefined]) test(`Windows presence ${presence} never asks or writes`, async () => {
  const f = fixture(); f.options.adapter.person.presence = async () => { f.calls.push('presence'); return presence; };
  assert.equal(await f.run(['permissions', 'repair']), 3);
  assert.deepEqual(f.calls.slice(1), ['presence']); assert.deepEqual(f.data, {});
});
const looks = [['hand', 'on'], ['hand', 'capture', 'hidden'], ['hand', 'capture', 'visible'], ['cursor', 'style', 'ring'], ['cursor', 'style', 'seam']];
for (const args of looks) test(`Windows ${args.join(' ')} checks the person without an authentication dialog`, async () => {
  const f = fixture(); assert.equal(await f.run(args), 0, f.lines.join(''));
  assert.equal(f.calls[0][0], 'gate'); assert.equal(f.calls[0][1].freshMs, 0);
  assert.equal(f.calls.includes('presence'), false); assert.equal(f.calls.includes('confirm'), false);
});
const exempt = [['hand', 'off'], ['turbo', 'off'],
  ['permissions', 'block', 'https://example.com'], ['permissions', 'block', 'com.example.App'], ['permissions', 'revoke', 'all'],
  ['permissions', 'revoke', 'turbo'], ['permissions', 'revoke', 'com.example.App'], ['permissions', 'revoke', 'https://example.com']];
for (const args of exempt) test(`Windows ${args.join(' ')} keeps the terminal gate without presence or authentication`, async () => {
  const f = fixture(); f.options.confirm = () => assert.fail('removing access must not authenticate');
  assert.equal(windowsSettingsExempt(args), false); assert.equal(await f.run(args), 0, f.lines.join(''));
  assert.equal(f.calls[0][0], 'gate'); assert.equal(f.calls[0][1].freshMs, 0);
  assert.equal(f.calls.includes('presence'), false);
});
for (const args of [['hand', 'status'], ['cursor', 'status'], ['turbo', 'status'], ['permissions'], ['permissions', 'list']]) test(`Windows ${args.join(' ')} reads without person checks or writes`, async () => {
  const f = fixture(); f.options.gate = f.options.confirm = () => assert.fail('read must not ask');
  assert.equal(await f.run(args), 0, f.lines.join(''));
  assert.equal(f.calls.some(c => typeof c === 'string' && c.startsWith('write:')), false);
});
test('Windows look changes preserve stream, capture, labels and character selection', async () => {
  const before = { version: 1, enabled: true, style: 'ring', capture: 'visible', stream: true, labels: 'role', character: 'local-cat' };
  const f = fixture({ 'hand.json': before });
  assert.equal(await f.run(['cursor', 'style', 'seam']), 0);
  assert.deepEqual(f.data['hand.json'], { ...before, style: 'seam' });
  assert.equal(await f.run(['hand', 'off']), 0);
  assert.equal(f.data['hand.json'].stream, true); assert.equal(f.data['hand.json'].enabled, false);
});
test('last allowed site cannot be revoked into unrestricted access', async () => {
  const f = fixture({ 'permissions.json': { version: 1, apps: [], sites: [], only: ['https://example.com'] } });
  assert.equal(await f.run(['permissions', 'revoke', 'https://example.com']), 1);
  assert.equal(f.calls.some(c => typeof c === 'string' && c.startsWith('write:')), false);
});
test('revocation preserves unrelated grants, seals and every block', async () => {
  const before = { 'permissions.json': { version: 1, apps: [{ id: 'com.blocked.App' }], sites: ['https://blocked.example'] },
    'preapproved.json': { version: 1, apps: [{ app: 'com.example.App', riskLevel: 'low' }, { app: 'com.other.App', riskLevel: 'high' }] },
    'electron-grants.json': { version: 2, grants: [{ record: { name: 'Example', bundleId: 'com.example.App' }, seal: 'one' }, { record: { name: 'Other', bundleId: 'com.other.App' }, seal: 'two' }] } };
  const f = fixture(before); assert.equal(await f.run(['permissions', 'revoke', 'com.example.App']), 0);
  assert.deepEqual(f.data['permissions.json'], before['permissions.json']);
  assert.deepEqual(f.data['electron-grants.json'].grants, [before['electron-grants.json'].grants[1]]);
  assert.deepEqual(f.data['preapproved.json'].apps, [before['preapproved.json'].apps[1]]);
});
test('block, unblock and allow-only changes retain all other restrictions', async () => {
  const f = fixture({ 'permissions.json': { version: 1, apps: [{ id: 'com.kept.App', name: 'Kept', aliases: ['Keep'] }], sites: ['https://kept.example'] } });
  for (const args of [['permissions', 'block', 'https://new.example'], ['permissions', 'sites', 'only', 'https://only.example'], ['permissions', 'unblock', 'https://new.example']]) assert.equal(await f.run(args), 0);
  assert.deepEqual(f.data['permissions.json'], { version: 1, apps: [{ id: 'com.kept.App', name: 'Kept', aliases: ['Keep'] }], sites: ['https://kept.example'], only: ['https://only.example'] });
});
test('unsafe settings refuse partial edits without overwriting them', async () => {
  const f = fixture({ 'hand.json': { version: 99, enabled: true } });
  assert.equal(await f.run(['cursor', 'style', 'ring']), 1);
  assert.equal(f.calls.some(c => typeof c === 'string' && c.startsWith('write:')), false);
  for (const value of [null, {}, { version: 1, enabled: true, extra: 1 }]) assert.throws(() => validWindowsHand(value));
  for (const value of [null, {}, { version: 1, apps: [], sites: [], only: [] }]) assert.throws(() => validWindowsPermissions(value));
});
test('near misses do not inherit an exemption', () => {
  for (const args of [['hand', 'off', 'extra'], ['stream', 'off', 'extra'], ['turbo', 'off', 'extra'], ['permissions', 'revoke'], ['permissions', 'block', 'x', 'extra']]) assert.equal(windowsSettingsExempt(args), false);
});
test('Windows-only dispatcher never runs on macOS even with injected writers', async () => {
  const f = fixture(); f.options.platform = 'darwin'; assert.equal(await f.run(['hand', 'on']), 1); assert.deepEqual(f.calls, []);
});
test('Windows CLI routes settings and explicit registration independently of startup', async () => {
  const calls = [];
  const options = { settings: async (args, options) => { calls.push(args); assert.equal(options.platform, 'win32'); return 3; }, register: () => { calls.push('register'); return 0; }, start: () => assert.fail('start') };
  assert.equal(await windowsCommand(['hand', 'on'], options), 3);
  assert.equal(await windowsCommand(['register'], options), 0);
  assert.deepEqual(calls, [['hand', 'on'], 'register']);
});
test('thrown person gate fails closed before presence and confirmation', async () => {
  const f = fixture(); f.options.gate = () => { throw Error('gate unavailable'); };
  assert.match(await windowsSettingsRefusal(['turbo', 'on'], f.options), /nothing changed/); assert.deepEqual(f.calls, []);
});
test('unsupported browser and character modes never become enabled', async () => {
  for (const args of [['turbo', 'on', '--browser', 'helium'], ['cursor', 'style', 'sprite', 'cat'], ['cursor', 'style', 'glove'], ['cursor', 'import', 'folder'], ['turbo', 'app', 'on', 'com.example.App']]) {
    const f = fixture(); assert.ok(await f.run(args) > 0); assert.deepEqual(f.data, {});
  }
});
test('Windows hand status uses runtime capture overrides and reports the stream as suppressed by hand=0', async () => {
  const f = fixture({ 'hand.json': { version: 1, enabled: true, stream: true, capture: 'visible' } });
  f.options.env = { SLEIGHT_HAND_CAPTURE: 'hidden' };
  assert.equal(await f.run(['hand', 'status']), 0);
  assert.match(f.lines.join(''), /capture\s+hidden.*SLEIGHT_HAND_CAPTURE/);
  f.lines.length = 0; f.options.env = { SLEIGHT_HAND: '0', SLEIGHT_CURSOR_STYLE: 'seam' };
  assert.equal(await f.run(['cursor', 'status']), 0);
  assert.match(f.lines.join(''), /hand\s+off \(SLEIGHT_HAND=0\)/);
  assert.match(f.lines.join(''), /stream\s+off/);
  assert.match(f.lines.join(''), /style\s+seam \(SLEIGHT_CURSOR_STYLE\)/);
});
test('Windows permissions list includes existing app entries and the saved turbo preference', async () => {
  const f = fixture({ 'preapproved.json': { version: 1, apps: [{ app: 'com.example.App', riskLevel: 'low' }] },
    'turbo.json': { version: 1, enabled: true, browser: 'chrome' } });
  assert.equal(await f.run(['permissions', 'list']), 0);
  assert.match(f.lines.join(''), /com\.example\.App · always/); assert.match(f.lines.join(''), /chrome · turbo/);
  assert.match(f.lines.join(''), /not available yet/);
});
test('real Windows dispatcher rejects non-terminal mutation before resolving account paths on macOS', async () => {
  const errors = [];
  assert.equal(await windowsCommand(['turbo', 'on'], { error: text => errors.push(text) }), 3);
  assert.match(errors.join(''), /run it yourself in a terminal/);
});

for (const op of ['on', 'off']) test(`Windows hand ${op} replaces unsafe settings after its gate`, async () => {
  const f = fixture();
  f.options.store.read = () => { throw Error('WINDOWS_FILE_UNSAFE'); };
  f.options.store.write = (name, data, options) => {
    assert.equal(f.calls[0][0], 'gate'); assert.equal(name, 'hand.json');
    assert.deepEqual(data, { version: 1, enabled: op === 'on' });
    assert.equal(options.replaceUnsafe, true); f.calls.push('replace');
  };
  assert.equal(await f.run(['hand', op]), 0, f.lines.join(''));
  assert.ok(f.calls.includes('replace'));
});
for (const family of ['hand', 'cursor']) test(`Windows ${family} status names unsafe settings and their location`, async () => {
  const f = fixture(); f.options.store.read = () => { throw Error('WINDOWS_FILE_UNSAFE'); };
  f.options.adapter.paths = () => ({ settings: 'C:\\Users\\Person\\AppData\\Local\\sleight' });
  f.options.adapter.join = (...parts) => parts.join('\\');
  assert.equal(await f.run([family, 'status']), 0);
  assert.match(f.lines.join(''), /unsafe/); assert.match(f.lines.join(''), /hand\.json/);
});
test('permissions repair repairs ACLs before preserving valid contents', async () => {
  const f = fixture({ 'permissions.json': { version: 1, apps: [{ id: 'com.blocked.App' }], sites: [] } });
  let repaired = false; const read = f.options.store.read;
  f.options.store.read = name => { assert.equal(repaired, true); return read(name); };
  f.options.store.repair = name => { assert.equal(name, 'permissions.json'); assert.ok(f.calls.includes('confirm')); repaired = true; };
  assert.equal(await f.run(['permissions', 'repair']), 0, f.lines.join(''));
  assert.equal(repaired, true); assert.equal(f.data['permissions.json'].apps.length, 1);
});


test('Windows adds no stream commands beyond the Mac command surface', async () => {
  for (const args of [['stream', 'on'], ['stream', 'off'], ['stream', 'status'], ['cursor', 'stream', 'on'], ['cursor', 'stream', 'off'], ['cursor', 'stream', 'status']]) {
    const f = fixture(); assert.ok(await f.run(args) > 0); assert.deepEqual(f.data, {});
  }
});
test('cursor on refusal names the attempted command', async () => {
  const lines = [];
  assert.equal(await windowsCommand(['cursor', 'on'], { error: text => lines.push(text) }), 3);
  assert.match(lines.join(''), /cursor on changes/);
});
