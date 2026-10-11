import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callLocalTool, localToolDefinitions, openDocument } from '../plugins/sleight/lib/launch.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sleight-open-file-'));
const file = join(dir, 'note.txt');
writeFileSync(file, 'hello');
const recorder = () => { const calls = []; return { calls, exec: async (cmd, argv) => { calls.push([cmd, ...argv]); } }; };
const IDS = { TextEdit: 'com.apple.TextEdit', 'com.apple.TextEdit': 'com.apple.TextEdit', Terminal: 'com.apple.Terminal',
  'My Term': 'com.googlecode.iterm2', ChatGPT: 'com.openai.chat', 'Python Launcher': 'org.python.PythonLauncher' };
const resolve = async name => IDS[name] ?? '';
const message = result => result.content[0].text;

test('open_file opens an existing file with the app left in the background', async () => {
  const { calls, exec } = recorder();
  const result = await openDocument({ app: 'TextEdit', path: file }, { exec, resolve });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [['/usr/bin/open', '-g', '-b', 'com.apple.TextEdit', file]]);
  assert.match(message(result), /disableDiffing: true/);
  await openDocument({ app: 'com.apple.TextEdit', path: '~/note.txt' }, { exec, resolve, home: dir });
  assert.deepEqual(calls[1], ['/usr/bin/open', '-g', '-b', 'com.apple.TextEdit', file]);
});

test('under the sheet A/B, open_file names the getApp call to send next', async () => {
  const { exec } = recorder();
  const was = process.env.SLEIGHT_FIRST_CALL_BATCH;
  process.env.SLEIGHT_FIRST_CALL_BATCH = 'sheet';
  try {
    const result = await openDocument({ app: 'TextEdit', path: file }, { exec, resolve });
    assert.match(message(result), /Next, send `let app = await cua\.getApp\("com\.apple\.TextEdit"\)`/);
    assert.doesNotMatch(message(result), /getAXState/);
  } finally { if (was === undefined) delete process.env.SLEIGHT_FIRST_CALL_BATCH; else process.env.SLEIGHT_FIRST_CALL_BATCH = was; }
});

test('open_file refuses terminals by resolved ID, launchers, runnable files and bad paths before running open', async () => {
  const { calls, exec } = recorder();
  mkdirSync(join(dir, 'folder'));
  symlinkSync(file, join(dir, 'link.txt'));
  writeFileSync(join(dir, 'run.sh'), 'echo hi');
  writeFileSync(join(dir, 'tool'), 'echo hi', { mode: 0o755 });
  for (const [args, pattern] of [
    [{ app: 'Terminal', path: file }, /isn't driven by sleight/],
    [{ app: 'My Term', path: file }, /isn't driven by sleight/],
    [{ app: 'ChatGPT', path: file }, /isn't driven by sleight/],
    [{ app: 'Python Launcher', path: file }, /runs or installs/],
    [{ app: 'No Such App', path: file }, /no app named/],
    [{ app: '/System/Applications/Utilities/Terminal.app', path: file }, /not a path/],
    [{ app: 'Terminal.app', path: file }, /not a path/],
    [{ app: 'TextEdit', path: join(dir, 'run.sh') }, /scripts, apps or installers/],
    [{ app: 'TextEdit', path: join(dir, 'tool') }, /executable files/],
    [{ app: 'TextEdit', path: 'note.txt' }, /absolute path/],
    [{ app: 'TextEdit', path: join(dir, 'folder') }, /regular file/],
    [{ app: 'TextEdit', path: join(dir, 'link.txt') }, /regular file/],
    [{ app: 'TextEdit', path: join(dir, 'missing.txt') }, /No file/],
  ]) {
    const result = await openDocument(args, { exec, resolve });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(message(result), pattern);
  }
  assert.deepEqual(calls, []);
});

test('open_file asks once per app and stops when the user declines', async () => {
  const asked = [];
  const result = await callLocalTool('open_file', { app: 'TextEdit', path: file }, async (parts, text) => { asked.push([parts, text]); return false; });
  assert.equal(result.isError, true);
  assert.match(message(result), /didn't allow opening files in TextEdit/);
  assert.deepEqual(asked[0][0], ['open_file', 'TextEdit']);
  assert.match(asked[0][1], /^Allow Claude to open files in TextEdit\? /);
  assert.ok(localToolDefinitions({}).some(tool => tool.name === 'open_file'));
  assert.ok(!localToolDefinitions({ SLEIGHT_OPEN_FILE: '0' }).some(tool => tool.name === 'open_file'));
});
