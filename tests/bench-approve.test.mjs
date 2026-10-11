import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webBrowsers } from '../bench/tasks-web.mjs';
import { execFileSync } from 'node:child_process';

const approve = (message, suite = 'default', extra = {}) => {
  const input = { mcp_server_name: 'plugin:sleight:computer', message };
  const env = { ...process.env, BENCH_SUITE: suite, ...extra };
  if (!('BENCH_OWNER_PRESENT' in extra)) delete env.BENCH_OWNER_PRESENT;
  const output = execFileSync(process.execPath, ['bench/approve.mjs'], { cwd: new URL('..', import.meta.url),
    env, input: JSON.stringify(input), encoding: 'utf8' });
  return output ? JSON.parse(output).hookSpecificOutput.action : null;
};
test('benchmark menu approvals cover the original apps and exclude unapproved targets', () => {
  for (const app of ['Calculator', 'TextEdit', 'Chess']) assert.equal(approve(`Allow Claude to use ${app}'s menu bar item?`), 'accept');
  for (const app of ['System Settings', 'ChatGPT', 'TextEdit copy']) assert.equal(approve(`Allow Claude to use ${app}'s menu bar item?`), null);
  assert.equal(approve('Allow Claude to read and use your notifications?'), null);
});
test('benchmark drags approve the three apps by bundle ID too, exact case only', () => {
  for (const app of ['com.apple.Chess', 'com.apple.TextEdit', 'com.apple.calculator', 'Chess']) {
    assert.equal(approve(`Allow Claude to drag in ${app}? It moves the pointer.`), 'accept');
  }
  for (const app of ['com.apple.chess', 'com.apple.Safari.copy', 'com.apple.Chess.evil']) {
    assert.equal(approve(`Allow Claude to drag in ${app}? It moves the pointer.`), null);
  }
});
test('benchmark open_file approves only the allowlisted apps', () => {
  assert.equal(approve('Allow Claude to open files in TextEdit? They open in the background.'), 'accept');
  assert.equal(approve('Allow Claude to open files in Terminal? They open in the background.'), null);
});
test('real tasks approve their apps and exact bundle IDs without widening core approval', () => {
  for (const app of ['Safari', 'com.apple.Safari', 'Preview', 'com.apple.Preview', 'Finder', 'com.apple.finder', 'Helium', 'net.imput.helium',
    'Microsoft Word', 'Word', 'com.microsoft.Word', 'Microsoft Excel', 'Excel', 'com.microsoft.Excel', 'Microsoft PowerPoint', 'PowerPoint', 'com.microsoft.Powerpoint', 'Mail', 'com.apple.mail', 'Mimestream', 'com.mimestream.Mimestream',
    'Visual Studio Code', 'VS Code', 'com.microsoft.VSCode', 'Cursor', 'com.todesktop.230313mzl4w4u92',
    'Firefox', 'org.mozilla.firefox', 'Slack', 'com.tinyspeck.slackmacgap', 'Discord', 'com.hnc.Discord',
    'WhatsApp', 'net.whatsapp.WhatsApp', ...webBrowsers.flatMap(({ app, bundle }) => [app, bundle])]) {
    assert.equal(approve(`Allow Computer Use to use "${app}"?`), null);
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'real'), 'accept');
  }
  for (const app of ['Google Chrome copy', 'com.google.chrome', 'Arc copy', 'company.thebrowser.browser', 'net.imput.helium.copy', 'com.apple.preview', 'com.microsoft.word', 'com.microsoft.Excel.copy', 'Mail copy', 'Mimestream copy', 'com.mimestream.mimestream',
    'Code copy', 'com.microsoft.vscode', 'Slack copy', 'org.mozilla.Firefox',
    'iPhone Mirroring', 'com.apple.ScreenContinuity']) {
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'real'), null);
  }
});
test('benchmark runs approve Simulator and DeviceHub by name and bundle ID', () => {
  for (const app of ['Simulator', 'com.apple.iphonesimulator', 'DeviceHub', 'Device Hub', 'com.apple.dt.Devices']) assert.equal(approve(`Allow Computer Use to use "${app}"?`), 'accept');
  assert.equal(approve('Allow Computer Use to use "Xcode"?'), null);
});

test('iPhone Mirroring is approved only in a real-suite run with the owner present (owner, 2026-10-11)', () => {
  for (const app of ['iPhone Mirroring', 'com.apple.ScreenContinuity']) {
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'real', { BENCH_OWNER_PRESENT: '1' }), 'accept');
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'real'), null);
    assert.equal(approve(`Allow Computer Use to use "${app}"?`, 'default', { BENCH_OWNER_PRESENT: '1' }), null);
  }
  assert.equal(approve('Allow Computer Use to use "com.apple.screencontinuity"?', 'real', { BENCH_OWNER_PRESENT: '1' }), null);
});
