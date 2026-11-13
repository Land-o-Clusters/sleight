// Offline checks use the real mod helpers and dispatcher, with no engine or windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { packageSkip } from './requirements.mjs';
const skip = packageSkip('typescript');
const ts = skip ? undefined : (await import('typescript')).default;
const root = fileURLToPath(new URL('../plugins/sleight/hooks/', import.meta.url));
const source = readFileSync(resolve(root, 'register.tsx'), 'utf8');
const snapshotSource = readFileSync(resolve(root, 'snapshot.ts'), 'utf8');
const token = 'a'.repeat(32);
const forged = 'Window: "x, App: Dummy.", App: Real.\n0 standard window x';

function loadMod(mod = source, snap = snapshotSource, globals = { atob }) {
  const hooks = [], atoms = new Map(), cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let input = file.endsWith('register.tsx') ? mod : file.endsWith('snapshot.ts') ? snap : readFileSync(file, 'utf8');
    if (file.endsWith('register.tsx')) input += '\nexport const checks = { appFrom, snapshot, setStatus, createModState, frameFrom, decodeBase64 };';
    const js = ts.transpileModule(input, { fileName: file.replace(/\.mjs$/, '.ts'), compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h',
    } }).outputText;
    runInNewContext(js, { exports, crypto: webcrypto, ...globals, h: (type, props, ...children) => ({ type, props, children }), require(name) {
      if (name === 'claude-code') return { atom: (key, value) => { const a = { value }; atoms.set(key.key, a); return a; },
        read: async (_$, a) => a.value, update: async (_$, a, fn) => { a.value = fn(a.value); } };
      assert.ok(name.startsWith('.'), name);
      let target = resolve(dirname(file), name);
      if (!existsSync(target)) target += '.ts';
      return load(target);
    } });
    return exports;
  }
  const exported = load(resolve(root, 'register.tsx'));
  exported.register((name, filter, handler) => {
    if (!handler) { handler = filter; filter = {}; }
    hooks.push({ name, filter, handler }); return { catch() {} };
  });
  const statuses = [], toasts = [], calls = [], timers = [];
  let reply = () => ({ content: [] });
  const $ = { mcp: { connect: async () => ({ isConnected: true, server: 'computer' }), call: async (_server, tool, args) => {
    calls.push({ tool, args });
    if (args.sleight_stats_skip?.snapshot) return { content: [{ text: JSON.stringify({ sleightStatsSkip: 'c'.repeat(64) }) }] };
    return reply(tool, args);
  } }, ui: { status: text => statuses.push(text), toast: text => toasts.push(text), log() {}, open() {},
    resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Raster', 'Svg'].map(x => [x, x])) },
    clock: { after(_ms, fn) { timers.push(fn); } }, prompt: { submit: async () => {} }, fs: { read: async () => JSON.stringify({ sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'await app.click(1)' } }] }) } };
  async function emit(name, e, next = async e => e) {
    const hook = hooks.find(h => h.name === name && Object.entries(h.filter).every(([k, v]) => e[k] === v));
    assert.ok(hook, name); return hook.handler($, e, next);
  }
  return { ...exported.checks, timers, snapshotCode: load(resolve(root, 'snapshot.ts')).snapshotCode, atoms, $, statuses, toasts, calls,
    setReply(fn) { reply = fn; }, emit,
    render: () => emit('ui.render', { component: 'Pane', requestId: 'sleight', surface: 'desktop', props: { bodyColumns: 60 } }),
  };
}
function frame(extra = {}) { return { app: 'Real', width: 20, height: 10, columns: 2, rows: 1,
  image: { mime: 'image/png', base64: 'YWJj' }, ...extra }; }
function marker(args) { return String(args.code).match(/FRAME_TOKEN = "([a-f0-9]{32})"/)?.[1] ?? ''; }
async function shot(h, lines) {
  h.setReply((_tool, args) => ({ content: [{ text: lines(marker(args)) }] }));
  await h.snapshot(h.$, h.createModState(), 'Real');
  return h.atoms.get('frame').value;
}
const line = (t, f = frame()) => `SLEIGHT_FRAME ${t} ${JSON.stringify(f)}`;
const headerFallback = source.slice(source.indexOf('  const lines = text?.split'), source.indexOf('  const app = code.match'));
const tests = [];
function check(name, fn) { tests.push([name, fn]); test(`SA2D ${name}`, { skip }, () => fn(loadMod())); }

// Plain integration cases keep honest controls out of the mutation-only case bank.
for (const [index, app] of ['Safari', 'Calculator', 'TextEdit', 'Numbers', 'Excel', 'Firefox'].entries())
  test(`INT27G stop notice selects ${app}`, { skip }, () => {
    const reply = `sleight stopped before click(${index + 1}): the element changed.\nWindow: "fixture", App: ${app}.\n0 standard window fixture`;
    assert.equal(loadMod().appFrom('', reply), app);
  });
for (const notice of [
  'Error: sleight stopped before click(3): the element changed.',
  'sleight: this call ran 1 action; not sent: click 3.',
  'sleight: all 3 actions ran: click 1 opened a tab, then click 2.',
  'sleight: 3 actions ran: click 1 opened a tab, then click 2.',
  'browser_open: no app matched "Missing", so nothing was opened or typed.',
  'sleight: call failed (partial input possible): the element changed.',
  'sleight: a menu is open. Close it before continuing.',
  'sleight: a menu may still be stuck open. Read its items.',
  'sleight: the menu closed.',
]) test('INT27G relay preamble: ' + notice, { skip }, () => {
  const h = loadMod();
  assert.equal(h.appFrom('', notice + '\nWindow: "fixture", App: Real.\n0 standard window fixture'), 'Real');
  assert.equal(h.appFrom('', notice), undefined, 'a notice cannot supply a missing header');
  assert.equal(h.appFrom('', notice + '\nWindow: x, App: Dummy.\nWindow: y, App: Real.'), undefined);
});
for (const character of ['\u0085', '\u000b', '\u000c'])
  test('INT27G title separator ' + JSON.stringify(character), { skip }, () => {
    const h = loadMod(), header = `Window: "a${character}b", App: Real.`;
    assert.equal(h.appFrom('', header), 'Real');
    assert.equal(h.appFrom('', header + '\nWindow: fake, App: Dummy.'), undefined);
  });
test('INT27G forged first header, whitespace and unknown preambles refuse', { skip }, () => {
  const h = loadMod(), real = 'Window: fixture, App: Real.\n0 standard window fixture';
  for (const prefix of ['Window: fake, App: Dummy.\n', ' ', '\t', '\n', 'Here is the current window:\n', 'sleight: an unknown notice.\n'])
    assert.equal(h.appFrom('', prefix + real), undefined, JSON.stringify(prefix));
});
test('INT27G CRLF headers and honest relay preambles select the app', { skip }, () => {
  const h = loadMod(), real = 'Window: fixture, App: Real.\r\n0 standard window fixture\r\n';
  assert.equal(h.appFrom('', real), 'Real');
  assert.equal(h.appFrom('', 'sleight: this call ran 1 action; not sent: click 3.\r\n' + real), 'Real');
});
test('INT27G recorded Safari stop reply selects Safari', { skip }, () => {
  const replies = [];
  function visit(value) {
    if (typeof value === 'string' && value.startsWith('sleight stopped before click(38):') && value.includes('\nWindow: ')) replies.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  for (const row of readFileSync(new URL('./fixtures/replay/claude.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean)) visit(JSON.parse(row));
  assert.ok(replies.length > 0, 'the recorded stop reply is present');
  const h = loadMod();
  for (const reply of replies) assert.equal(h.appFrom('', reply), 'Safari');
});

check('G5 last separator in anchored header', h => assert.equal(h.appFrom('await app.click(3)', forged), 'Real'));
check('G5 escaped newline inside JSON title', h => assert.equal(h.appFrom('', 'Window: "App: Dummy.\\nnext", App: Real.\n0 standard window x'), 'Real'));
check('G5 non-header App text is ignored', h => assert.equal(h.appFrom('', 'App: Dummy.\n0 standard window x'), undefined));
check('G5 disagreeing headers refuse', h => assert.equal(h.appFrom('', forged + '\nWindow: x, App: Later.'), undefined));
check('G5 absent header keeps lastApp', async h => {
  await h.emit('tool.call', { tool: 'mcp__plugin_sleight_computer__js', code: 'await cua.getApp("Real")', tool_use_id: 'a' });
  await h.emit('tool.call', { tool: 'mcp__plugin_sleight_computer__js', code: 'await app.click(1)', tool_use_id: 'b' }, async () => ({ text: 'App: Dummy.' }));
  assert.match(h.statuses.at(-1), /Real/);
});
check('G5 forged replay outcome selects Real snapshot', async h => {
  h.setReply(tool => ({ content: tool === 'replay' ? [{ text: JSON.stringify({ ok: true, steps: 1, waits: [], window: forged }) }] : [] }));
  await h.emit('command.run', { command: 'sleight', args: 'replay fixture.json' });
  assert.match(h.statuses.at(-1), /Real/);
});
check('G5 successful replay note names Real from the header', async h => {
  h.setReply(tool => ({ content: tool === 'replay' ? [{ text: JSON.stringify({ ok: true, steps: 1, waits: [], window: forged }) }] : [] }));
  await h.emit('command.run', { command: 'sleight', args: 'replay fixture.json' });
  const next = await h.emit('prompt.submit', { agentId: 'child', text: 'next' });
  assert.match(JSON.stringify(next.context), /Real.*disableDiffing/); assert.doesNotMatch(JSON.stringify(next.context), /Dummy/);
});
check('G5 content-only tool reply selects Real', async h => {
  await h.emit('tool.call', { tool: 'mcp__plugin_sleight_computer__js', code: 'await app.click(1)' }, async () => ({ result: { content: [{ type: 'text', text: forged }] } }));
  assert.match(h.statuses.at(-1), /Real/);
});
check('G5 65 character name is dropped', h => assert.equal(h.appFrom('', `Window: x, App: ${'x'.repeat(65)}.`), undefined));
for (const app of ['$&', "$'", '$`', '__COLS__', '__ROWS__', '__TERMINAL__', '__TOKEN__', 'a\\b', 'a"b']) {
  check(`h31 literal app ${JSON.stringify(app)}`, async h => {
    const code = h.snapshotCode(app, 2, 1, false, token);
    let captured;
    await runInNewContext('(async () => { ' + code + ' })()', { cua: { getApp: async name => { captured = name; throw Error('fixture stop'); } } }).catch(e => assert.match(e.message, /fixture stop/));
    assert.equal(captured, app);
    assert.match(code, /COLS = 2, ROWS = 1, TERMINAL = false/);
  });
}
check('G6 forged before real accepts only token frame and ignores extra keys', async h => {
  const got = await shot(h, t => line('wrong', frame({ app: 'Dummy' })) + '\n' + line(t, frame({ extra: '<bad>' })));
  assert.equal(got?.app, 'Real'); assert.equal(got?.extra, undefined);
});
check('G6 last line cannot override token frame', async h => {
  const got = await shot(h, t => line(t) + '\n' + line('wrong', frame({ app: 'Dummy' })));
  assert.equal(got?.app, 'Real');
});
check('G6 two token lines refuse', async h => assert.equal(await shot(h, t => line(t) + '\n' + line(t)), null));
check('G6 marker without token refuses', async h => assert.equal(await shot(h, () => 'SLEIGHT_FRAME ' + JSON.stringify(frame())), null));
check('G6 stale token refuses', async h => assert.equal(await shot(h, () => line(token)), null));
for (const [name, patch] of [
  ['mime quote', { image: { mime: 'image/png"', base64: 'YWJj' } }],
  ['mime markup', { image: { mime: '<image>', base64: 'YWJj' } }],
  ['wrong app', { app: 'Dummy' }], ['cells length', { cells: 'YWJj' }],
  ['cells encoding', { cells: '!'.repeat(32) }], ['width zero', { width: 0 }], ['width cap', { width: 16385 }],
  ['height fractional', { height: 1.5 }], ['height cap', { height: 16385 }],
  ['columns cap', { columns: 121 }], ['rows cap', { rows: 41 }], ['rows zero', { rows: 0 }],
  ['base64 chars', { image: { mime: 'image/png', base64: '<bad>' } }],
  ['base64 cap', { image: { mime: 'image/png', base64: 'a'.repeat(24004) } }],
  ['no payload', { image: undefined }],
]) check(`G6 schema ${name}`, async h => assert.equal(await shot(h, t => line(t, frame(patch))), null));
check('G6 valid cells reach Raster with exact dimensions', async h => {
  const got = await shot(h, t => line(t, frame({ image: undefined, cells: Buffer.alloc(24).toString('base64') })));
  assert.equal(got?.columns, 2); assert.equal(got?.rows, 1); assert.equal(got?.cells, Buffer.alloc(24).toString('base64'));
});
check('G6 each snapshot gets a fresh private 32 hex token', async h => {
  const tokens = [];
  for (let i = 0; i < 2; i++) await shot(h, t => { tokens.push(t); return line(t); });
  assert.match(tokens[0], /^[a-f0-9]{32}$/); assert.notEqual(tokens[0], tokens[1]);
  assert.ok(!JSON.stringify([...h.atoms.values()].map(a => a.value)).includes(tokens[0]));
});
function texts(tree) {
  if (Array.isArray(tree)) return tree.flatMap(texts);
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.type === 'Text' ? tree.children.flat(Infinity).filter(x => typeof x === 'string') : []), ...texts(tree.children)];
}
const attacks = ['\x1b[2J', '\x1b]52;c;YWJj\x07', '\x1b]52;c;YWJj\x1b\\', '\u202e', '\r', '\u0085', '\ue000', '\u0378', '\u2028', '\u2029'];
for (const attack of attacks) check(`G7 pane title ${JSON.stringify(attack)}`, async h => {
  h.atoms.get('log').value = [{ id: 'x', title: attack, status: 'done', at: '12:00:00', app: 'Real' }];
  const output = texts(await h.render()).join('');
  assert.doesNotMatch(output, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u);
  assert.ok(output.includes('12:00:00'), 'control-only title retains log entry');
});
check('G7 every pane text field and status uses plain text caps', async h => {
  const dirty = '\x1b\u0085\u202e\r';
  h.atoms.get('log').value = [{ id: 'x', title: dirty + 'T'.repeat(100), app: dirty + 'A'.repeat(80), at: '12:00:00', status: 'done' }];
  h.atoms.get('receipt').value = { path: '/x' + dirty, review: 'one\ntwo' + dirty + 'R'.repeat(33000) };
  h.atoms.get('view').value = { kind: 'error', message: dirty + 'error' };
  const output = texts(await h.render()).join('');
  assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u);
  assert.ok(output.includes('one\ntwo')); assert.ok(!output.includes('T'.repeat(81))); assert.ok(!output.includes('A'.repeat(65)));
  assert.ok(!output.includes('R'.repeat(32101)));
  h.setStatus(h.$, { lastApp: dirty + 'A'.repeat(80), actions: 1 });
  assert.doesNotMatch(h.statuses.at(-1), /[\p{Cc}\p{Cf}]/u); assert.ok(!h.statuses.at(-1).includes('A'.repeat(65)));
});
check('G7 review cap counts UTF-8 bytes and keeps LF only', async h => {
  h.atoms.get('receipt').value = { review: 'one\ntwo\t' + '界'.repeat(20000) };
  const output = texts(await h.render()).find(text => text.startsWith('one'));
  assert.ok(output.includes('one\ntwo'));
  assert.ok(!output.includes('\t'));
  assert.ok(Buffer.byteLength(output) <= 32768);
});
check('G7 relay warning toast strips controls and caps 400', async h => {
  h.setReply(() => ({ content: [{ text: 'sleight-warning: \x1b\u0085\u202e' + 'W'.repeat(500) }] }));
  await h.emit('command.run', { command: 'sleight', args: 'stop' });
  assert.equal(h.toasts[0], 'W'.repeat(400));
});
check('G7 stop receipt toast strips controls', async h => {
  h.setReply(() => ({ content: [{ text: 'sleight stop: \x1b\u0085\u202e' + 'W'.repeat(500) }] }));
  const tree = await h.render();
  function buttons(n) { return Array.isArray(n) ? n.flatMap(buttons) : n && typeof n === 'object' ? [...(n.type === 'Button' ? [n] : []), ...buttons(n.children)] : []; }
  buttons(tree).find(n => n.props.key === 'stop').props.onPress();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(h.toasts.length); assert.doesNotMatch(h.toasts[0], /[\p{Cc}\p{Cf}]/u); assert.ok(h.toasts[0].length <= 400);
});

// Each deliberately broken implementation is checked against the same behavior above.
if (source.includes('function plainText')) test('SA2D broken variants are rejected', { skip }, async t => {
  const variants = [
    ['G5 first delimiter', headerFallback, "  const header = text?.match(/^Window: .*?App: ([^.]+)\\./m)?.[1]\n", 'G5 last separator'],
    ['G6 token without schema', 'const shot = frameFrom(text, frameToken, app)', "const shot = JSON.parse(text.split('\\n').find(l => l.startsWith(FRAME_MARKER + frameToken + ' ')).slice((FRAME_MARKER + frameToken + ' ').length))", 'G6 schema mime quote'],
    ['G6 last marker line', "const lines = text.split('\\n').filter(line => line.startsWith(prefix))", "const lines = text.split('\\n').filter(line => line.startsWith(FRAME_MARKER)).slice(-1)", 'G6 last line'],
    ['G7 keep C1', "[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cn}]", "[\\x00-\\x1f\\x7f\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cn}]", 'G7 pane title ' + JSON.stringify('\u0085')],
    ['G7 raw warnings', "plainText(text.slice('sleight-warning: '.length), 400)", "text.slice('sleight-warning: '.length)", 'G7 relay warning'],
  ];
  for (const [name, from, to, starts] of variants) {
    const mod = source.replace(from, to); assert.notEqual(mod, source, name);
    const fn = tests.find(([n]) => n.startsWith(starts))?.[1]; assert.ok(fn, starts);
    await assert.rejects(async () => fn(loadMod(mod)), undefined, name); t.diagnostic(`${name}: caught`);
  }
  const broken = snapshotSource.slice(0, snapshotSource.indexOf('export function snapshotCode')) + `export function snapshotCode(app, columns, rows, terminal, token) { return SNAPSHOT_JS.replace('__APP__', () => JSON.stringify(app)).replace('__COLS__', String(columns)).replace('__ROWS__', String(rows)).replace('__TERMINAL__', String(terminal)).replace('__TOKEN__', JSON.stringify(token)); }`;
  await assert.rejects(async () => tests.find(([n]) => n === 'h31 literal app "__COLS__"')[1](loadMod(source, broken)));
  t.diagnostic('h31 APP-only function replacer: caught');
  let caught = 0;
  for (const [name, fn] of tests) {
    let mod = source, snap = snapshotSource;
    if (name.startsWith('G5')) {
      mod = mod.replace(headerFallback, "  const header = text?.match(/App: ([^.\\n]+)\\./)?.[1]\n");
      if (name.includes('65 character')) mod = mod.replace('app.length <= 64', 'true');
    } else if (name.startsWith('h31')) {
      const app = JSON.parse(name.slice('h31 literal app '.length));
      snap = app.includes('\\') || app.includes('"')
        ? snapshotSource.replace('JSON.stringify(app)', `'"' + app + '"'`) : app.includes('$') ? broken.replace('() => JSON.stringify(app)', 'JSON.stringify(app)') : broken;
    } else if (name.startsWith('G6 schema') || name.includes('forged before')) {
      mod = mod.replace('const shot = frameFrom(text, frameToken, app)', "const shot = JSON.parse(text.split('\\n').find(l => l.startsWith(FRAME_MARKER + frameToken + ' ')).slice((FRAME_MARKER + frameToken + ' ').length))");
    } else if (name.includes('last line')) {
      mod = mod.replace('const shot = frameFrom(text, frameToken, app)', "const shot = JSON.parse(text.split('\\n').filter(l => l.startsWith(FRAME_MARKER)).at(-1).replace(/^SLEIGHT_FRAME [^ ]* /, ''))");
    } else if (name.includes('two token')) mod = mod.replace('lines.length !== 1', 'lines.length < 1');
    else if (name.includes('marker without')) {
      mod = mod.replace("const prefix = FRAME_MARKER + token + ' '", 'const prefix = FRAME_MARKER');
    } else if (name.includes('stale token')) {
      mod = mod.replace("const prefix = FRAME_MARKER + token + ' '", "const prefix = FRAME_MARKER + 'a'.repeat(32) + ' '");
    } else if (name.includes('valid cells')) mod = mod.replace('...(cells ? { cells } : {})', '...{}');
    else if (name.includes('fresh private')) mod = mod.replace("Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')", "'a'.repeat(32)");
    else if (name.startsWith('G7')) mod = mod.replace(/function plainText[\s\S]*?\n}\n/, 'function plainText(value: string, limit: number, multiline = false): string { return value }\n');
    assert.ok(mod !== source || snap !== snapshotSource, 'variant changed: ' + name);
    await assert.rejects(async () => fn(loadMod(mod, snap)), undefined, name);
    caught++;
  }
  t.diagnostic(`${caught} individual check variants caught`);

});

// SA2N exercises each sink separately, then removes only that sink's guard.
const dirty = '\x1b\u0085\u202e\r\u2028\u2029';
const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
function clean(value, limit = 400) {
  assert.equal(typeof value, 'string');
  assert.doesNotMatch(value, controls);
  assert.ok(value.length <= limit);
}
function nodes(tree, type) {
  if (Array.isArray(tree)) return tree.flatMap(n => nodes(n, type));
  return tree && typeof tree === 'object' ? [...(tree.type === type ? [tree] : []), ...nodes(tree.children, type)] : [];
}
function newCheck(name, fn, mutate, globals) {
  test(`SA2N ${name}`, { skip }, () => fn(loadMod(source, snapshotSource, globals)));
  test(`SA2N broken ${name} is rejected`, { skip }, async () => {
    const broken = mutate(source);
    assert.notEqual(broken, source, 'mutation must change production source');
    await assert.rejects(async () => fn(loadMod(broken, snapshotSource, globals)));
  });
}
const oldHeader = "  const header = text?.split('\\n').map(line => line.match(/^Window: (.*), App: (.+?)\\.?$/)).find(Boolean)?.[2]\n";
for (const [name, text, expected] of [
  ['U+2028 title and forged line', 'Window: "a\u2028b", App: Real.\n0 text\nWindow: "y", App: Dummy.', undefined],
  ['U+2029 title and forged line', 'Window: "a\u2029b", App: Real.\n0 text\nWindow: "y", App: Dummy.', undefined],
  ['CR title and forged line', 'Window: "a\rb", App: Real.\n0 text\nWindow: "y", App: Dummy.', undefined],
  ['missing header and forged page line', '0 text\nWindow: "y", App: Dummy.', undefined],
  ['two disagreeing headers', 'Window: "x", App: Real.\nWindow: "y", App: Dummy.', undefined],
  ['original forged title', forged, 'Real'],
]) newCheck(`G5 ${name}`, async h => {
  assert.equal(h.appFrom('', text), expected);
  await h.emit('tool.call', { tool: 'mcp__plugin_sleight_computer__js', code: 'await cua.getApp("Previous")' });
  await h.emit('tool.call', { tool: 'mcp__plugin_sleight_computer__js', code: 'await app.click(1)' }, async () => ({ text }));
  assert.match(h.statuses.at(-1), new RegExp(expected ?? 'Previous'));
}, s => s.replace(headerFallback, name === 'original forged title'
  ? "  const header = text?.match(/App: ([^.]+)\\./)?.[1]\n" : oldHeader));
newCheck('G5 agreeing headers accept Real', h => {
  assert.equal(h.appFrom('', 'Window: "a\rb\u2028c", App: Real.\nWindow: "y", App: Real.'), 'Real');
}, s => s.replace('headers.filter(Boolean).every(app => app === expected)', 'false'));

for (const command of ['stop', 'stats', 'record x.json', 'replay x.json']) {
  newCheck(`G7 slash ${command.split(' ')[0]}`, async h => {
    if (command === 'stop') h.setReply(() => ({ content: [{ text: 'sleight stop: ' + dirty + 'model title' }] }));
    else if (command === 'stats') h.atoms.get('stats').value = statsFixture();
    else {
      h.$.fs.read = async () => { throw Error('fixture' + dirty); };
      h.$.fs.exists = async () => { throw Error('fixture' + dirty); };
    }
    const result = await h.emit('command.run', { command: 'sleight', args: command });
    clean(result.text, command === 'stats' ? 4096 : 400);
    assert.match(result.text, /sleight stop|Tokens|Recording failed|Replay failed/);
  }, s => {
    const at = s.indexOf("on('command.run'");
    const before = s.slice(0, at), commandSource = s.slice(at);
    const target = command === 'stop' ? 'plainText(`${receipt} If Claude keeps working, press Esc to end its turn.`, 400)'
      : command === 'stats' ? 'plainText(turnStatsText(await read($, stats)), 4096)' : 'plainText(result.text, 400)';
    let from = commandSource;
    if (command.startsWith('replay')) {
      const index = from.indexOf("if (args === 'replay'");
      return before + from.slice(0, index) + from.slice(index).replace(target, 'result.text');
    }
    return before + from.replace(target, command === 'stop' ? '`${receipt} If Claude keeps working, press Esc to end its turn.`'
      : command === 'stats' ? 'turnStatsText(await read($, stats))' : 'result.text');
  });
}
function statsFixture() {
  return { durationMs: 1, costUsd: null, costDeltaUsd: null, stats: null,
    tokens: { input_tokens: dirty + '123', output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null } };
}
for (const key of ['replay', 'record']) newCheck(`G7 ${key} button toast`, async h => {
  h.atoms.get('replayFile').value = 'x.json';
  h.$.fs.read = async () => { throw Error('fixture' + dirty); };
  h.$.fs.exists = async () => { throw Error('fixture' + dirty); };
  const button = nodes(await h.render(), 'Button').find(n => n.props.key === key);
  await button.props.onPress();
  assert.equal(h.toasts.length, 1); clean(h.toasts[0]); assert.match(h.toasts[0], /failed/);
}, s => {
  const at = s.indexOf(`<Button key="${key}"`);
  return s.slice(0, at) + s.slice(at).replace('plainText(result.text, 400)', 'result.text');
});
for (const handoff of [false, true]) newCheck(`G7 ${handoff ? 'replay handoff' : 'prompt-send failure'} toast`, async h => {
  h.$.prompt.submit = async () => { throw Error('fixture' + dirty); };
  if (handoff) h.setReply(tool => ({ content: tool === 'replay'
    ? [{ text: JSON.stringify({ ok: false, step: 1, error: 'REFUSED: fixture', waits: [] }) }] : [] }));
  await h.emit('command.run', { command: 'sleight', args: handoff ? 'replay x.json' : 'do this' });
  assert.equal(h.timers.length, 1); await h.timers[0]();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(h.toasts.length, 1); clean(h.toasts[0]); assert.match(h.toasts[0], /fixture/);
}, s => handoff
  ? s.replace('plainText(`sleight: couldn\'t hand the stop to Claude (${err.message}). Send the stop details from the log.`, 400)', '`sleight: couldn\'t hand the stop to Claude (${err.message}). Send the stop details from the log.`')
  : s.replace('plainText(`sleight: couldn\'t send your prompt (${(err as Error).message}). Send it on its own line.`, 400)', '`sleight: couldn\'t send your prompt (${(err as Error).message}). Send it on its own line.`'));
newCheck('G7 pane stats line', async h => {
  h.atoms.get('stats').value = statsFixture();
  const output = texts(await h.render()).find(x => x.includes('Tokens'));
  clean(output, 4096); assert.match(output, /input 123/);
}, s => s.replace('plainText(turnStatsText(latestStats), 4096)', 'turnStatsText(latestStats)'));
for (const svg of [true, false]) newCheck(`G7 picture ${svg ? 'Svg alt' : 'fallback text'}`, async h => {
  h.atoms.get('frame').value = { ...frame(), app: 'Real' + dirty };
  if (!svg) h.$.ui.resolve = () => ({ Box: 'Box', Text: 'Text', Button: 'Button' });
  const tree = await h.render();
  const output = svg ? nodes(tree, 'Svg')[0]?.props.alt : texts(tree).find(x => x.includes('picture not shown'));
  clean(output); assert.match(output, /Real/);
}, s => svg ? s.replace('alt={`Screenshot of ${plainText(shot.app, 64)}`}', 'alt={`Screenshot of ${shot.app}`}')
  : s.replace('plainText(`${plainText(shot.app, 64)}: picture not shown on this surface. Press Refresh.`, 400)', '`${shot.app}: picture not shown on this surface. Press Refresh.`'));

for (const native of [true, false]) newCheck(`G6 cells decode ${native ? 'native atob' : 'local fallback'}`, async h => {
  const bytes = Buffer.from(Array.from({ length: 24 }, (_, i) => i * 11));
  for (const length of [1, 2, 3, 23, 24]) {
    const input = bytes.subarray(0, length);
    assert.equal(h.decodeBase64(input.toString('base64')), input.toString('latin1'));
  }
  const got = await shot(h, t => line(t, frame({ image: undefined, cells: bytes.toString('base64') })));
  assert.equal(got?.cells, bytes.toString('base64'));
  h.atoms.get('frame').value = null;
  const wrong = await shot(h, t => line(t, frame({ image: undefined, cells: Buffer.alloc(23).toString('base64') })));
  assert.equal(wrong, null);
}, s => native ? s.replace("if (typeof atob === 'function') return atob(value)", "if (typeof atob === 'function') return ''")
  : s.replace('decodeBase64(value.cells).length', 'atob(value.cells).length'), native ? { atob } : {});

for (const terminal of [false, true]) newCheck(`G6 real snapshot output ${terminal ? 'terminal' : 'desktop'}`, async h => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAAEklEQVR4AWP4z8Dwn4GB4f9/ABH4A/1gtGwYAAAAAElFTkSuQmCC', 'base64');
  let output;
  const code = h.snapshotCode('Real', 2, 1, terminal, token);
  // Run the snapshot producer with fixture engine APIs and an offline codec loader.
  const loadCodec = async name => {
    assert.equal(name, 'pngjs');
    return { PNG: { sync: { read: () => ({ width: 1, height: 2,
      data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) }) } } };
  };
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('cua', 'nodeRepl', 'Buffer', 'load', code.replaceAll('import(', 'load('));
  await run({ getApp: async app => { assert.equal(app, 'Real'); return { getScreenshot: async () => png }; } },
    { write: text => { output = text; } }, Buffer, loadCodec);
  const got = h.frameFrom(output, token, 'Real');
  assert.ok(got); assert.equal(got.app, 'Real');
  assert.equal(Boolean(got.cells), terminal); assert.equal(Boolean(got.image), !terminal);
}, s => s.replace(terminal ? '...(cells ? { cells } : {})' : '...(image ? { image } : {})', '...{}'));
newCheck('G7 slash replay engine stop text', async h => {
  h.setReply(tool => ({ content: tool === 'replay'
    ? [{ text: JSON.stringify({ ok: false, step: 1, error: 'REFUSED: app\ue000\u0378', waits: [] }) }] : [] }));
  const result = await h.emit('command.run', { command: 'sleight', args: 'replay x.json' });
  clean(result.text); assert.match(result.text, /Replay stopped at step 1: REFUSED: app/);
}, s => {
  const at = s.indexOf("if (args === 'replay'");
  return s.slice(0, at) + s.slice(at).replace('plainText(result.text, 400)', 'result.text');
});
