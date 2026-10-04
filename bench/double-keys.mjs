// A few deterministic typing trials, independent of bench/run.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { probeClient } from './double-keys-client.mjs';

const awayWindow = process.argv[2];
if (!awayWindow || awayWindow.startsWith('--')) throw new Error('An owner-agreed away window is required');
const rawOnly = process.argv.includes('--raw-only');
const execute = promisify(execFile);
const bank = await mkdtemp('/private/tmp/sleight-double-keys-');
const path = join(bank, 'double-keys.txt');
const fixturePath = fileURLToPath(new URL('./double-keys-fixture.js', import.meta.url));
const records = [], trials = [], clients = [];
const report = { started: new Date().toISOString(), awayWindow, rawOnly, bank, trials, records };
const record = entry => records.push({ t: new Date().toISOString(), ...structuredClone(entry) });
const text = reply => (reply?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const fixture = async (op, foreground) => {
  const reply = await execute('/usr/bin/osascript', ['-l', 'JavaScript', fixturePath, op, path, ...(foreground ? [foreground] : [])]);
  record({ event: 'fixture', op, foreground, stdout: reply.stdout });
  return reply.stdout;
};
let cancelled = false, opened = false;
process.once('SIGINT', () => { cancelled = true; void Promise.allSettled(clients.map(client => client.close())); });
const checked = async (client, code) => {
  if (cancelled) throw new Error('cancelled');
  const reply = await client.call('js', { code });
  assert.ok(!reply?.isError, text(reply));
  return reply;
};
const read = async client => {
  const reply = await checked(client, 'app = await cua.getApp("TextEdit")');
  assert.equal(windowFromText(text(reply))?.url, pathToFileURL(path).href, 'engine did not select the owned document');
};
try {
  const server = resolveServer();
  assert.ok(!server.error, server.error);
  report.engineVersion = server.version;
  await writeFile(path, '');
  await fixture('open', 'Calculator'); opened = true;
  const a = await probeClient(server, { relay: !rawOnly, label: rawOnly ? 'direct-A' : 'sleight', record }); clients.push(a);
  await read(a);
  // Every trial retains failures, even when one action errors after posting.
  const trial = async (condition, index, foreground, work) => {
    const entry = { condition, index, foreground, started: new Date().toISOString() };
    trials.push(entry);
    try {
      await a.call('turn_ended', {});
      await fixture('reset', foreground);
      await read(a);
      entry.expected = await work(entry);
    } catch (error) { entry.error = error.message; }
    finally {
      try { entry.after = JSON.parse(await fixture('read')).text; }
      catch (error) { entry.readError = error.message; }
      entry.finished = new Date().toISOString();
      entry.exact = typeof entry.expected === 'string' && entry.after === entry.expected;
      entry.correctMultiplicity = typeof entry.expected === 'string' && typeof entry.after === 'string' &&
        [...entry.after].sort().join('') === [...entry.expected].sort().join('');
      entry.actionErrors = entry.replies?.filter(reply => reply.status === 'rejected').length ?? 0;
      if (!entry.correctMultiplicity || entry.actionErrors) process.exitCode = 1;
      console.log(JSON.stringify(entry));
    }
    if (entry.error || entry.readError) throw new Error(`trial ${condition}/${index} failed`);
  };
  for (let i = 0; i < 3; i++) await trial('one-engine-background', i, 'Calculator', async entry => {
    const token = `A${i}|`; entry.replies = [await checked(a, `await app.typeText(${JSON.stringify(token)})`)]; return token;
  });
  const b = await probeClient(server, { relay: false, label: 'direct-B', record }); clients.push(b);
  await read(b);
  for (let i = 0; i < 3; i++) await trial('two-engines-second-idle', i, 'Calculator', async entry => {
    const token = `C${i}|`; entry.replies = [await checked(a, `await app.typeText(${JSON.stringify(token)})`)]; return token;
  });
  for (let i = 0; i < 3; i++) await trial('two-engines-calculator-foreground', i, 'Calculator', async entry => {
    await checked(b, 'app = await cua.getApp("Calculator")');
    const token = `D${i}|`;
    entry.replies = await Promise.allSettled([
      checked(a, `await app.typeText(${JSON.stringify(token)})`),
      checked(b, 'await app.pressKey("Escape"); await app.pressKey("1")'),
    ]);
    entry.replies = entry.replies.map(r => r.status === 'fulfilled' ? r : { status: r.status, error: r.reason.message });
    return token;
  });
  for (let i = 0; i < 3; i++) await trial('two-engines-textedit-foreground', i, 'TextEdit', async entry => {
    await read(b);
    const first = `E${i}|`, second = `F${i}|`;
    entry.tokens = [first, second];
    entry.replies = await Promise.allSettled([checked(a, `await app.typeText(${JSON.stringify(first)})`),
      checked(b, `await app.typeText(${JSON.stringify(second)})`)]);
    entry.replies = entry.replies.map(r => r.status === 'fulfilled' ? r : { status: r.status, error: r.reason.message });
    return first + second;
  });
  for (let i = 0; i < 3; i++) await trial('two-engines-serialized-textedit', i, 'TextEdit', async entry => {
    await read(b);
    const first = `G${i}|`, second = `H${i}|`; entry.tokens = [first, second];
    entry.replies = [await checked(a, `await app.typeText(${JSON.stringify(first)})`),
      await checked(b, `await app.typeText(${JSON.stringify(second)})`)];
    return first + second;
  });
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  report.cleanup = await Promise.allSettled(clients.map(client => client.close()));
  if (report.cleanup.some(result => result.status === 'rejected')) process.exitCode = 1;
  if (opened) {
    try { await fixture('close'); report.fixtureClosed = true; }
    catch (error) { report.fixtureCloseError = error.message; process.exitCode = 1; }
  }
  report.finished = new Date().toISOString();
  const published = JSON.stringify(report, (_key, value) => value instanceof Error ? { error: value.message } : value, 2)
    .replaceAll(homedir(), '~');
  const resultPath = fileURLToPath(new URL(`../docs/benchmarks/${report.started.slice(0, 10)}-double-keys-${Date.now()}.json`, import.meta.url));
  await writeFile(resultPath, published + '\n');
  console.log(`Published ${resultPath.replaceAll(homedir(), '~')}`);
}
