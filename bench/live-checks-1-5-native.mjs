import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./live-checks-1-5-native.swift', import.meta.url));
export function createNativeReader({ cacheRoot, signal, execute = promisify(execFile) } = {}) {
  return async (operation, pid) => {
    if (!cacheRoot) return { skipReason: 'Repo-local native reader has no private cache directory' };
    if (!['frontmost', 'windows'].includes(operation) || operation === 'windows' && (!Number.isSafeInteger(pid) || pid < 1))
      return { skipReason: 'Repo-local native reader target unavailable' };
    try {
      const { stdout } = await execute('/usr/bin/swift', ['-module-cache-path', join(cacheRoot, 'native-module-cache'), helper,
        operation, ...(operation === 'windows' ? [String(pid)] : [])], { timeout: 15000, maxBuffer: 1024 * 1024, signal });
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
