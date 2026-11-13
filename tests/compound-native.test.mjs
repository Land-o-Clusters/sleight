import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const { compoundParityLabels } = parserSkip ? {} : await import('./fixtures/compound-labels.mjs');
import { compoundLabelBoundary } from '../plugins/sleight/lib/mac-driver/compound/boundary.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { sessionMenuRequestAllowed } from '../plugins/sleight/lib/session-menu.mjs';
import { requestedQuitApps } from '../plugins/sleight/lib/quit-key.mjs';

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(input);
    let stdout = '', stderr = '';
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGINT', interrupt);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { process.off('SIGINT', interrupt); reject(error); });
    child.once('close', code => { process.off('SIGINT', interrupt); resolve({ code, stdout, stderr }); });
  });
}
test('real Swift UTF-16 resolver and continuous global watch, no host providers', { skip: process.platform !== 'darwin' ? 'Swift core fixture needs macOS' : parserSkip, timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-compound-native-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let source = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverCompound.swift', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverCompoundMachine.swift', import.meta.url), 'utf8');
  if (process.env.GLC3_NATIVE_MUTANT) {
    const anchor = 'return providers.menuRequestAllowed?(observed, node) == true';
    assert.ok(source.includes(anchor)); source = source.replace(anchor, 'return true');
  }
  assert.doesNotMatch(source, /import (?:AppKit|ApplicationServices|CoreGraphics)|register\(|NSWorkspace|CGEvent\(/);
  const file = join(root, 'main.swift'), binary = join(root, 'compound');
  await writeFile(file, source + '\n' + await readFile(new URL('./fixtures/compound-native.swift', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('./fixtures/compound-native-machine.swift', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('./fixtures/compound-native-menu.swift', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('./fixtures/glc3-compound-menu.swift', import.meta.url), 'utf8'));
  const built = await run('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(root, 'modules'), file, '-o', binary]);
  assert.equal(built.code, 0, built.stderr);
  t.diagnostic(`swiftc exit=${built.code}; binaryBytes=${(await stat(binary)).size}`);
  const parity = compoundParityLabels.map(label => ({ label: label.isWellFormed() ? label : null,
    local: compoundLabelBoundary(label) === 'clear' }));
  const menuPolicies = [];
  for (const [label, prompt, apple = false] of [['Quit Fixture', 'Quit Fixture'], ['Quit', 'Quit Fixture'],
    ['Log Out', 'Log out'], ['Shut Down…', 'Shut down my Mac'], ['Restart', 'Restart'],
    ['Force Quit…', 'Force quit Fixture'], ['Lock Screen', 'Lock screen'], ['Sleep', 'Sleep'],
    ['About This Mac', 'Open About This Mac', true]]) {
    for (const [message, want] of [[prompt, true], ['', false], ['Do not ' + prompt, false], ['Type "' + prompt + '"', false]]) {
      const allowed = sessionMenuRequestAllowed(label, { app: 'Fixture', apple }, requestedQuitApps(message, { menu: true }));
      assert.equal(allowed, want, label + ': ' + message);
      menuPolicies.push({ menuPolicy: true, label, apple, allowed, want });
    }
  }
  for (const [label, prompt] of [['Restart', 'Restart Fixture'], ['Log Out', 'Log out Fixture'], ['Force Quit Other', 'Force quit Fixture']]) {
    const allowed = sessionMenuRequestAllowed(label, { app: 'Fixture' }, requestedQuitApps(prompt, { menu: true }));
    assert.equal(allowed, false); menuPolicies.push({ menuPolicy: true, label, apple: false, allowed, want: false });
  }
  const result = await run('/usr/bin/nice', ['-n', '20', binary], JSON.stringify([...parity, ...menuPolicies]));
  assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(x => JSON.parse(x));
  assert.equal(rows.length, 90 + 36 + compoundParityLabels.length + menuPolicies.length * 4 + 4); assert.ok(rows.every(r => r.pass === true));
  t.diagnostic(`native assertions=${rows.length}; shared JS/Swift labels=${parity.length}; app/AX/input/clipboard/screen providers=0`);
});
