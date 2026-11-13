import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { preapprovedWriteTarget, preapprovedWriteDenied as denied, loggingSwitchWriteDenied, MAX_PROTECTED_COMMAND, PROTECTED } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { cases, switchCases, allows, timingShapes, sedForms } from './fixtures/gd4-write-cases.mjs';
const options = { stat: async path => ({ realPath: path }), home: '/fixture', configDir: '/fixture/.claude', platform: 'darwin' };
for (const { group, command } of cases) test(`GD4 refuses ${group}: ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, options), true, command);
});
for (const command of switchCases) test(`GD4 refuses startup switch: ${command}`, () => {
  assert.equal(loggingSwitchWriteDenied({ tool: 'Bash', command }), true, command);
});
for (const command of allows) test(`GD4 allows: ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, options), false, command);
});
for (const shape of timingShapes) for (const size of [65536, 262144]) test(`GD4 linear budget ${shape.name} ${size}`, async t => {
  const command = shape.make(size);
  assert.equal(command.length, size);
  const start = performance.now();
  const target = await preapprovedWriteTarget({ tool: 'Bash', command }, { ...options, platform: shape.platform });
  const ms = performance.now() - start;
  assert.equal(!!target, shape.refused(size));
  assert.ok(ms < 500, `${shape.name}: ${ms.toFixed(2)} ms exceeds 500 ms`);
  t.diagnostic(`${size} UTF-16 characters, ${ms.toFixed(3)} ms`);
});
for (const tail of [
  'a=han; b=d.json; s=sle; s2=ight; echo x > "$HOME/Library/Application Support/$s$s2/$a$b"',
  'echo x > "$HOME/Library/Application Support/sl${x}eight/han${y}d.json"',
  'echo "$ACTION_${v}_LOG" > ~/.zshrc', 'echo %D%/%F%',
]) test(`GD4 oversized dynamic spellings refuse: ${tail}`, async () => {
  let probes = 0;
  const command = '#'.repeat(MAX_PROTECTED_COMMAND + 1) + '\n' + tail;
  assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command }, { ...options, stat: async () => { probes++; } }), PROTECTED.oversized);
  assert.equal(probes, 0);
});
test('GD5 oversized ordinary writes refuse without entering the parser or stat', async () => {
  let probes = 0;
  const command = 'tee /tmp/ordinary-output #' + 'x'.repeat(MAX_PROTECTED_COMMAND);
  assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command }, { ...options, stat: async () => { probes++; } }), PROTECTED.oversized);
  assert.equal(probes, 0);
});
for (const command of ['echo %a:old=new%', 'echo %a:~0,1%', 'echo %x%%a:===%', 'echo %x%a:===%']) {
  test(`GD4 retains Windows substitution refusal ${command}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command }, { ...options, platform: 'win32' }), true);
  });
}

for (const tail of ['launchctl setenv SLEIGHT_OUTCOMES 1', 'claude mcp add-json x SLEIGHT_ACTION_LOG',
  'sed -I "" "s/^/SLEIGHT_OUTCOMES=1/" ~/.zshrc']) test(`GD4 oversized startup switches refuse: ${tail}`, () => {
  assert.equal(loggingSwitchWriteDenied({ tool: 'Bash', command: '#'.repeat(MAX_PROTECTED_COMMAND + 1) + '\n' + tail }), true);
});

for (const source of [
  'rmtree /tmp/hand.json /fixture/Library/Application Support/sleight/turbo.json',
  'rmtree /fixture/Library/Caches/sleight/host',
  'rmtree /fixture/.claude/plugins/cache/local/sleight/1/hooks.mjs',
  'rmtree /fixture/.local/bin/sleight',
]) test(`GD4 inline paths survive the single scan: ${source}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command: `python3 -c '${source}'` }, options), true);
});
for (const spelling of ['s^l^e^i^g^h^t-mcp', 's+l+e+i+g+h+t-mcp', 'han?.json', '[h]and.json', 'h{and,elp}.json']) {
  test(`GD4 oversized encoded or glob spelling: ${spelling}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command: '#'.repeat(MAX_PROTECTED_COMMAND + 1) + '\necho ' + spelling }, options), true);
  });
}

for (const flags of [...sedForms, '-ni', '-Ei']) for (const script of ['e $PROGRAM hand', 's/hand/$PROGRAM/e']) {
  test(`GD4 in-place sed still checks execution: ${flags} ${script}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command: `sed ${flags} '${script}' /tmp/input` }, options), true);
  });
}
for (const flags of [...sedForms, '-ni', '-Ei']) test(`GD4 in-place sed refuses an opaque target: ${flags}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command: `sed ${flags} 's/hand/link/' "$FILE"` }, options), true);
});

for (const tail of ['pwsh -enc RwBlAHQALQBEAGEAdABlAA==', 'powershell -EncodedCommand AAAA',
  'iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("AAAA")))',
  'echo ' + ['C:', 'Users', 'fixture', 'AppData', 'Local'].join('/')]) test(`GD4 oversized Windows hints refuse: ${tail}`, async () => {
  let probes = 0;
  const command = '#'.repeat(MAX_PROTECTED_COMMAND + 1) + '\n' + tail;
  assert.equal(await preapprovedWriteTarget({ tool: 'PowerShell', command }, { ...options, platform: 'win32', stat: async () => { probes++; } }), PROTECTED.oversized);
  assert.equal(probes, 0);
});
