// A live TextEdit check. Keep and Undo must be chosen by the person in ask.js.
// Owns the MCP child and closes only these two temporary documents.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, appendFile, access } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { acquireLiveLock } from './live-lock.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const bank = await mkdtemp('/private/tmp/sleight-change-review-');
const nonce = basename(bank).split('-').at(-1);
const first = join(bank, `UNDO-${nonce}.txt`);
const second = join(bank, `KEEP-${nonce}.txt`);
const traceFile = join(bank, 'trace.jsonl');
const stages = [];
const pending = new Map();
let child, closed, releaseLiveLock, fixturesOpened = false, interrupted = false, nextId = 0;
const trace = record => appendFile(traceFile, JSON.stringify(record) + '\n');
const fixture = (operation, a = first, b = second) => execute('osascript', ['-l', 'JavaScript', join(ROOT, 'bench/document-scope-fixture.js'), operation, a, b]);
const texts = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const send = msg => { trace({ direction: 'client', msg }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
  send({ id, method, params });
});
process.once('SIGINT', () => {
  interrupted = true;
  for (const p of pending.values()) p.reject(new Error('cancelled'));
  pending.clear();
});
const call = async (name, args) => {
  const result = await request('tools/call', { name, arguments: args }, name === 'review_changes' ? 650000 : 60000);
  stages.push({ name, args, isError: result?.isError ?? false, window: windowFromText(texts(result)) ?? null,
    text: (result?.content ?? []).filter(c => c.type === 'text' && !c.text.includes('## API')).map(c => c.text) });
  assert.ok(!result?.isError, texts(result).split('\n## Computer Use')[0]);
  return result;
};

try {
  releaseLiveLock = await acquireLiveLock();
  console.log('Holding /tmp/sleight-live.lock until this live check finishes cleanup.');
  await writeFile(first, 'UNDO ORIGINAL\n'); await writeFile(second, 'KEEP ORIGINAL\n');
  fixturesOpened = true;
  await fixture('open');
  assert.ok(!interrupted, 'cancelled');
  console.log(`Fixtures: ${bank}\nApprove the TextEdit app prompt. Then choose Undo for the UNDO document and Keep for the KEEP document. These decisions must be made by the user.`);
  child = spawn(join(ROOT, 'plugins/sleight/bin/sleight-mcp'), [], { stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SLEIGHT_APPROVAL_SCOPE: 'session', SLEIGHT_APPROVAL_PROMPT: 'dialog',
      SLEIGHT_IDLE_TURN_END_MS: '0', SLEIGHT_CHANGE_REVIEW: '', SLEIGHT_TRACE: bank } });
  closed = new Promise(resolve => child.once('close', resolve));
  const rejectAll = err => { for (const p of pending.values()) p.reject(err); pending.clear(); };
  child.on('error', rejectAll);
  child.on('exit', code => rejectAll(new Error(`MCP exited ${code}`)));
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line); trace({ direction: 'server', msg });
    if (msg.method === 'elicitation/create') {
      // Unexpected prompts decline. Review and app prompts are owned by launch.mjs.
      send({ id: msg.id, result: { action: 'decline' } });
    } else if (!msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-change-review-benchmark', version: '1' } });
  send({ method: 'notifications/initialized' });
  for (const [path, content] of [[first, 'UNDO AGENT CHANGE\n'], [second, 'KEEP AGENT CHANGE\n']]) {
    await fixture('select', path, path === first ? second : first);
    const read = await call('js', { code: 'let app = await cua.getApp("TextEdit")' });
    assert.equal(windowFromText(texts(read))?.url, pathToFileURL(path).href);
    await call('js', { code: `await app.pressKey("super+a"); await app.typeText(${JSON.stringify(content)}); await app.pressKey("super+s");` });
    assert.equal(await readFile(path, 'utf8'), content);
  }
  const listing = await call('review_changes', { op: 'list' });
  assert.match(texts(listing), /-UNDO ORIGINAL\n\+UNDO AGENT CHANGE/);
  assert.match(texts(listing), /-KEEP ORIGINAL\n\+KEEP AGENT CHANGE/);
  // Close saved buffers before restoring bytes, to avoid a later autosave.
  await fixture('close');
  console.log('Both saved files changed. The two review panels now show their diffs.');
  await call('review_changes', { op: 'review' });
  const contents = { first: await readFile(first, 'utf8'), second: await readFile(second, 'utf8') };
  stages.push({ contents });
  assert.equal(contents.first, 'UNDO ORIGINAL\n'); assert.equal(contents.second, 'KEEP AGENT CHANGE\n');
  console.log(`PASS: user undid one file and kept the other.\nUNDO file: ${JSON.stringify(contents.first)}\nKEEP file: ${JSON.stringify(contents.second)}\nEvidence: ${bank}`);
  stages.push({ verdict: 'PASS' });
} catch (err) {
  stages.push({ verdict: 'FAIL', error: err.message });
  console.error(`FAIL: ${err.message}. Evidence: ${bank}`); process.exitCode = 1;
} finally {
  if (child) {
    child.stdin.end(); const timer = setTimeout(() => child.kill('SIGTERM'), 6000);
    await closed; clearTimeout(timer);
    try {
      const relayTrace = (await readFile(join(bank, `trace-${child.pid}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
      const directories = [...new Set(relayTrace.filter(e => ['snapshot-before-call', 'snapshot-after-read'].includes(e.direction)).map(e => e.msg.directory))];
      for (const directory of directories) {
        const exists = await access(directory).then(() => true, () => false);
        assert.equal(exists, false, 'session backups removed');
      }
      stages.push({ backupCleanup: 'PASS', directories });
    } catch (err) { stages.push({ backupCleanup: 'FAIL', error: err.message }); process.exitCode = 1; }
  }
  if (fixturesOpened) {
    try { await fixture('close'); } catch (err) { stages.push({ cleanupError: err.message }); process.exitCode = 1; }
  }
  if (releaseLiveLock) {
    try { await releaseLiveLock(); stages.push({ liveLockCleanup: 'PASS' }); }
    catch (err) { stages.push({ liveLockCleanup: 'FAIL', error: err.message }); process.exitCode = 1; }
  }
  await writeFile(join(bank, 'results.json'), JSON.stringify({ stages, traceFile }, null, 2) + '\n');
}
