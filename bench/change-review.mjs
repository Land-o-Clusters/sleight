// A live TextEdit check. Keep and Undo must be chosen by the person in ask.js.
// Owns the MCP child and closes only its temporary documents and Open panel.
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
const rereadMode = process.argv.slice(2).includes('--reread');
assert.ok(process.argv.slice(2).every(arg => arg === '--reread'), 'usage: node bench/change-review.mjs [--reread]');
const execute = promisify(execFile);
const bank = await mkdtemp('/private/tmp/sleight-change-review-');
const nonce = basename(bank).split('-').at(-1);
const first = join(bank, `UNDO-${nonce}.txt`);
const second = join(bank, `KEEP-${nonce}.txt`);
const traceFile = join(bank, 'trace.jsonl');
const stages = [];
const bindings = [
  { name: 'reassignment', code: 'app = await cua.getApp("TextEdit")', handle: 'app' },
  { name: 'let', code: 'let app = await cua.getApp("TextEdit")', handle: 'app' },
  { name: 'const', code: 'const x = await cua.getApp("TextEdit")', handle: 'x' },
  { name: 'bare', code: 'await cua.getApp("TextEdit")', handle: 'app' },
];
const trials = rereadMode ? bindings.map((binding, i) => ({ ...binding, path: join(bank, `REREAD-${i + 1}-${nonce}.txt`) })) : [];
const lockAbort = new AbortController();
const pending = new Map();
let child, closed, releaseLiveLock, fixturesOpened = false, dialogOpened = false, interrupted = false, nextId = 0;
const trace = record => appendFile(traceFile, JSON.stringify(record) + '\n');
const fixture = (operation, a = first, b = second) => execute('osascript', ['-l', 'JavaScript', join(ROOT, 'bench/document-scope-fixture.js'), operation, a, b], { timeout: 15000 });
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
  lockAbort.abort();
  for (const p of pending.values()) p.reject(new Error('cancelled'));
  pending.clear();
});
const call = async (name, args) => {
  const result = await request('tools/call', { name, arguments: args }, name === 'review_changes' ? 650000 : 60000);
  const window = windowFromText(texts(result)) ?? null;
  const text = (result?.content ?? []).filter(c => c.type === 'text' && !c.text.includes('## API')).map(c => c.text);
  // Open panels can expose unrelated filenames and the user's sidebar. Keep
  // their header and Open/Cancel buttons in results; full MCP traces stay local.
  stages.push({ name, args, isError: result?.isError ?? false, window,
    text: rereadMode && name === 'js' && !window?.url ? text.map(t => t.split('\n').filter(line =>
      /^Window: /.test(line) || /^\s*\d+ button(?: \([^)]*\))? (?:Open|Cancel)(?:,|$)/.test(line) || result?.isError).join('\n')) : text });
  assert.ok(!result?.isError, texts(result).split('\n## Computer Use')[0]);
  return result;
};

try {
  releaseLiveLock = await acquireLiveLock(undefined, { wait: true, signal: lockAbort.signal });
  assert.ok(!interrupted, 'cancelled');
  console.log('Holding /tmp/sleight-live.lock until this live check finishes cleanup.');
  await writeFile(first, 'UNDO ORIGINAL\n'); await writeFile(second, 'KEEP ORIGINAL\n');
  for (const trial of trials) await writeFile(trial.path, 'alpha beta gamma\n');
  assert.ok(!interrupted, 'cancelled');
  fixturesOpened = true;
  await fixture('open');
  assert.ok(!interrupted, 'cancelled');
  console.log(`Fixtures: ${bank}\nApprove the TextEdit app prompt.${rereadMode ? '' : ' Then choose Undo for the UNDO document and Keep for the KEEP document. These decisions must be made by the user.'}`);
  child = spawn(join(ROOT, 'plugins/sleight/bin/sleight-mcp'), [], { stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SLEIGHT_APPROVAL_SCOPE: 'session', SLEIGHT_APPROVAL_PROMPT: 'dialog',
      SLEIGHT_IDLE_TURN_END_MS: '0', SLEIGHT_CHANGE_REVIEW: '1', SLEIGHT_TRACE: bank } });
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
  if (rereadMode) {
    for (const trial of trials) {
      await fixture('select');
      await call('js', { code: 'let app = await cua.getApp("TextEdit")' });
      dialogOpened = true;
      await call('js', { code: 'await app.pressKey("super+o"); await app.getAXState()' });
      const navigation = await call('js', { code: `await app.pressKey("super+shift+g"); await app.typeText(${JSON.stringify(trial.path)}); await app.pressKey("Return"); await app.getAXState({disableDiffing:true})` });
      const openId = /^\s*(\d+) button(?: \([^)]*\))? Open(?:,|$)/m.exec(texts(navigation))?.[1];
      assert.ok(openId, 'Open button must be identified from the current full state');
      // Match the transcripts: send the reread without awaiting the Open click.
      const opening = call('js', { code: `await app.click(${openId})` });
      const reading = call('js', { code: trial.code });
      const [opened, read] = await Promise.all([opening, reading]);
      assert.equal(windowFromText(texts(opened))?.url, pathToFileURL(trial.path).href);
      dialogOpened = false;
      assert.equal(windowFromText(texts(read))?.url, pathToFileURL(trial.path).href);
      const edited = 'alpha delta gamma\n';
      await call('js', { code: `await ${trial.handle}.selectText(2,"beta"); await ${trial.handle}.typeText("delta"); await ${trial.handle}.pressKey("super+s"); await ${trial.handle}.getAXState()` });
      assert.equal(await readFile(trial.path, 'utf8'), edited);
      const listing = await call('review_changes', { op: 'list' });
      const section = texts(listing).split(/\n\n(?=[^\n]+: \/[^\n]+\nDecision: )/).find(t => t.startsWith(basename(trial.path) + ':'));
      assert.match(section ?? '', /Undo starts at the later copy/);
      assert.match(section ?? '', /-alpha beta gamma\n\+alpha delta gamma/);
      stages.push({ trial: trial.name, path: trial.path, openId: Number(openId), contents: edited, verdict: 'PASS' });
      console.log(`PASS: ${trial.name} reread captured its later copy, edit saved.`);
      await fixture('close', trial.path, trial.path);
    }
    stages.push({ verdict: 'PASS', trials: trials.length });
    console.log(`PASS: ${trials.length}/${trials.length} overlapping Open/reread trials. Evidence: ${bank}`);
  } else {
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
  }
} catch (err) {
  stages.push({ verdict: 'FAIL', error: err.message });
  console.error(`FAIL: ${err.message}. Evidence: ${bank}`); process.exitCode = 1;
} finally {
  if (child && dialogOpened) {
    try {
      const read = await call('js', { code: 'await cua.getApp("TextEdit")' });
      let window = windowFromText(texts(read));
      if (window?.app === 'TextEdit' && !window.url && ['Open', ''].includes(window.title)) {
        const cancelled = await call('js', { code: 'await app.pressKey("Escape"); await app.getAXState({disableDiffing:true})' });
        window = windowFromText(texts(cancelled));
      }
      const ownedURLs = [first, second, ...trials.map(t => t.path)].map(path => pathToFileURL(path).href);
      assert.ok(window?.app === 'TextEdit' && ownedURLs.includes(window.url), 'cleanup must confirm the Open panel closed onto a fixture document');
      stages.push({ dialogCleanup: 'PASS' });
    } catch (err) { stages.push({ dialogCleanup: 'FAIL', error: err.message }); process.exitCode = 1; }
  }
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
  let windowsClosed = !fixturesOpened;
  if (fixturesOpened) {
    try {
      await fixture('close');
      for (const trial of trials) await fixture('close', trial.path, trial.path);
      windowsClosed = !stages.some(stage => stage.dialogCleanup === 'FAIL');
      stages.push({ windowCleanup: windowsClosed ? 'PASS' : 'FAIL' });
    } catch (err) { stages.push({ cleanupError: err.message }); process.exitCode = 1; }
  }
  if (releaseLiveLock && windowsClosed) {
    try { await releaseLiveLock(); stages.push({ liveLockCleanup: 'PASS' }); }
    catch (err) { stages.push({ liveLockCleanup: 'FAIL', error: err.message }); process.exitCode = 1; }
  }
  else if (releaseLiveLock) stages.push({ liveLockCleanup: 'HELD', reason: 'Window cleanup failed; close the fixture windows before removing this lock.' });
  await writeFile(join(bank, 'results.json'), JSON.stringify({ stages, traceFile }, null, 2) + '\n');
}
