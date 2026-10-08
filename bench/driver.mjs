import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOwned } from './preapproved-process.mjs';

export async function runDriver(command, args, { format = 'json', evidenceDir, onPermissionRefusal, onStdout, ...options } = {}) {
  let buffer = '', refused = false;
  const response = await runOwned(command, args, { ...options, onStdout: data => {
    onStdout?.(data);
    if (format !== 'stream-json' || !onPermissionRefusal || refused) return;
    buffer += String(data);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(event.message?.content)) continue;
      for (const item of event.message.content) {
        if (item.type !== 'tool_result' || item.is_error !== true) continue;
        const text = typeof item.content === 'string' ? item.content :
          (Array.isArray(item.content) ? item.content.map(block => block.text ?? '').join('\n') : '');
        if (text.includes('Browser Use could not complete this action') && /permission request[^\n]*(dismissed|denied)/i.test(text)) {
          refused = true; onPermissionRefusal(); return;
        }
      }
    }
  } });
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
