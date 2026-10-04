// Bounded recovery for a probe document whose scripting read stopped answering.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { probeClient, probeReadCode, probeCleanupPath } from './double-keys-client.mjs';

assert.ok(process.argv[2], 'An owner-agreed away window is required');
const path = probeCleanupPath(process.argv[3]);
const report = { started: new Date().toISOString(), awayWindow: process.argv[2], path, records: [] };
const record = entry => report.records.push({ t: new Date().toISOString(), ...structuredClone(entry) });
const text = reply => (reply?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
let client;
try {
  const server = resolveServer();
  assert.ok(!server.error, server.error);
  report.engineVersion = server.version;
  client = await probeClient(server, { relay: true, record });
  const observed = await client.call('js', { code: probeReadCode('TextEdit') });
  assert.ok(!observed.isError, text(observed));
  assert.equal(windowFromText(text(observed))?.url, pathToFileURL(path).href, 'different document: refuse cleanup');
  const escape = await client.call('js', { code: 'await app.pressKey("Escape")' });
  assert.ok(!escape.isError, text(escape));
  await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript',
    fileURLToPath(new URL('./double-keys-fixture.js', import.meta.url)), 'close', path], { timeout: 30000 });
  report.fixtureClosed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (client) await client.close();
  report.finished = new Date().toISOString();
  const output = fileURLToPath(new URL(`../docs/benchmarks/${report.started.slice(0, 10)}-double-keys-cleanup-${Date.now()}.json`, import.meta.url));
  await writeFile(output, JSON.stringify(report, null, 2).replaceAll(homedir(), '~') + '\n');
  console.log(`Published ${output.replaceAll(homedir(), '~')}`);
}
