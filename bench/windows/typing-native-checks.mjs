// Fixed, non-drawing C# validation. The kit child helper owns cancellation and cleanup.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild, isMain, ROOT } from './kit.mjs';
import { tapCounts } from './run-checks.mjs';

export const TYPING_NATIVE_JOBS = Object.freeze([
  { file: 'tests/windows-driver-native.test.mjs', pattern: 'synthetic provider|action parser', minimumPass: 2 },
  { file: 'tests/windows-driver-typing-native.test.mjs', minimumPass: 1 },
  { file: 'tests/windows-wcb2e-telemetry-native.test.mjs', minimumPass: 1 },
  { file: 'tests/windows-wcb2e-recovery-native.test.mjs', minimumPass: 2 },
]);
export async function runTypingNativeChecks(dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'win32') throw Error('WINDOWS_REQUIRED');
  const run = dependencies.run ?? runChild;
  const temporary = dependencies.temporary ?? (() => realpathSync(mkdtempSync(join(tmpdir(), 'sleight-native-config-'))));
  const remove = dependencies.remove ?? (path => rmSync(path, { recursive: true, force: true }));
  const results = [];
  for (const job of TYPING_NATIVE_JOBS) {
    const config = temporary();
    try {
      const result = await run(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000',
        ...job.pattern ? ['--test-name-pattern', job.pattern] : [], job.file],
      { cwd: ROOT, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, lowPriority: true,
        timeout: 910000, maxBytes: 4 * 1024 * 1024 });
      results.push({ file: job.file, minimumPass: job.minimumPass, ...result, counts: tapCounts(result.stdout) });
      if (result.status !== 0 || result.signal || result.reason || result.cleanup === 'tree-unconfirmed' ||
          !results.at(-1).counts || results.at(-1).counts.fail || results.at(-1).counts.cancelled ||
          results.at(-1).counts.pass < job.minimumPass) break;
    } finally { remove(config); }
  }
  return { schema: 'sleight.typing-native-checks/1', results, drawing: false,
    passed: results.length === TYPING_NATIVE_JOBS.length && results.every(r => r.status === 0 && !r.signal && !r.reason &&
      r.cleanup !== 'tree-unconfirmed' && r.counts && !r.counts.fail && !r.counts.cancelled && r.counts.pass >= r.minimumPass) };
}
if (isMain(import.meta.url)) runTypingNativeChecks().then(result => {
  console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
