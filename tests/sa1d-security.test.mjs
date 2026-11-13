import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { preapprovedWriteTarget, preapprovedWriteReason } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { SEALED_SETTINGS_FILES, isSealedSettingsName } from '../plugins/sleight/lib/sealed-settings.mjs';
import { readPermissions, createPermissionCheck } from '../plugins/sleight/lib/permissions.mjs';
import { loadPreapproved, listPreapproved, livePreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { hostStatFrom } from './fixtures/host-fs-stat.mjs';

const stat = async path => ({ realPath: path });
const home = '/fixture', settings = home + '/Library/Application Support/sleight';
const options = { stat, home, cwd: '/repo', platform: 'darwin' };
const guard = preapprovedWriteTarget;
const fileTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
function bank(t) {
  const dir = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-sa1d-'))));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function protects(check, path, opts = options) {
  for (const tool of fileTools) {
    assert.ok(await check({ tool, file_path: path, notebook_path: path }, opts), `${tool} ${path}`);
  }
  assert.ok(await check({ tool: 'MultiEdit', edits: [{ file_path: path }] }, opts));
  for (const command of [`tee '${path}'`, `printf x > '${path}'`, `rm -rf '${path}'`])
    assert.ok(await check({ tool: 'Bash', command }, opts), command);
  assert.equal(await check({ tool: 'Read', file_path: path }, opts), undefined);
  assert.equal(await check({ tool: 'Bash', command: `cat '${path}'` }, opts), undefined, `read ${path}`);
}

test('SA1D F6: bundled engine folders across hosts and versions are protected', async () => {
  for (const host of ['.codex', '.claude', '.cursor', 'custom-codex']) {
    for (const version of ['26.1.0', '9999.0.0']) {
      const path = `${home}/${host}/plugins/cache/openai-bundled/unified-computer-use/${version}/.mcp.json`;
      await protects(guard, path);
      assert.match(await guard({ tool: 'Write', file_path: path }, options), /engine/i);
    }
  }
  await protects(guard, '$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json');
  await protects(guard, '${CODEX_HOME}/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json');
  const path = `${home}/.codex/plugins/cache/openai-bundled/unified-computer-use/9999.0.0`;
  assert.ok(await guard({ tool: 'Bash', command: `mkdir -p '${path}' && tee '${path}/.mcp.json'` }, options));
  const resolve = async path => ({ realPath: path === '/alias' ? `${home}/.codex/plugins/cache/openai-bundled` : path });
  await protects(guard, '/alias/unified-computer-use/9999.0.0/.mcp.json', { ...options, stat: resolve });
  assert.equal(await guard({ tool: 'Write', file_path: '/repo/openai-bundled/notes' }, options), undefined);
});
test('SA1D F6: engine writes after an unknown cd and through a spaced alias refuse', async () => {
  const resolve = hostStatFrom(path => path === '/missing' ? undefined : path === '/scratch alias' ? '/fixture/.codex/plugins/cache/openai-bundled' : path);
  const opts = { ...options, stat: resolve };
  for (const command of ['cd /missing && tee "$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json"',
    "tee '/scratch alias/unified-computer-use/9999.0.0/.mcp.json'"])
    assert.ok(await guard({ tool: 'Bash', command }, opts), command);
});

const replayCommands = ['sleight-mcp replay s.json', 'sleight-mcp record',
  'node plugins/sleight/bin/sleight-mcp record', '~/.local/bin/sleight replay s.json',
  'cat s.json | sleight-mcp replay -', 'sh -c "sleight-mcp replay s.json"'];
test('SA1D F15: replay and record refuse with the replay tool named, bare stdio stays allowed', async () => {
  for (const command of replayCommands) {
    const label = await guard({ tool: 'Bash', command }, options);
    assert.ok(label, command);
    assert.match(preapprovedWriteReason(label), /replay tool/, command);
  }
  for (const command of ['sleight-mcp', 'node plugins/sleight/bin/sleight-mcp', 'sleight-mcp --doctor',
    'echo replay', 'cat record.json'])
    assert.equal(await guard({ tool: 'Bash', command }, options), undefined, command);
});

const linkCommands = [
  ...['-l', '-s', '-ls', '-al', '--link', '--symbolic-link'].map(flag => `cp ${flag} '${settings}/permissions.json' /tmp/alias`),
  `cp '${settings}/preapproved.json' /tmp/alias -l`,
  `cp -l -t /tmp '${settings}/permissions.json'`,
  ...['-H', '-L', '-aH', '--link-dest=/tmp/prior', '--link-dest /tmp/prior']
    .map(flag => `rsync ${flag} '${settings}/' /tmp/copy/`),
  `rsync -a --link-dest='${settings}' /tmp/source/ /tmp/copy/`,
  `rsync -a --link-dest '${settings}' /tmp/source/ /tmp/copy/`,
];
test('SA1D F22: link copies check sources and link-dest, plain copies remain reads', async () => {
  for (const command of linkCommands) assert.ok(await guard({ tool: 'Bash', command }, options), command);
  for (const command of [`cp '${settings}/permissions.json' /tmp/copy`,
    `install -l '${settings}/permissions.json' /tmp/copy`, `rsync -a '${settings}/' /tmp/copy/`,
    `cp -- -l /tmp/copy`, 'cp -l /repo/source /tmp/copy'])
    assert.equal(await guard({ tool: 'Bash', command }, options), undefined, command);
});

test('SA1D F23: every sealed name and scheduled settings folder is protected', async () => {
  const names = [...SEALED_SETTINGS_FILES, ...['routines', 'watches'].flatMap(folder =>
    ['script.json', 'routine.json', 'other-state.json'].map(file => `${folder}/${'a'.repeat(20)}/${file}`))];
  for (const name of names) {
    assert.equal(isSealedSettingsName(name), true, name);
    await protects(guard, `${settings}/${name}`);
  }
  for (const name of ['routines', 'watches', 'routines/' + 'a'.repeat(19) + '/script.json', 'watches/arbitrary/nested/blob'])
    await protects(guard, `${settings}/${name}`);
  assert.equal(await guard({ tool: 'Write', file_path: settings + '/routines-other/a.json' }, options), undefined);
});

test('SA1D F24: Windows settings have file and shell parity, including environment spellings', async () => {
  const winHome = ['C:', 'Users', 'fixture'].join('/'), opts = { ...options, home: winHome, platform: 'win32' };
  const roots = [winHome + '/AppData/Local', '%LOCALAPPDATA%', '$env:LOCALAPPDATA'];
  for (const root of roots) for (const name of [...SEALED_SETTINGS_FILES, 'routines', 'watches/' + 'a'.repeat(19) + '/script.json']) {
    const path = `${root}/sleight/${name}`;
    for (const spelling of [path, path.toUpperCase(), path.replaceAll('/', '\\')]) await protects(guard, spelling, opts);
  }
  assert.equal(await guard({ tool: 'Write', file_path: winHome + '/AppData/Local/sleight-bench/permissions.json' }, opts), undefined);
});

function readerFixture(t) {
  const dir = bank(t), folder = join(dir, 'Library/Application Support/sleight');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const permissions = join(folder, 'permissions.json'), approved = join(folder, 'preapproved.json');
  fs.writeFileSync(permissions, JSON.stringify({ version: 1, apps: [], sites: ['https://example.test'] }), { mode: 0o600 });
  fs.writeFileSync(approved, JSON.stringify({ version: 1, apps: [{ app: 'Fixture', riskLevel: 'low' }] }), { mode: 0o600 });
  const fixed = join(userInfo().homedir, 'Library/Application Support/sleight/preapproved.json');
  const io = { ...fs, realpathSync: path => path === fixed ? fixed : fs.realpathSync(path) };
  for (const method of ['lstatSync', 'openSync']) io[method] = (path, ...args) => fs[method](path === fixed ? approved : path, ...args);
  return { dir, permissions, approved, io };
}
test('SA1D F22: permissions rejects real hard links and notices a new alias mid-session', t => {
  const { dir, permissions } = readerFixture(t);
  assert.equal(readPermissions(permissions).state, 'ok');
  const check = createPermissionCheck({ path: permissions });
  assert.equal(check.state().state, 'ok');
  fs.linkSync(permissions, join(dir, 'alias'));
  assert.equal(fs.lstatSync(permissions).nlink, 2);
  assert.equal(readPermissions(permissions).state, 'unsafe');
  assert.equal(check.state().state, 'unsafe');
  fs.unlinkSync(join(dir, 'alias'));
  assert.equal(check.state().state, 'ok');
});
test('SA1D F22: preapproval startup, listing and live reads reject real hard links', t => {
  const { dir, approved, io } = readerFixture(t);
  const initial = loadPreapproved(io);
  assert.equal(initial.allows('Fixture', 'low'), true);
  const live = livePreapproved(initial, { io, file: approved, load: () => loadPreapproved(io) });
  assert.equal(listPreapproved({ home: dir }).length, 1);
  fs.linkSync(approved, join(dir, 'alias'));
  assert.throws(() => loadPreapproved(io), /link/i);
  assert.throws(() => listPreapproved({ home: dir }), /link/i);
  assert.equal(live.allows('Fixture', 'low'), false);
});
test('SA1D F22: preapproval validates nlink again after opening', t => {
  const { io } = readerFixture(t), original = io.fstatSync;
  io.fstatSync = fd => { const info = original(fd); info.nlink = 2; return info; };
  assert.throws(() => loadPreapproved(io), /link/i);
});

// Exercise the production trace function without starting an engine, app or worker.
const launchSource = fs.readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
function traceFactory(source = launchSource, overrides = {}) {
  const body = source.slice(source.indexOf('function traceTo('), source.indexOf('\nexport function approvalLogging'));
  assert.match(body, /^function traceTo\(/);
  const { default: ignored, ...filesystem } = fs;
  const bindings = { ...filesystem, join, homedir: () => '/unused', process: { pid: process.pid, getuid: () => process.getuid(), stderr: { write() {} } }, ...overrides };
  return Function(...Object.keys(bindings), body + '\nreturn traceTo;')(...Object.values(bindings));
}
function loggingBeforeStartup(source) {
  const run = source.slice(source.indexOf('  await recoverClipboard();'));
  assert.ok(run.indexOf('logging(preapproved)') > 0 && run.indexOf('logging(preapproved)') < run.indexOf('const prepared = shellRoute'),
    'the relay exclusively creates its trace before startup can fork a trace-writing worker');
}
test('SA1D trace: exclusive creation precedes startup workers', () => loggingBeforeStartup(launchSource));
test('SA1D broken variant caught: trace initialization after worker startup', () => {
  const block = 'const { trace, grantAudit } = logging(preapproved);';
  const mutant = replaceOnce(launchSource, block, '').replace('directBrowser = prepared.directBrowser;', block + '\n  directBrowser = prepared.directBrowser;');
  assert.throws(() => loggingBeforeStartup(mutant), { code: 'ERR_ASSERTION' });
});
test('SA1D trace: creates a 0700 directory and 0600 file even under a permissive umask', t => {
  const dir = join(bank(t), 'trace'), previous = process.umask(0);
  try {
    const trace = traceFactory()(dir);
    trace('sent', { secret: 'fixture' });
    assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
    const file = join(dir, `trace-${process.pid}.jsonl`);
    assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).msg.secret, 'fixture');
  } finally { process.umask(previous); }
});
test('SA1D trace: existing files and symlinks refuse instead of appending', t => {
  for (const symlink of [false, true]) {
    const dir = bank(t), file = join(dir, `trace-${process.pid}.jsonl`), target = join(dir, 'target');
    fs.writeFileSync(target, 'private fixture', { mode: 0o600 });
    if (symlink) fs.symlinkSync(target, file); else fs.writeFileSync(file, 'existing', { mode: 0o600 });
    assert.throws(() => { const trace = traceFactory()(dir); trace('sent', {}); });
    assert.equal(fs.readFileSync(target, 'utf8'), 'private fixture');
    if (!symlink) assert.equal(fs.readFileSync(file, 'utf8'), 'existing');
  }
});
test('SA1D trace: tightens an owned directory and refuses a symlinked directory', t => {
  const root = bank(t), dir = join(root, 'Library', 'Logs', 'sleight'), link = join(root, 'link');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); fs.symlinkSync(dir, link);
  assert.equal(typeof traceFactory(launchSource, { homedir: () => root })('1'), 'function');
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  assert.throws(() => traceFactory()(link));
});

const guardUrl = new URL('../plugins/sleight/hooks/preapproved-write-guard.mjs', import.meta.url);
function replaceOnce(source, before, after) {
  assert.ok(before instanceof RegExp ? before.test(source) : source.includes(before), `mutation precondition: ${before}`);
  if (before instanceof RegExp) before.lastIndex = 0;
  return source.replace(before, after);
}
async function moduleVariant(url, before, after) {
  const source = replaceOnce(fs.readFileSync(url, 'utf8'), before, after)
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_, lead, path, tail) => lead + new URL(path, url).href + tail);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const guardMutants = [
  ['F6 engine folder missing', 'if (ENGINE_TREE.test(value))', 'if (false)',
    { tool: 'Write', file_path: '/fixture/.codex/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json' }],
  ['F6 version pinned', 'if (ENGINE_TREE.test(value))', "if (ENGINE_TREE.test(value) && value.includes('/26.1.0/'))",
    { tool: 'Write', file_path: '/fixture/.codex/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json' }],
  ['F6 shell path missing', 'if (ENGINE_TREE.test(value))', "if (ENGINE_TREE.test(value) && !path.includes('$CODEX_HOME'))",
    { tool: 'Bash', command: 'tee "$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json"' }],
  ['F6 unknown cd loses engine name', "if (ENGINE_TREE.test(folded(path.replace(/\\\\/g, '/')))) return true;", '',
    { tool: 'Bash', command: 'cd /missing && tee "$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/9999.0.0/.mcp.json"' },
    { ...options, stat: hostStatFrom(path => path === '/missing' ? undefined : path) }],
  ['F6 spaced shell alias skipped', 'literalOnly || path.length >= 512', 'literalOnly || /\\s/.test(path) || path.length >= 512',
    { tool: 'Bash', command: "tee '/scratch alias/unified-computer-use/9999.0.0/.mcp.json'" },
    { ...options, stat: async path => ({ realPath: path === '/scratch alias' ? '/fixture/.codex/plugins/cache/openai-bundled' : path }) }],
  ['F15 replay and record omitted', /\|replay\|record|, 'replay', 'record'|'replay', 'record'/g, '',
    { tool: 'Bash', command: 'sleight-mcp replay s.json' }],
  ['F22 sources omitted', "executable === 'ln' || links", "executable === 'ln'",
    { tool: 'Bash', command: linkCommands[0] }],
  ['F22 cp symbolic links omitted', "'ls'.includes(arg[at])", "'l'.includes(arg[at])",
    { tool: 'Bash', command: linkCommands[1] }],
  ['F22 rsync short flags omitted', "name === 'rsync' && 'HL'.includes(arg[at])", 'false',
    { tool: 'Bash', command: `rsync -aH '${settings}/' /tmp/copy/` }],
  ['F22 link-dest omitted', 'linkDestinations.forEach(path => add(path, false, true));', '',
    { tool: 'Bash', command: `rsync -a --link-dest='${settings}' /tmp/source/ /tmp/copy/` }],
  ['F23 sealed filename omitted', ", 'routine-launcher.mjs'", '',
    { tool: 'Write', file_path: settings + '/routine-launcher.mjs' }],
  ['F23 folders omitted', "const scheduledFolders = ['routines', 'watches'];", 'const scheduledFolders = [];',
    { tool: 'Write', file_path: settings + '/routines/' + 'a'.repeat(19) + '/script.json' }],
  ['F24 Windows settings omitted', 'if (match && (!match[1] || settingsChild(match[1])))', 'if (false)',
    { tool: 'Write', file_path: ['C:', 'Users', 'fixture', 'AppData/Local/sleight/permissions.json'].join('/') }, { ...options, platform: 'win32' }],
];
for (const [name, before, after, input, opts = options] of guardMutants) {
  test(`SA1D broken variant caught: ${name}`, async () => {
    const mutant = await moduleVariant(guardUrl, before, after);
    await assert.rejects(async () => assert.ok(await mutant.preapprovedWriteTarget(input, opts)), { code: 'ERR_ASSERTION' });
  });
}
test('SA1D broken variant caught: F22 permission reader without nlink', async t => {
  const { dir, permissions } = readerFixture(t);
  fs.linkSync(permissions, join(dir, 'alias'));
  const mutant = await moduleVariant(new URL('../plugins/sleight/lib/permissions.mjs', import.meta.url), 'stat.nlink !== 1 || ', '');
  assert.throws(() => assert.equal(mutant.readPermissions(permissions).state, 'unsafe'), { code: 'ERR_ASSERTION' });
});
test('SA1D broken variant caught: F22 preapproval reader without nlink', async t => {
  const { dir, approved, io } = readerFixture(t);
  fs.linkSync(approved, join(dir, 'alias'));
  const mutant = await moduleVariant(new URL('../plugins/sleight/lib/preapproved.mjs', import.meta.url), "if (stat.nlink !== 1) throw error('hard links are refused');", '');
  assert.throws(() => assert.throws(() => mutant.loadPreapproved(io), /link/i), { code: 'ERR_ASSERTION' });
});
test('SA1D broken variant caught: F22 preapproval only checks before open', async t => {
  const { io } = readerFixture(t), original = io.fstatSync;
  io.fstatSync = fd => { const info = original(fd); info.nlink = 2; return info; };
  const mutant = await moduleVariant(new URL('../plugins/sleight/lib/preapproved.mjs', import.meta.url), 'validate(opened, user.uid);', '');
  assert.throws(() => assert.throws(() => mutant.loadPreapproved(io), /link/i), { code: 'ERR_ASSERTION' });
});
for (const [name, before, after, check] of [
  ['directory mode', 'recursive: true, mode: 0o700', 'recursive: true, mode: 0o755', (make, dir) => {
    make(dir); assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  }],
  ['file mode', 'constants.O_NOFOLLOW, 0o600', 'constants.O_NOFOLLOW, 0o644', (make, dir) => {
    make(dir); assert.equal(fs.lstatSync(join(dir, `trace-${process.pid}.jsonl`)).mode & 0o777, 0o600);
  }],
  ['exclusive file creation', ' | constants.O_EXCL', '', (make, dir) => {
    fs.mkdirSync(dir, { mode: 0o700 }); fs.writeFileSync(join(dir, `trace-${process.pid}.jsonl`), 'existing', { mode: 0o600 });
    assert.throws(() => make(dir));
  }],
  ['directory validation', /(?:directory|opened)\.uid !== process\.getuid\(\)/g, 'false', (make, dir) => {
    fs.mkdirSync(dir, { mode: 0o700 }); assert.throws(() => make(dir));
  }],
]) test(`SA1D broken variant caught: trace ${name}`, t => {
  const dir = join(bank(t), 'trace'), source = replaceOnce(launchSource, before, after);
  const overrides = name === 'directory mode' ? { mkdirSync: (path, opts) => {
    assert.equal(opts.mode, 0o700, 'directory must be private at creation'); fs.mkdirSync(path, opts);
  } } : name === 'directory validation' ? Object.fromEntries(['lstatSync', 'fstatSync'].map(method => [method, (...args) => {
    const info = fs[method](...args); info.uid = process.getuid() + 1; return info;
  }])) : {};
  const make = traceFactory(source, overrides);
  assert.throws(() => check(make, dir), { code: 'ERR_ASSERTION' });
});
