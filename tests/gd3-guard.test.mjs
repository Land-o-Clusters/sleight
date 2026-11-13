import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preapprovedWriteDenied as denied, preapprovedWriteTarget, preapprovedWriteReason, MAX_PROTECTED_COMMAND, PROTECTED } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { writeCases, writeForms, protectedTargets } from './fixtures/gd3-write-cases.mjs';

const options = { stat: async path => ({ realPath: path }), home: '/fixture', configDir: '/fixture/.claude', platform: 'darwin' };
for (const command of writeCases) test(`GD3 refuses writer ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, options), true, command);
});
for (const form of writeForms) {
  const command = form('/tmp/ordinary-output');
  test(`GD3 allows ordinary writer ${command}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command }, options), false, command);
  });
}
const sizeSpellings = [
  ...protectedTargets,
  'sleight-mcp', 'launch.mjs', '/.local/bin/sleight', 'hand.json', 'grant-seal.key', 'menu-session.lock',
    '~/Library/Caches/sleight/host', '~/.claude/plugins/cache/local/sleight/hooks.mjs',
    '%LOCALAPPDATA%/sleight/turbo-host/host', 'SLEIGHT-MCP', 'slei""ght-mcp', "'sleight-' + 'mcp'",
    'slei\\\nght-mcp', 'slei\\ght-mcp', 'slei\\x67ht-mcp', 'slei\\u0067ht-mcp', 'slei\\u{67}ht-mcp',
    'slei\\147ht-mcp', 'slei*ht-mcp', 'sle?ght-mcp', '[s]leight-mcp', 'sle{ight,ep}-mcp', '*', 'han?.json',
];
for (const spelling of sizeSpellings) for (const tool of ['Bash', 'PowerShell']) {
  test(`GD3 refuses oversized ${tool} spelling ${spelling}`, async () => {
    let probes = 0;
    const command = '#'.repeat(MAX_PROTECTED_COMMAND + 1) + `\necho ${spelling}`;
    const target = await preapprovedWriteTarget({ tool, command }, { ...options, stat: async () => { probes++; throw Error('must not probe'); } });
    assert.equal(target, PROTECTED.oversized);
    assert.equal(probes, 0);
    assert.match(preapprovedWriteReason(target), /65536 characters/);
  });
}
test('GD3 size boundary keeps ordinary read behavior at the cap', async () => {
  const tail = '\ncat "~/Library/Application Support/sleight/hand.json"';
  const command = '#'.repeat(MAX_PROTECTED_COMMAND - tail.length) + tail;
  assert.equal(command.length, MAX_PROTECTED_COMMAND);
  assert.equal(await denied({ tool: 'Bash', command }, options), false);
  assert.equal(await preapprovedWriteTarget({ tool: 'Bash', command: '#' + command }, options), PROTECTED.oversized);
});
for (const tail of ['\necho ordinary', '\ncat /tmp/ordinary-output', '\nprintf "%s" "*.md"', '\necho "unclosed["']) {
  test(`GD3 oversized command without a protected hint preserves ${tail}`, async () => {
    const command = '#'.repeat(MAX_PROTECTED_COMMAND + 1) + tail;
    assert.equal(await denied({ tool: 'Bash', command }, options), false);
  });
}
test('GD3 preserves a heredoc operator split across a continuation', async () => {
  const command = "python3 <\\\n<'PY'\nfrom pathlib import Path\nPath('hand.json').write_text('{}')\nPY";
  assert.equal(await denied({ tool: 'Bash', command }, options), true);
});
for (const name of ['cp', 'ln', 'install']) for (const flag of ['--t', '--target-d', '--target-directory']) {
  for (const attached of [false, true]) {
    const command = `${name} ${flag}${attached ? '=' : ' '}"~/Library/Application Support/sleight" source`;
    test(`GD3 refuses target directory ${command}`, async () => {
      assert.equal(await denied({ tool: 'Bash', command }, options), true, command);
    });
  }
}
