import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';

const helper = fileURLToPath(new URL('./live-checks-1-5-native.swift', import.meta.url));
// Running the script through `swift` compiled it on every read and took over 15 s cold (both live runs on 2026-10-25
// skipped mailto). Compile it once per source hash into the benchmark's cache, then each read is a plain exec.
const binaryDir = join(homedir(), 'Library/Caches/sleight-bench/live-checks-native');
let compiling;
async function compiled(execute, signal) {
  const hash = createHash('sha256').update(readFileSync(helper)).digest('hex').slice(0, 16);
  const binary = join(binaryDir, 'reader-' + hash);
  if (existsSync(binary)) return binary;
  compiling ??= (async () => {
    mkdirSync(binaryDir, { recursive: true, mode: 0o700 });
    const partial = binary + '.' + process.pid;
    await execute('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', join(homedir(), 'Library/Caches/sleight-bench/swift-module-cache'),
      helper, '-o', partial], { timeout: 180000, maxBuffer: 4 * 1024 * 1024, signal });
    renameSync(partial, binary);
    return binary;
  })().finally(() => { compiling = undefined; });
  return compiling;
}
export function createNativeReader({ cacheRoot, signal, execute = promisify(execFile), compile = compiled } = {}) {
  return async (operation, pid) => {
    if (!cacheRoot) return { skipReason: 'Repo-local native reader has no private cache directory' };
    if (!['frontmost', 'windows'].includes(operation) || operation === 'windows' && (!Number.isSafeInteger(pid) || pid < 1))
      return { skipReason: 'Repo-local native reader target unavailable' };
    try {
      const binary = await compile(execute, signal);
      const { stdout } = await execute(binary, [operation, ...(operation === 'windows' ? [String(pid)] : [])],
        { timeout: 10000, maxBuffer: 1024 * 1024, signal });
      const result = JSON.parse(stdout);
      if (operation === 'frontmost') {
        if (!Number.isSafeInteger(result?.pid) || result.pid < 1 || typeof result.isMail !== 'boolean'
          || !Array.isArray(result.mailWindows) || !result.mailWindows.every(Number.isSafeInteger)) throw Error('invalid metadata');
      } else if (!Array.isArray(result) || !result.every(row => Number.isSafeInteger(row.window)
        && ['X', 'Y', 'Width', 'Height'].every(key => Number.isFinite(row.bounds?.[key])))) throw Error('invalid bounds');
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      return { skipReason: 'Repo-local native reader unavailable (missing Swift, permission, compilation, timeout or invalid metadata); native comparison skipped' };
    }
  };
}
