// Compile the repository host once, run only its non-drawing dump mode, then remove the owned build directory.
import { helperCompileArgs } from '../../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE, cases } from './plan-cases.mjs';
import { checkReportPath, isMain, ROOT, runChild, writeReport } from './kit.mjs';

export async function captureSwiftPlans(output, { platform = process.platform, execute = runChild } = {}) {
  if (platform !== 'darwin') throw new Error('Swift reference capture requires macOS');
  checkReportPath(output);
  const source = join(ROOT, SOURCE);
  const hashSource = () => createHash('sha256').update(readFileSync(source, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
  const sourceSha256 = hashSource();
  const build = mkdtempSync(join(tmpdir(), 'lane-win0-swift-'));
  try {
    const binary = join(build, 'consent-host');
    const compiled = await execute('/usr/bin/xcrun', helperCompileArgs('consent-host', { sources: [source], binary, moduleCache: join(build, 'modules') }), {
      cwd: ROOT, timeout: 300_000,
    });
    if (compiled.reason || compiled.status !== 0) throw new Error(`Swift compilation failed (${compiled.reason || compiled.status})`);
    const fixture = { schema: 'sleight.windows-ring-fixtures/1', source: SOURCE, sourceSha256,
      referenceMode: '--ring-plan-dump', numericTolerance: 1e-6, cases: [] };
    for (const entry of cases) {
      const result = await execute(binary, ['--ring-plan-dump', ...entry.flags], { cwd: ROOT, timeout: 20_000,
        input: entry.frames.map(frame => JSON.stringify(frame) + '\n').join('') });
      if (result.reason || result.status !== (entry.exitCode ?? 0)) throw new Error(`Swift case failed: ${entry.id}`);
      const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).map(JSON.parse) : [];
      fixture.cases.push({ ...entry, exitCode: result.status, output: lines });
    }
    if (sourceSha256 !== hashSource()) throw new Error('Source changed during capture');
    if (output.endsWith('.gz')) writeFileSync(output, gzipSync(JSON.stringify(fixture) + '\n'), { flag: 'wx', mode: 0o600 });
    else writeReport(output, fixture);
    return { cases: fixture.cases.length, sourceSha256 };
  } finally { rmSync(build, { recursive: true, force: true }); }
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') {
    process.stderr.write('Use --output NEW_FIXTURE_JSON\n'); process.exitCode = 64;
  } else captureSwiftPlans(args[1]).then(report => process.stdout.write(JSON.stringify(report) + '\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
