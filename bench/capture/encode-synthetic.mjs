// Inert on import. No live benchmark, app inventory, capture or UI operation.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    // The repository script owns its one child and forwards cancellation.
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const clean = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', (code, signal) => {
      clean();
      if (code !== 0) reject(Error(`Synthetic encode child failed: ${signal ?? code}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

export async function syntheticEncodeBenchmark({ repeats = 20 } = {}) {
  if (process.platform !== 'darwin') throw Error('Synthetic ImageIO benchmark requires macOS.');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw Error('repeats must be 1..20');
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-encode-synthetic-')));
  try {
    const source = join(root, 'encode.swift'), binary = join(root, 'encode');
    const capture = await readFile(new URL('../../plugins/sleight/lib/mac-driver/native/DriverCapture.swift', import.meta.url), 'utf8');
    const fixture = await readFile(new URL('./encode-synthetic.swift', import.meta.url), 'utf8');
    await writeFile(source, capture + '\n' + fixture);
    await run('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-O', '-module-cache-path', join(root, 'modules'), source, '-o', binary]);
    const result = JSON.parse(await run('/usr/bin/nice', ['-n', '20', binary, String(repeats)]));
    const hash = text => createHash('sha256').update(text).digest('hex');
    return { ...result, nativeSourceSHA256: hash(capture), fixtureSHA256: hash(fixture), compilerOptions: ['-O'],
      host: { platform: process.platform, arch: process.arch, node: process.version } };
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { process.stderr.write('Usage: node bench/capture/encode-synthetic.mjs\n'); process.exitCode = 64; }
  else {
    try { process.stdout.write(JSON.stringify(await syntheticEncodeBenchmark(), null, 2) + '\n'); }
    catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  }
}
