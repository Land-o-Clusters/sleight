import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_CLAUDE = join(homedir(), 'Library/Caches/sleight-bench/evidence');
export const DEFAULT_CODEX = join(homedir(), 'Projects/sleight-wt/race-1017');

function* files(root, name, depth = 0) {
  if (depth > 8 || lstatSync(root).isSymbolicLink()) return;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, name, depth + 1);
    else if (entry.isFile() && entry.name === name) yield path;
  }
}

// Prefer started events: completed events repeat the same Codex call. No caller
// code is executed, and default reports retain only hashes and record numbers.
export async function readCorpus({ claude = DEFAULT_CLAUDE, codex = DEFAULT_CODEX, before = '2026-10-28T07:28:00Z' } = {}) {
  const records = [], counts = { claudeFiles: 0, codexFiles: 0, claude: 0, codex: 0, malformed: 0 };
  const manifest = createHash('sha256');
  for (const [arm, root, name] of [['claude', claude, 'transcript.jsonl'], ['codex', codex, 'events.jsonl']]) {
    for (const file of files(root, name)) {
      if (arm === 'codex' && !file.slice(root.length).includes('codex')) continue;
      const seen = new Set();
      let line = 0, used = false;
      for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        line++;
        let event;
        try { event = JSON.parse(text); } catch { counts.malformed++; continue; }
        const timestamp = event.timestamp ?? event.t;
        if (timestamp && typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp)) && Date.parse(timestamp) > Date.parse(before)) continue;
        let calls = [];
        if (arm === 'claude') {
          if (event.message?.model !== 'claude-haiku-5-5') continue;
          calls = Array.isArray(event.message?.content) ? event.message.content.filter(part => part.type === 'tool_use' && /(?:^|__)js$/.test(part.name ?? '')) : [];
        } else if (event.item?.type === 'mcp_tool_call' && event.item.tool === 'js') calls = [event.item];
        for (const call of calls) {
          if (call.id && seen.has(call.id)) continue;
          const args = call.input ?? call.arguments;
          const code = args?.code ?? args?.command;
          if (typeof code !== 'string') continue;
          if (call.id) seen.add(call.id);
          const sha256 = createHash('sha256').update(code).digest('hex');
          const record = { arm, file: file.slice(root.length + 1), line, sha256, code };
          records.push(record); counts[arm]++; used = true;
          manifest.update(JSON.stringify({ ...record, code: undefined })).update('\n');
        }
      }
      if (used) counts[`${arm}Files`]++;
    }
  }
  return { records, counts, before, manifest: manifest.digest('hex') };
}
