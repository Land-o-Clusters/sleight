import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { allowPlan, hostsIn, isCandidate, judge, roundSites, skeleton, startRoundAllow, watchChromePrompts, CLAUDE_EXTENSION_ID } from '../bench/fowl/chrome-allow.mjs';
import { runRealGate } from '../bench/fowl/real-gate.mjs';

const temporary = t => registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-chrome-allow-')));
const EXT = `chrome-extension://${CLAUDE_EXTENSION_ID}/permission.html`;
const tasks = [
  { name: 'wikipedia', prompt: 'look up the height of Mount Kilimanjaro on Wikipedia in {browser}' },
  { name: 'form-travel', prompt: 'fill out the form at http://127.0.0.1:5413/travel in {browser}', grade: 'http://127.0.0.1:5413/grade/p01' },
  { name: 'shop', prompt: 'buy it', site: { log: 'http://127.0.0.1:5420/log' } },
];
const sites = roundSites(tasks);

// A synthetic AX tree in the shape the Swift helper prints.
const node = (role, fields = {}, children) => ({ role, ...fields, ...(children ? { children } : {}) });
const button = (label, fields = {}) => node('AXButton', { title: label, enabled: true, ...fields });
const text = value => node('AXStaticText', { value });
const prompt = ({ body = ['Claude wants to navigate to en.wikipedia.org'], buttons = [button('Deny'), button('Allow')], url = EXT, extra = [] } = {}) =>
  node('AXWindow', { title: 'Claude' }, [node('AXGroup', {}, [node('AXWebArea', { url }, [...body.map(text), ...extra, node('AXGroup', {}, buttons)])])]);
const window = { index: 0, title: 'Claude', subrole: 'AXStandardWindow', w: 420, h: 300, tabs: false, toolbar: false };
const press = (tree, w = window) => judge(w, tree, sites);

test('the round\'s sites come from the task file and the defaults', () => {
  assert.deepEqual(sites.hosts, ['developer.mozilla.org', 'en.wikipedia.org']);
  assert.deepEqual(sites.ports['127.0.0.1'], [5413, 5420]);
  assert.deepEqual(sites.ports.localhost, []);
  assert.deepEqual(roundSites([{ prompt: 'open https://docs.example.org/a' }], { defaults: [] }).hosts, ['docs.example.org']);
  assert.deepEqual(roundSites([{ prompt: 'open http://127.0.0.1/x' }], { defaults: [] }).ports['127.0.0.1'], [80]);
});

test('hosts are read from prompt text, a URL counting by its host alone', () => {
  assert.deepEqual(hostsIn('go to https://en.wikipedia.org/wiki/Mt._Everest and 127.0.0.1:5413, e.g. localhost'),
    [{ host: 'en.wikipedia.org', port: null }, { host: '127.0.0.1', port: 5413 }, { host: 'localhost', port: null }]);
  assert.deepEqual(hostsIn('Allow Claude to act'), []);
  assert.deepEqual(hostsIn('mira@example.net'), [{ host: 'example.net', port: null }]);
});

test('only a small window without a tab strip is worth reading', () => {
  assert.equal(isCandidate(window), true);
  assert.equal(isCandidate({ ...window, title: 'Some page', w: 1400, h: 900 }), false);
  assert.equal(isCandidate({ ...window, title: 'Some page', w: 500, h: 400 }), true, 'a small popup of any title is read, then declined');
  assert.equal(isCandidate({ ...window, title: 'Claude', w: 500, h: 400, tabs: true }), false, 'a window with a tab strip is a browser window');
  assert.equal(isCandidate({ ...window, title: 'Claude', w: 1400, h: 900 }), true);
});

test('Claude\'s prompt naming a round site is matched to its Allow button', () => {
  const verdict = press(prompt());
  assert.equal(verdict.action, 'press');
  assert.equal(verdict.label, 'Allow');
  assert.equal(verdict.site, 'en.wikipedia.org');
  assert.equal(verdict.basis, 'extension-url');
  assert.deepEqual(verdict.path, [0, 0, 1, 1], 'the path walks from the window to the button, past the Deny button');
  const local = press(prompt({ body: ['Claude wants to use http://127.0.0.1:5413/travel'], buttons: [button('Deny'), button('Allow once')] }));
  assert.equal(local.action, 'press'); assert.equal(local.label, 'Allow once'); assert.equal(local.site, '127.0.0.1:5413');
  assert.equal(press(prompt({ body: ['Claude wants to open a tab', 'on developer.mozilla.org'] })).site, 'developer.mozilla.org');
});

test('a scoped always-allow button is preferred, an unscoped or wide one is not', () => {
  const scoped = press(prompt({ buttons: [button('Deny'), button('Allow'), button('Allow always for this site')] }));
  assert.equal(scoped.label, 'Allow always for this site');
  const named = press(prompt({ buttons: [button('Deny'), button('Allow'), button('Always allow on en.wikipedia.org')] }));
  assert.equal(named.label, 'Always allow on en.wikipedia.org');
  for (const wide of ['Allow always on all sites', 'Always allow', 'Allow always for every site']) {
    assert.equal(press(prompt({ buttons: [button('Deny'), button('Allow'), button(wide)] })).label, 'Allow', wide);
  }
  assert.equal(press(prompt({ buttons: [button('Deny'), button('Allow always on all sites')] })).action, 'decline');
});

test('a button read through its description is pressed by that label', () => {
  const verdict = press(prompt({ buttons: [node('AXButton', { desc: 'Allow', enabled: true })] }));
  assert.equal(verdict.action, 'press'); assert.equal(verdict.label, 'Allow');
});

test('prompts that name another site, no site or an unknown port are declined', () => {
  assert.deepEqual([press(prompt({ body: ['Claude wants to navigate to evil.example'] })).reason, press(prompt({ body: ['Claude wants to navigate to evil.example'] })).sites], ['unlisted-site', ['evil.example']]);
  assert.equal(press(prompt({ body: ['Go to en.wikipedia.org and then evil.example'] })).reason, 'unlisted-site', 'one unlisted site in the text declines the prompt');
  assert.equal(press(prompt({ body: ['Claude wants to use http://127.0.0.1:9999/'] })).reason, 'unlisted-site');
  assert.equal(press(prompt({ body: ['Claude wants to use localhost'] })).reason, 'unlisted-site', 'localhost is not a task host');
  assert.equal(press(prompt({ body: ['wikipedia.org'] })).reason, 'unlisted-site', 'a parent domain is not the task host');
  assert.equal(press(prompt({ body: ['Claude wants to navigate somewhere'] })).reason, 'no-site-in-prompt');
  assert.equal(judge(window, prompt({ body: ['Claude wants to use 127.0.0.1'] }), roundSites([tasks[0]])).reason, 'unlisted-site', 'a round without local pages allows no local host');
});

test('wording or structure it cannot place is declined', () => {
  assert.equal(press(prompt({ buttons: [button('Deny'), button('Continue')] })).reason, 'no-unique-allow-button');
  assert.equal(press(prompt({ buttons: [button('Allow'), button('Allow')] })).reason, 'no-unique-allow-button');
  assert.equal(press(prompt({ buttons: [button('Allow', { enabled: false })] })).reason, 'no-button', 'a disabled button is not pressed');
  assert.equal(press(prompt({ buttons: [] })).reason, 'no-button');
  assert.equal(press(prompt({ extra: [node('AXTextField', { value: '' })] })).reason, 'prompt-has-input');
});

test('another extension, a web page or an unrecognised window is never Claude\'s prompt', () => {
  assert.equal(press(prompt({ url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html' })).reason, 'not-claude-extension');
  assert.equal(press(prompt({ url: 'https://en.wikipedia.org/wiki/Allow' })).reason, 'not-claude-extension');
  const noUrl = prompt({ url: '' });
  assert.equal(press(noUrl).basis, 'title', 'with no URL exposed a window titled Claude without a tab strip still matches');
  assert.equal(press(noUrl, { ...window, title: 'Sign in' }).reason, 'not-claude');
  assert.equal(press(noUrl, { ...window, tabs: true }).reason, 'not-claude');
  assert.equal(press(node('AXWindow', { title: 'Claude' }, [button('Allow')])).reason, 'no-site-in-prompt');
});

test('the skeleton keeps roles and button labels and drops text', () => {
  const rows = skeleton(prompt({ body: ['Secret page text about en.wikipedia.org'] }));
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('Secret') && !dump.includes('wikipedia'));
  assert.ok(rows.some(row => row.role === 'AXButton' && row.label === 'Allow'));
  assert.ok(rows.some(row => row.role === 'AXStaticText' && row.len > 0));
  assert.ok(rows.some(row => row.url === 'chrome-extension://' + CLAUDE_EXTENSION_ID));
  assert.ok(!dump.includes('permission.html'));
  assert.equal(skeleton(prompt(), 3).length, 3);
});

function fixture(t, { windows, trees, pressError } = {}) {
  const dir = temporary(t), file = join(dir, 'approvals.jsonl'), calls = { windows: 0, trees: [], presses: [] };
  let list = windows;
  const adapter = {
    windows: async pid => { calls.windows++; assert.equal(pid, 4242); return typeof list === 'function' ? list(calls.windows) : list; },
    tree: async (pid, w) => { calls.trees.push(w.index); return trees[w.index]; },
    press: async (pid, w, path, label) => { calls.presses.push({ pid, index: w.index, path, label }); if (pressError) throw Error(pressError); return { pressed: true }; },
  };
  const read = () => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { dir, file, calls, adapter, read, set: value => { list = value; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('the watcher presses a matched prompt once, logs site, button and time, and no page text', async t => {
  const f = fixture(t, { windows: [{ ...window, index: 0, title: 'Claude' }, { ...window, index: 1, title: 'Page', w: 1400, h: 900 }],
    trees: [prompt({ body: ['Claude wants to navigate to en.wikipedia.org', 'Private page text'] })] });
  let clock = 1000;
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1, cooldownMs: 500, now: () => clock });
  await settle(); clock += 100; await settle();
  await watcher.stop();
  assert.equal(f.calls.presses.length, 1, 'the cooldown stops a repeat press while the window closes');
  assert.deepEqual(f.calls.presses[0], { pid: 4242, index: 0, path: [0, 0, 2, 1], label: 'Allow' });
  assert.deepEqual([...new Set(f.calls.trees)], [0], 'a large page window is never read');
  const rows = f.read();
  const allow = rows.find(row => row.kind === 'allow');
  assert.equal(allow.site, 'en.wikipedia.org'); assert.equal(allow.button, 'Allow'); assert.equal(typeof allow.t, 'number');
  assert.ok(!JSON.stringify(rows).includes('Private page text'));
  assert.equal(rows[0].kind, 'started'); assert.equal(rows.at(-1).kind, 'stopped'); assert.equal(rows.at(-1).allowed, 1);
});

test('a decline is logged once with its skeleton and nothing is pressed', async t => {
  const f = fixture(t, { windows: [window], trees: [prompt({ body: ['Claude wants to navigate to evil.example'] })] });
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1 });
  await settle(); await watcher.stop();
  assert.deepEqual(f.calls.presses, []);
  const declines = f.read().filter(row => row.kind === 'decline');
  assert.equal(declines.length, 1, 'the same window is not logged on every poll');
  assert.equal(declines[0].reason, 'unlisted-site'); assert.deepEqual(declines[0].sites, ['evil.example']);
  assert.ok(declines[0].skeleton.some(row => row.label === 'Allow'));
  assert.ok(!JSON.stringify(declines[0]).includes('Claude wants'));
});

test('an unrecognised extension popup is logged with its skeleton for the first live run', async t => {
  const odd = node('AXWindow', { title: 'Claude' }, [node('AXWebArea', { url: EXT }, [text('Something new'), button('Proceed'), button('Not now')])]);
  const f = fixture(t, { windows: [window], trees: [odd] });
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1 });
  await settle(); await watcher.stop();
  assert.deepEqual(f.calls.presses, []);
  const row = f.read().find(entry => entry.kind === 'decline');
  assert.equal(row.reason, 'no-site-in-prompt');
  assert.deepEqual(row.skeleton.filter(entry => entry.role === 'AXButton').map(entry => entry.label), ['Proceed', 'Not now']);
});

test('windows and prompts that are not Claude\'s are never pressed', async t => {
  const foreign = prompt({ url: 'https://evil.example/', body: ['Go to en.wikipedia.org'] });
  const f = fixture(t, { windows: [{ ...window, title: 'Other app popup' }], trees: [foreign] });
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1 });
  await settle(); await watcher.stop();
  assert.deepEqual(f.calls.presses, []);
  assert.equal(f.read().find(entry => entry.kind === 'decline').reason, 'not-claude-extension');
});

test('a failed press is logged and retried at most three times', async t => {
  const f = fixture(t, { windows: [window], trees: [prompt()], pressError: 'stale' });
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1, cooldownMs: 0 });
  await settle(); await settle(); await watcher.stop();
  assert.equal(f.calls.presses.length, 3);
  assert.equal(f.read().filter(row => row.kind === 'error' && row.message === 'stale').length, 3);
});

test('helper errors are logged once per message and the watcher keeps going', async t => {
  let n = 0;
  const f = fixture(t, { windows: () => { if (++n < 4) throw Error('not-trusted'); return [window]; }, trees: [prompt()] });
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1, cooldownMs: 0 });
  await settle(); await watcher.stop();
  assert.equal(f.read().filter(row => row.kind === 'error' && row.message === 'not-trusted').length, 1);
  assert.equal(f.calls.presses.length >= 1, true);
});

test('stop ends the polling and later windows are not read or pressed', async t => {
  const f = fixture(t, { windows: [], trees: [prompt()] });
  const watcher = watchChromePrompts({ pid: 4242, sites, file: f.file, adapter: f.adapter, intervalMs: 1 });
  await settle(); await watcher.stop();
  const polls = f.calls.windows;
  f.set([window]);
  await settle();
  assert.equal(f.calls.windows, polls);
  assert.deepEqual(f.calls.presses, []);
  await watcher.stop();
  assert.equal(f.read().filter(row => row.kind === 'stopped').length, 1);
});

test('the watcher needs the round\'s own Chrome pid', t => {
  const f = fixture(t, { windows: [], trees: [] });
  for (const pid of [undefined, 0, 1, -5, 1.5, '42']) assert.throws(() => watchChromePrompts({ pid, sites, file: f.file, adapter: f.adapter }), /pid/);
});

function round(surface, browser = 'chrome') {
  return { plan: { surface, out: '', arms: tasks.map(task => ({ task })) }, browser: { browser, pid: 4242 } };
}

test('only a Claude in Chrome round in Chrome starts a watcher', async t => {
  const f = fixture(t, { windows: [], trees: [] });
  for (const [surface, browser] of [['codex', 'chrome'], ['sleight-turbo', 'chrome'], ['fowlbrowser', 'chrome'], ['claude-in-chrome', 'helium'], ['claude-in-chrome', 'safari']]) {
    const { plan, browser: launched } = round(surface, browser);
    let compiled = 0;
    const started = await startRoundAllow({ ...plan, out: f.dir }, launched, { adapter: f.adapter, compile: async () => { compiled++; } });
    assert.equal(started, null, `${surface} in ${browser}`);
    assert.equal(compiled, 0);
  }
  assert.equal(existsSync(f.file), false, 'no approvals.jsonl for other surfaces');
  assert.deepEqual(allowPlan({ surface: 'sleight-turbo', out: '/x', arms: [] }), { enabled: false });
  const planned = allowPlan({ surface: 'claude-in-chrome', out: '/x', arms: tasks.map(task => ({ task })) });
  assert.equal(planned.enabled, true); assert.equal(planned.file, '/x/approvals.jsonl'); assert.deepEqual(planned.sites.ports['127.0.0.1'], [5413, 5420]);
});

test('a Claude in Chrome round starts the watcher on the launched Chrome and teardown stops it', async t => {
  const f = fixture(t, { windows: [window], trees: [prompt()] });
  const { plan, browser } = round('claude-in-chrome');
  const started = await startRoundAllow({ ...plan, out: f.dir }, browser, { adapter: f.adapter, intervalMs: 1, cooldownMs: 0 });
  await settle();
  assert.ok(f.calls.presses.length >= 1);
  await started.stop();
  const presses = f.calls.presses.length, polls = f.calls.windows;
  await settle();
  assert.equal(f.calls.presses.length, presses); assert.equal(f.calls.windows, polls);
  assert.equal(f.read().at(-1).kind, 'stopped');
});

test('a helper that will not compile is logged and the round goes on without it', async t => {
  const dir = temporary(t);
  const { plan, browser } = round('claude-in-chrome');
  const errors = console.error; console.error = () => {};
  try {
    assert.equal(await startRoundAllow({ ...plan, out: dir }, browser, { compile: async () => { throw Error('swiftc missing'); } }), null);
  } finally { console.error = errors; }
  assert.match(readFileSync(join(dir, 'approvals.jsonl'), 'utf8'), /helper unavailable: swiftc missing/);
});

for (const surface of ['codex', 'injected-watcher']) test(`the gate ${surface === 'codex' ? 'starts nothing for a codex round' : 'stops an injected watcher at teardown, after the last task and before the browser closes'}`, async t => {
  const dir = temporary(t), events = [], lockPath = join(dir, 'lock');
  const marker = { 'chrome:marker': { title: 'marker', url: 'data:text/html,marker' } };
  const gateTask = { name: 'fixture', browser: 'chrome', prompt: 'Fixture in {browser}', result: 'done' };
  // A Claude in Chrome plan needs a copied profile that only a live round makes, so the second case runs the gate's hook with
  // an injected watcher; the real hook's surface check is covered by the tests above.
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'chrome', out: join(dir, 'out') }, tasks: [gateTask],
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {}, checkOwner: async () => ({ ok: true }),
      startSites: async () => ({ close: async () => { events.push('sites closed'); } }),
      launchBrowser: async plan => ({ ...plan, pid: 1234, ownerCheck: { ok: true, otherPids: [] }, stop: async () => { events.push('browser closed'); return { browserClosed: true, profileDeleted: true }; } }),
      startMonitor: async () => ({ log: [{ kind: 'host-ready', t: 0, app: true, space: true, window: true }, { kind: 'host-stopped', t: 3, exitCode: 0 }], stop: async () => {} }),
      ...(surface === 'codex' ? {} : { startAllow: async (plan, browser) => { events.push(`watch ${plan.surface} ${browser.pid}`); return { stop: async () => { events.push('watch stopped'); } }; } }),
      resetBrowser: async () => marker, observeBrowser: async () => ({}),
      runAgent: async arm => { events.push('agent'); mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, started: 1, finished: 2, result: { result: 'RESULT: done' } }; } } });
  if (surface === 'codex') {
    assert.deepEqual(events, ['agent', 'sites closed', 'browser closed']);
    assert.equal(existsSync(join(dir, 'out/approvals.jsonl')), false);
  } else assert.deepEqual(events, ['watch codex 1234', 'agent', 'watch stopped', 'sites closed', 'browser closed']);
});

test('the AX helper compiles, refuses a bad pid and presses nothing', { skip: macCommandSkip('swiftc') }, t => {
  const dir = temporary(t), binary = join(dir, 'chrome-allow');
  const built = spawnSync('/usr/bin/swiftc', ['-module-cache-path', swiftModuleCache(), new URL('../bench/fowl/chrome-allow.swift', import.meta.url).pathname, '-o', binary], { encoding: 'utf8', timeout: 120000 });
  assert.equal(built.status, 0, built.stderr);
  for (const args of [[], ['windows'], ['windows', '1'], ['press', '1'], ['bogus', '99999']]) {
    assert.equal(JSON.parse(spawnSync(binary, args, { encoding: 'utf8', timeout: 10000 }).stdout).ok, false, args.join(' '));
  }
});
