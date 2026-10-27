import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function recordTurnEnd(input, env = process.env) {
  const sessionId = env.BENCH_CU_SESSION, nonce = env.BENCH_CU_NONCE;
  if (input?.session_id !== sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId ?? '') || !/^[0-9a-f-]{36}$/i.test(nonce ?? '')) throw new Error('invalid interactive Stop binding');
  // RA1 keeps its login profile across runs, but receipts belong to the temporary session bank.
  const directory = env.BENCH_CU_TURN_DIR ?? dirname(env.CLAUDE_CONFIG_DIR);
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('invalid interactive Stop path');
  const file = join(directory, `turn-${sessionId}.json`);
  if (env.BENCH_CU_TURN_RECEIPT !== file) throw new Error('invalid interactive Stop path');
  for (let path = file; path !== dirname(path); path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('interactive Stop path must not be a symlink');
  }
  writeFileSync(file, JSON.stringify({ sessionId, nonce }) + '\n', { mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { text += data; if (text.length > 16384) process.exit(1); });
  process.stdin.on('end', () => {
    try { recordTurnEnd(JSON.parse(text)); } catch { process.exitCode = 1; }
  });
}
