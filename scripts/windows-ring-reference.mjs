// Produce the Windows VM's golden plans from sleight's own Swift host. This
// script owns its compiler and dump children and never launches a UI mode.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsPlannerHash } from './windows-planner-source.mjs';
import { gzipSync } from 'node:zlib';
import { removeTemp } from './temp-leftovers.mjs';
import { ringCases } from '../tests/fixtures/windows-ring-cases.mjs';
import { fixturePng, spriteCases } from '../tests/fixtures/windows-character-fixture.mjs';

if (process.platform !== 'darwin') throw Error('Reference generation requires the macOS Swift host.');
const source = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url));
const output = new URL('../tests/fixtures/windows-ring-reference.json.gz', import.meta.url);
const folder = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'sleight-windows-reference-')));
const cache = join(folder, 'modules'), binary = join(folder, 'consent-host'); mkdirSync(cache);
const characterRoot = join(folder, 'characters'); mkdirSync(characterRoot, { mode: 0o700 });
mkdirSync(join(characterRoot, 'fixture'), { mode: 0o700 });
writeFileSync(join(characterRoot, 'fixture', 'sheet.png'), fixturePng(), { mode: 0o600 });
let child, interrupted;
const stop = signal => { interrupted = signal; child?.kill(signal); };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
async function run(file, args, input = '') {
  if (interrupted) throw Error('Reference generation interrupted.');
  return new Promise((resolve, reject) => {
    const current = child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: characterRoot } });
    let stdout = '', stderr = '', failure;
    const timer = setTimeout(() => { failure = Error('Reference child timed out.'); current.kill(); }, 300000);
    current.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 64 << 20) { failure = Error('Reference output limit.'); current.kill(); } });
    current.stderr.on('data', bytes => { stderr += bytes; });
    current.on('error', error => { failure = error; });
    current.on('close', code => { clearTimeout(timer); child = undefined; if (failure || code !== 0 || interrupted) reject(failure ?? Error(`Reference child exit ${code}: ${stderr}`)); else resolve(stdout); });
    current.stdin.on('error', () => {}); current.stdin.end(input);
  });
}
try {
  await run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache, source, '-o', binary]);
  const cases = {};
  for (const fixture of [...ringCases, ...spriteCases(characterRoot)]) {
    const result = await run(binary, ['--ring-plan-dump', ...fixture.flags], fixture.frames.map(frame => JSON.stringify(frame)).join('\n') + '\n');
    cases[fixture.name] = result.trim().split('\n').map(JSON.parse).map(({ selfMaxRss, handleMs, ...record }) => record);
    if (cases[fixture.name].at(-1)?.idle !== true) throw Error(`Reference did not idle: ${fixture.name}`);
  }
  const bytes = gzipSync(Buffer.from(JSON.stringify({ plannerSha256: windowsPlannerHash(readFileSync(source)), cases })), { level: 9 });
  writeFileSync(output, bytes);
  console.log(JSON.stringify({ cases: Object.keys(cases).length, bytes: bytes.length, effects: Object.values(cases).reduce((n, rows) => n + rows.length, 0) }));
} finally {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
  removeTemp(folder);
}
