import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOwned } from './preapproved-process.mjs';

export async function runDriver(command, args, { format = 'json', evidenceDir, ...options } = {}) {
  const response = await runOwned(command, args, options);
  let out;
  try {
    out = format === 'stream-json'
      ? response.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(event => event.type === 'result')
      : JSON.parse(response.stdout);
  } catch { out = undefined; }
  if (evidenceDir) writeFileSync(join(evidenceDir, 'transcript.jsonl'), response.stdout, { mode: 0o600 });
  return { code: response.exit.code, out, stderr: response.stderr.slice(-2000), groupClean: response.groupClean,
    timedOut: response.timedOut, cancelled: response.cancelled, spawnError: response.spawnError };
}
