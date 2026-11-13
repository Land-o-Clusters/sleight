import test, { after, describe } from 'node:test';
import { localBackendSkip, localBackends, nativeLocal } from './fixtures/mac-driver-tools.mjs';
import { createMacDriverTools } from '../plugins/sleight/lib/mac-driver/tools.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callLocalTool as scriptCall, localToolDefinitions, openDocument as scriptOpen } from '../plugins/sleight/lib/launch.mjs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

for (const backend of localBackends) describe(backend, { skip: localBackendSkip(backend) }, () => {
const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-open-file-')));
after(() => removeTemp(dir));
const file = join(dir, 'note.txt');
writeFileSync(file, 'hello');
const recorder = () => { const calls = []; return { calls, exec: async (cmd, argv) => { calls.push([cmd, ...argv]); } }; };
const IDS = { TextEdit: 'com.apple.TextEdit', 'com.apple.TextEdit': 'com.apple.TextEdit', Terminal: 'com.apple.Terminal',
  'My Term': 'com.googlecode.iterm2', ChatGPT: 'com.openai.chat', 'Python Launcher': 'org.python.PythonLauncher' };
const resolve = async name => IDS[name] ?? '';
const message = result => result.content[0].text;
function adapter(options = {}) {
  return createMacDriverTools({ ...options, resolve, driver: { ping: async () => ({}), request: async (method, { args }) => {
    assert.equal(method, 'localTool');
    const f = nativeLocal(args[0], args[1], {});
    if (f.result.ok && args[1].op === 'open') await options.exec?.('/usr/bin/open', ['-g', '-b', args[1].appId, args[1].path]);
    return f.result;
  } } });
}
const openDocument = backend === 'script' ? scriptOpen : (args, options) => adapter(options).openDocument(args, options);
const callLocalTool = backend === 'script' ? scriptCall : (name, args, approve) => adapter().call(name, args, approve);


test('open_file opens an existing file with the app left in the background', async () => {
  const { calls, exec } = recorder();
  const result = await openDocument({ app: 'TextEdit', path: file }, { exec, resolve });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [['/usr/bin/open', '-g', '-b', 'com.apple.TextEdit', file]]);
  assert.equal(result._meta['sleight/openedApp'], 'com.apple.TextEdit');
  await openDocument({ app: 'com.apple.TextEdit', path: '~/note.txt' }, { exec, resolve, home: dir });
  assert.deepEqual(calls[1], ['/usr/bin/open', '-g', '-b', 'com.apple.TextEdit', file]);
});

test('open_file describes its returned window and gives the relay the resolved app', async () => {
  const { exec } = recorder();
  const result = await openDocument({ app: 'TextEdit', path: file }, { exec, resolve });
  assert.equal(result._meta['sleight/openedApp'], 'com.apple.TextEdit');
  assert.doesNotMatch(message(result), /Next, send|getAXState/);
  const tool = localToolDefinitions({}).find(tool => tool.name === 'open_file');
  assert.match(tool.description, /result includes the window/);
  assert.match(tool.description, /app handle/);
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

});
