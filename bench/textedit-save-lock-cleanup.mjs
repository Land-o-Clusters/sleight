import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTextEditCleanup } from './textedit-save-lock-cleanup-run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), source = process.argv[2];
if (!/^docs\/benchmarks\/2026-10-10-save-lock-[0-9]+\.json$/.test(source ?? '')) throw new Error('Expected this investigation\'s published report');
if (process.argv.length > 4 || ![undefined, '--inspect-only'].includes(process.argv[3])) throw new Error('Only --inspect-only is supported');
const inspectOnly = process.argv[3] === '--inspect-only';
const report = { started: new Date().toISOString(), source, cleanupOnly: true, testInput: false, readOnly: inspectOnly };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  const prior = JSON.parse(await readFile(join(root, source), 'utf8'));
  if (!await runTextEditCleanup({ prior, report, inspectOnly, signal: controller.signal })) process.exitCode = 1;
} catch (error) { report.error = error.message; report.lockRetained = report.lockHeld === true; process.exitCode = 1; }
finally {
  report.finished = new Date().toISOString();
  const clean = JSON.stringify(report, null, 2).replaceAll(homedir(), '~');
  const path = join(root, 'docs/benchmarks', `2026-10-10-save-lock-cleanup-${Date.now()}.json`);
  await writeFile(path, clean + '\n'); console.log(`Published ${path.replaceAll(homedir(), '~')}`);
}
