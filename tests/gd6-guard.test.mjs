const macHome = '/' + ['Users', 'u'].join('/');
import { test } from 'node:test';
import { posix } from 'node:path';
import assert from 'node:assert/strict';
import * as guard from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { readFileSync } from 'node:fs';
import { hostStatFrom } from './fixtures/host-fs-stat.mjs';
const readVerdicts = JSON.parse(readFileSync(new URL('fixtures/gd6-read-verdicts.json', import.meta.url)));
import { directoryMatrix, keywordCases, writerCases, nestedCases, directoryReview, dynamicDirectoryCases, reviewerReads, readWrappers } from './fixtures/gd6-review-bank.mjs';

// Missing paths reject the way the mod host's $.fs.stat does (tests/fixtures/host-fs-stat-2.1.309.json).
const options = { stat: hostStatFrom(path => ['/nope', '/tmp/does-not-exist', (macHome + '/Application Support/sleight')].includes(posix.normalize(path)) ? undefined : path), home: (macHome), configDir: (macHome + '/.claude'), platform: 'darwin' };
const refuses = async (module, command, opts = options) => !!await module.preapprovedWriteTarget({ tool: 'Bash', command }, opts) || module.loggingSwitchWriteDenied({ tool: 'Bash', command });
const allowedDirectories = new Set(['control: subshell cd D then write in /tmp (allow ok)', 'control: subshell, ordinary', 'control: ordinary', 'control: mkdir cd write', 'control: pushd popd', 'control: git', 'control: cd - then absolute write', 'control: cd - then relative write (FP expected)', 'control: bare cd then relative write']);
const directoryCases = directoryReview.filter(([, name]) => !allowedDirectories.has(name)).map(([command]) => command);
for (const [name, cases] of Object.entries({ keywords: keywordCases, writers: writerCases, nested: nestedCases, directories: directoryCases, dynamic: dynamicDirectoryCases })) {
  test(`GD6 review ${name}`, async t => {
    let refused = 0;
    for (const command of cases) {
      const result = await refuses(guard, command);
      if (result) refused++;
      else t.diagnostic(`ALLOWED: ${command}`);
    }
    t.diagnostic(`${refused}/${cases.length} refused`);
    assert.equal(refused, cases.length);
  });
}
test('GD6 preserves reviewer read verdicts except the corrected ordinary-script refusal', async t => {
  let allowed = 0, refused = 0, index = 0;
  for (const prefix of readWrappers) for (const command of reviewerReads) {
    const text = `${prefix} ${command}`.trim();
    const before = readVerdicts.reads[index++], after = await refuses(guard, text);
    // SA1N: this path and its arguments do not name the sleight launcher.
    const expected = command === 'node scripts/x.mjs hand status' && prefix !== 'xargs' ? false : before;
    if (!expected) { allowed++; assert.equal(after, false, text); }
    else { refused++; assert.equal(after, true, text); }
  }
  t.diagnostic(`${allowed} allowed, ${refused} refused`);
});
for (const [command, name] of directoryReview.filter(([, name]) => allowedDirectories.has(name))) test(`GD6 preserves ${name}`, async () => {
  assert.equal(await refuses(guard, command), false, command);
});
// The review bank's missing paths reject with the host's shape, which reads as missing, so ordinary writes there pass.
test('GD6 missing paths answered as the host answers them allow ordinary writes', async () => {
  for (const command of ['cd /nope; touch out.txt', 'cd /tmp/does-not-exist && touch out.txt', 'echo x > /tmp/does-not-exist/new.txt', 'mkdir -p /nope/a/b'])
    assert.equal(await refuses(guard, command), false, command);
  assert.equal(await refuses(guard, 'cd /nope; touch hand.json'), true);
});
test('GD6 failed cd makes a subsequent relative write refuse', async () => {
  const command = 'cd "~/Library/Application Support/sleight"; cd /missing; touch hand.json';
  assert.equal(await refuses(guard, command, { ...options, stat: hostStatFrom(path => path === '/missing' ? undefined : path) }), true);
});

const protectedDirectory = '"~/Library/Application Support/sleight"';
for (const command of [
  '. <(echo "touch hand.json")', '. <(printf "%s" "touch hand.json")', 'source "$FILE"', 'eval "$PROGRAM"',
  `cd /tmp; trap 'touch hand.json' EXIT; cd ${protectedDirectory}`, 'printf "%s" "touch hand.json" | sh',
  `printf '%s\\n' 'touch ~/Library/Application\ Support/sleight/hand.json' | bash`,
  `cd ${protectedDirectory}; cd /tmp & touch hand.json`, `cd ${protectedDirectory}; cd /tmp | cat; touch hand.json`,
  `cd ${protectedDirectory}; false && builtin cd /tmp; touch hand.json`,
  `cd /tmp; CD""PATH=~/Library/Application\\ Support cd sleight; touch hand.json`,
  `cd /tmp; export CDPATH; cd sleight; touch hand.json`,
  `cd ${protectedDirectory}; cd /tmp /var; touch hand.json`,
  `cd /tmp; chdir "$WHERE"; touch hand.json`,
  'wget -nvqO "~/Library/Application Support/sleight/hand.json" https://example.invalid/x',
  'wget -nvqO"~/Library/Application Support/sleight/hand.json" https://example.invalid/x',
  `if true; then { ! nice -n 5 tee ${protectedDirectory}/hand.json; }; fi`,
  `function write { gtouch ${protectedDirectory}/hand.json; }; write`,
]) test(`GD6 additional refusal ${command}`, async () => assert.equal(await refuses(guard, command), true, command));

test('GD6 checks a changed directory through a symlink with spaces', async () => {
  const stat = hostStatFrom(path => path === '/tmp/linked folder' ? (macHome + '/Library/Application Support/sleight') : path);
  assert.equal(await refuses(guard, 'cd "/tmp/linked folder"; touch hand.json', { ...options, stat }), true);
});
test('GD6 nested absolute writes do not depend on an unknown cwd', async () => {
  for (const command of ['cd -; sh -c "touch /tmp/ordinary"', 'cd /missing; sh -c "touch /tmp/ordinary"']) {
    assert.equal(await refuses(guard, command, { ...options, stat: hostStatFrom(path => path === '/missing' ? undefined : path) }), false, command);
  }
});
for (const command of [
  'if true; then { ! nice tee /tmp/ordinary; }; fi', 'eval "touch /tmp/ordinary"',
  'wget -nvqO/tmp/ordinary https://example.invalid/x', 'taskpolicy -b tee /tmp/ordinary',
  'script -q /dev/null tee /tmp/ordinary', 'gtar -xf archive -C /tmp/ordinary',
  'gtouch /tmp/ordinary', 'grm /tmp/ordinary', 'gmkdir -p /tmp/ordinary',
]) test(`GD6 additional ordinary control ${command}`, async () => assert.equal(await refuses(guard, command), false, command));

for (const command of ['printf "%s" "touch /tmp/ordinary" | sh', 'echo "touch /tmp/ordinary" | sh']) {
  test(`GD6 preserves the existing refusal of piped shell source ${command}`, async () => assert.equal(await refuses(guard, command), true));
}


test('GD6 retains all 408 prior directory-matrix refusals and closes 40 cd synonym cases', async t => {
  const holes = new Set(['cd $OLDPWD', 'cd "$OLDPWD"', 'cd ~-', '|| cd', 'CDPATH']);
  let prior = 0, closed = 0, total = 0;
  for (const [index, { command, name }] of directoryMatrix.entries()) {
    const result = await refuses(guard, command);
    if (result) total++;
    if (readVerdicts.matrix[index]) { prior++; assert.equal(result, true, command); }
    else if (holes.has(name)) { closed++; assert.equal(result, true, command); }
  }
  assert.equal(prior, 408);
  assert.equal(closed, 40);
  t.diagnostic(`${total}/${directoryMatrix.length} refused, ${prior} prior refusals retained, ${closed} holes closed`);
});

for (const command of [
  `cd ${protectedDirectory}; true || cd /tmp && touch hand.json`,
  `cd ${protectedDirectory} || cd /tmp && touch hand.json`,
  `cd ${protectedDirectory}; (cd /tmp) || cd /var && touch hand.json`,
  `HOME=${protectedDirectory}; cd; touch hand.json`,
  `HOME=${protectedDirectory}; cd "$HOME"; touch hand.json`,
  `HOME=${protectedDirectory}; cd ~; touch hand.json`,
]) test(`GD6 uncertain cd chain ${command}`, async () => assert.equal(await refuses(guard, command), true, command));

for (const command of [
  `pushd /tmp; pushd ${protectedDirectory}; false && popd; touch hand.json`,
  `pushd /tmp; false && pushd ${protectedDirectory}; cd ${protectedDirectory}; popd; touch hand.json`,
  `pushd /tmp; pushd ${protectedDirectory}; popd | cat; touch hand.json`,
  `pushd /tmp; pushd ${protectedDirectory}; ! popd; touch hand.json`,
  `script -q ${protectedDirectory}/hand.json true`,
  `script -q -c 'touch ${protectedDirectory}/hand.json' /dev/null`,
]) test(`GD6 stack and recording destination refusal ${command}`, async () => assert.equal(await refuses(guard, command), true, command));

test('GD6 nested shell-prefix scanning stays bounded with 60,000 flag characters', async () => {
  const command = "sh -c 'bash -" + 'c'.repeat(60000) + "X'";
  const start = performance.now();
  assert.equal(await refuses(guard, command), false);
  assert.ok(performance.now() - start < 500);
});
