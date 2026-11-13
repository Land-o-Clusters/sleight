const macHome = '/' + ['Users', 'u'].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fixture, ordinaryCommands, bypassBanks, refuses, executablePipelines, conditionalDirectories, protectedDirectory as D, reviewOptions } from './fixtures/gd7-review-harness.mjs';
import * as guard from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { hostStatFrom } from './fixtures/host-fs-stat.mjs';
const mock = reviewOptions;
test('GD7 reviewer ordinary corpus, real tree and session cwd independent of process cwd', async t => {
  const f = fixture();
  try {
    assert.equal(ordinaryCommands.length, 455);
    let allowed = 0;
    const failures = [];
    for (const command of ordinaryCommands) {
      const result = await refuses(guard, command, f.options);
      if (!result) allowed++;
      if (result !== executablePipelines.has(command)) failures.push(command);
    }
    t.diagnostic(`${allowed}/455 allowed; ${455 - allowed} refused; ${failures.length} verdict failures`);
    assert.deepEqual(failures, []);
  } finally { f.close(); }
});
for (const [name, cases] of Object.entries(bypassBanks).filter(([name]) => name.startsWith('K1') || name.startsWith('D '))) test(`GD7 reviewer bypass ${name}`, async t => {
  const allowed = [];
  for (const command of cases) if (!await refuses(guard, command, mock)) allowed.push(command);
  t.diagnostic(`${allowed.length}/${cases.length} allowed`);
  assert.deepEqual(allowed, []);
});
for (const command of conditionalDirectories) test(`GD7 conditional directory ${command}`, async () => assert.equal(await refuses(guard, command, mock), true));
const P = '"~/Library/Application Support/sleight/hand.json"';
for (const command of [
  `unzip -qd ${D} a.zip`, `unzip -oqd${D} a.zip`, `taskpolicy -t 1 -l 2 tee ${P}`, `taskpolicy -c background -d throttle touch ${P}`,
  `taskpolicy -g default touch ${P}`, `bash <(echo 'touch ${P}')`, `sh <(printf '%s' 'touch ${P}')`, `sh -c -- 'touch ${P}'`,
  `echo 'touch ${P}' | xargs -I{} sh -c '{}'`, `sed "$(echo -i)" p ${P}`,
  ...['--etag-save', '--hsts', '--alt-svc', '--ssl-sessions'].map(flag => `curl ${flag} ${P} u`), `curl -w '%output{~/Library/Application Support/sleight/hand.json}' u`,
  ...['--hsts-file', '--warc-file', '--rejected-log'].map(flag => `wget ${flag}=${P} u`), `wget -e logfile=${P} u`,
  `7z x a -o${D}`, `tar --one-top-level=${D} -xf a`, `tar -cf ${P} src`, `zip ${P} x`, `pax -w -f ${P} x`,
  ...['gtimeout 5', 'gnice', 'genv', 'gstdbuf -oL', 'gtime', 'setsid', 'unbuffer', 'noglob', 'nocorrect', 'lockf -k /tmp/l', 'sandbox-exec -p x', 'watch -n1', 'reattach-to-user-namespace'].map(prefix => `${prefix} touch ${P}`),
  `gshuf -o ${P} a`, `gcsplit a 1 -f ${P}`, `grmdir ${D}`, `gmktemp ${D}/x.XXXX`, `glink x ${P}`, `gpatch ${P} < x`, `gawk -i inplace 1 ${P}`, `echo ${P} | gxargs touch`,
]) test(`GD7 writer regression ${command}`, async () => assert.equal(await refuses(guard, command, mock), true));
for (const prefix of ['source ./env.sh', '. .venv/bin/activate', 'eval "$(pyenv init -)"', 'eval "$(ssh-agent -s)"', "trap 'rm -f lock' EXIT", "trap '' INT", 'cd /missing', 'cd "$(git rev-parse --show-toplevel)"']) {
  test(`GD7 uncertain directory ordinary and protected names ${prefix}`, async () => {
    for (const path of ['out.txt', 'build/', 'dist/x.js']) assert.equal(await refuses(guard, `${prefix}; touch ${path}`, mock), false, path);
    for (const path of ['hand.json', 'preapproved.json', '.claude/settings.json', '.zshrc', 'x/sleight/other', 'launch.mjs', 'hand.json/', '[h]and.json', '{hand,other}.json']) assert.equal(await refuses(guard, `${prefix}; touch ${path}`, mock), true, path);
  });
}
test('GD7 directory probes always use session cwd and follow directory links with spaces', async () => {
  const f = fixture();
  try {
    const paths = [], stat = async path => { paths.push(path); assert.ok(path.startsWith('/'), path); return f.options.stat(path); };
    assert.equal(await refuses(guard, 'cd src; touch out.txt', { ...f.options, stat }), false);
    assert.ok(paths.includes(f.options.cwd + '/src'));
    assert.equal(await refuses(guard, 'cd "linked folder"; touch hand.json', { ...f.options, stat }), true);
    assert.equal(await refuses(guard, 'touch hand.json', { ...f.options, cwd: f.options.home + '/Library/Application Support/sleight', stat }), true);
  } finally { f.close(); }
});
// Each hung stat is unknown after 750 ms, so these two decisions take about 1.5 s.
test('GD7 bounded filesystem probes resolve hung metadata as unknown', { timeout: 4000 }, async () => {
  const start = performance.now();
  const options = { ...mock, cwd: '/project', stat: () => new Promise(() => {}) };
  assert.equal(await refuses(guard, 'cd /hung; touch hand.json', options), true);
  // A timed-out stat can only make the answer stricter (1.6.1): the hung cd refuses an ordinary name too.
  assert.equal(await refuses(guard, 'cd /hung; touch out.txt', options), true);
  assert.ok(performance.now() - start < 2500);
});
test('GD7 register passes session cwd to the filesystem guard', () => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  assert.match(source, /cwd\s*=\s*await \$\.session\.cwd\(\)/);
  assert.match(source, /preapprovedWriteTarget\(event,\s*\{\s*(?:platform,\s*cwd|cwd,\s*platform)/);
});

for (const body of ['source = open("x").read()', 'eval(code)', "trap 'rm -f lock' EXIT", '. Step two', 'source maps are emitted', '$(eval "$PROGRAM")']) {
  for (const make of [body => `cat > a.py <<'EOF'\n${body}\nEOF`, body => `git commit -m "$(cat <<'EOF'\nfix\n${body}\nEOF\n)"`]) {
    const command = make(body);
    // Quoted heredocs stay data inside substitutions too, including literal eval text.
    test(`GD7 quoted heredoc data ${command}`, async () => assert.equal(await refuses(guard, command, mock), false));
  }
}
for (const body of ['touch hand.json', 'source <(echo "touch hand.json")', 'sleight-mcp hand on']) {
  test(`GD7 quoted heredoc protected source ${body}`, async () => {
    assert.equal(await refuses(guard, `bash <<'EOF'\n${body}\nEOF`, mock), true);
  });
}
test('GD7 directories created by this command stay known before a protected basename', async () => {
  const f = fixture();
  try {
    for (const command of ['mkdir -p build && cd build && touch hand.json', 'git clone u r && cd r && touch hand.json'])
      assert.equal(await refuses(guard, command, f.options), false, command);
  } finally { f.close(); }
});

test('GD7 a quoted heredoc delimiter is not body data', async () => {
  assert.equal(await refuses(guard, "cat > notes.txt <<'hand.json'\nordinary text\nhand.json", mock), false);
});
test('GD7 unknown-directory refusal states the cause', async () => {
  const label = await guard.preapprovedWriteTarget({ tool: 'Bash', command: 'cd /missing; touch hand.json' }, mock);
  assert.equal(label, guard.PROTECTED.unknownDirectory);
  assert.match(guard.preapprovedWriteReason(label), /Unknown directory before a write to a protected name/);
  assert.doesNotMatch(guard.preapprovedWriteReason(label), /HOME/);
});
for (const command of [
  `eval "$(echo 'touch ${P}')"`, `eval "$(printf %s 'touch ${P}')"`, `eval "\`echo 'touch ${P}'\`"`,
  `source ${P}`, `. ${P}`,
]) test(`GD7 generated code with protected names ${command}`, async () => assert.equal(await refuses(guard, command, mock), true));
test('GD7 missing session cwd never probes the hook process cwd', async () => {
  let probes = 0;
  const options = { ...mock, cwd: undefined, stat: hostStatFrom(path => { assert.ok(path.startsWith('/'), path); probes++; return path; }) };
  assert.equal(await refuses(guard, 'touch out.txt', options), false);
  assert.equal(await refuses(guard, 'touch hand.json', options), true);
  assert.equal(probes, 0);
});
for (const command of [
  `curl -u 'foo:cookie' https://example.invalid/x`, `wget -qerobots=off https://example.invalid/x`,
  `tar -xf ${P}`, `cat > notes.txt <<'EOF'\n$(eval "$PROGRAM")\nEOF`,
]) test(`GD7 additional ordinary data ${command}`, async () => assert.equal(await refuses(guard, command, mock), false));

for (const flag of ['-m 128', '-j 10', '-S 1', '-P throttle']) {
  const command = `taskpolicy ${flag} touch ${P}`;
  test(`GD7 taskpolicy value option ${command}`, async () => assert.equal(await refuses(guard, command, mock), true));
}
test('GD7 host timers are cancelled and late metadata cannot change a timeout verdict', async () => {
  let scheduled = 0, cancelled = 0, settle;
  const after = (ms, fn) => {
    scheduled++;
    const timer = setTimeout(fn, ms);
    return { cancel: () => { cancelled++; clearTimeout(timer); } };
  };
  const options = { ...mock, cwd: '/project', after, stat: async path => ({ realPath: path }) };
  assert.equal(await refuses(guard, 'touch ordinary.txt', options), false);
  assert.equal(scheduled, cancelled);
  const pending = guard.preapprovedWriteTarget({ tool: 'Bash', command: 'cd /hung; touch hand.json' }, { ...options, stat: () => new Promise(resolve => { settle = resolve; }) });
  assert.equal(await pending, guard.PROTECTED.unknownDirectory);
  settle({ realPath: '/tmp' });
  assert.equal(scheduled, cancelled);
});

const priorBypass = JSON.parse(readFileSync(new URL('fixtures/gd7-bypass-verdicts.json', import.meta.url))).verdicts;
for (const [name, commands] of Object.entries(bypassBanks)) test(`GD7 retains every prior refusal in ${name}`, async t => {
  const allowed = [];
  let retained = 0;
  for (const [at, command] of commands.entries()) if (priorBypass[name][at]) {
    retained++;
    if (!await refuses(guard, command, mock)) allowed.push(command);
  }
  t.diagnostic(`${retained} prior refusals; ${allowed.length} relaxed`);
  assert.deepEqual(allowed, []);
});

const ts = await import('typescript').then(module => module.default).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
test('GD7 installed PreToolUse uses session cwd and host timers with the real guard', { skip: !ts && 'needs typescript' }, async () => {
  const f = fixture();
  try {
    const exports = {}, hooks = new Map(), paths = [];
    const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(js, { exports, require(name) {
      if (name === 'claude-code') return { atom: (_key, value) => ({ value }) };
      if (name === './preapproved-write-guard.mjs') return guard;
      if (name === './narration.mjs') return { createNarrationCache: () => ({}) };
      return {};
    } });
    exports.register((name, filter, handler) => { hooks.set(name, handler ?? filter); return { catch() {} }; });
    let cwd = f.options.cwd, scheduled = 0, cancelled = 0;
    const $ = { session: { cwd: async () => cwd }, env: { get: async key => key === 'HOME' ? f.options.home : key === 'CLAUDE_CONFIG_DIR' ? f.options.configDir : undefined },
      clock: { after(ms, fn) { scheduled++; const id = setTimeout(fn, ms); return { cancel() { cancelled++; clearTimeout(id); } }; } },
      fs: { stat: async path => { paths.push(path); assert.ok(path.startsWith('/'), path); return f.options.stat(path); } } };
    const pre = command => hooks.get('classic.PreToolUse')($, { tool: 'Bash', command }, () => ({ passed: true }));
    assert.equal((await pre('cd src && touch out.txt')).passed, true);
    assert.ok(paths.includes(f.options.cwd + '/src'));
    assert.equal(scheduled, cancelled);
    cwd = f.options.home + '/Library/Application Support/sleight';
    assert.match((await pre('touch hand.json')).deny, /settings files/);
    cwd = 'relative-unavailable';
    paths.length = 0;
    assert.equal((await pre('touch out.txt')).passed, true);
    assert.match((await pre('touch hand.json')).deny, /Unknown directory/);
    assert.equal(paths.length, 0);
  } finally { f.close(); }
});
for (const command of [
  `cpio -idv -D ${D} < a`, `cpio -idv --directory=${D} < a`, `cpio -o -F ${P}`, `hdiutil create ${P}`,
  `xar -cf ${P} x`, `ar rc ${P} x`, `tar -P -xf a --transform 's,a,${macHome}/Library/Application Support/sleight/hand.json,'`,
  `gwget -qO ${P} u`,
]) test(`GD7 additional archive output ${command}`, async () => assert.equal(await refuses(guard, command, mock), true));
for (const command of ['cpio -idv -D out < a', 'cpio -o -F out.cpio', 'hdiutil create out.dmg', 'xar -cf out.xar x', 'ar rc out.a x', "tar -xf a --transform 's,a,b,'", 'gwget -qO out.txt u'])
  test(`GD7 ordinary archive output ${command}`, async () => assert.equal(await refuses(guard, command, mock), false));
for (const command of [
  `curl -sSw'%output{${macHome}/Library/Application Support/sleight/hand.json}' u`,
  `wget -qelogfile=${P} u`, `gshuf -o${P} a`, `gcsplit a 1 -f${P}`, `gawk -iinplace 1 ${P}`,
  `zip a.zip --out=${P}`, `pax -wf${P} x`, `7z a ${P} x`,
]) test(`GD7 attached output value ${command}`, async () => assert.equal(await refuses(guard, command, mock), true));

for (const form of ['cd escape; cd ..', 'cd -L escape; cd ..', 'cd escape/..']) test(`GD7 logical and physical parent disagreement ${form}`, async () => {
  const f = fixture();
  try {
    const directory = f.options.home + '/Library/Application Support/sleight';
    symlinkSync(f.options.cwd, directory + '/escape');
    assert.equal(await refuses(guard, `cd "${directory}"; ${form}; touch hand.json`, f.options), true);
    assert.equal(await refuses(guard, `cd "${directory}"; ${form}; touch out.txt`, f.options), false);
  } finally { f.close(); }
});
