// Audits local traces without printing or publishing their code, values, titles or paths.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnJournal } from '../plugins/sleight/lib/turn-receipts.mjs';

export function auditRecordedTraces(root = join(tmpdir(), 'sleight-bench')) {
  const report = { files: 0, calls: 0, literalInputs: 0, checkedInputs: 0, leaks: 0, truncatedCode: 0, parseFailures: 0 };
  if (!existsSync(root)) return report;
  for (const pass of readdirSync(root).filter(name => /^2026-10-1/.test(name))) {
    for (const task of readdirSync(join(root, pass)).filter(name => name.startsWith('sleight-'))) {
      const directory = join(root, pass, task);
      for (const file of readdirSync(directory).filter(name => /^trace-.*\.jsonl$/.test(name))) {
        report.files++;
        const journal = new TurnJournal();
        const secrets = new Set();
        for (const line of readFileSync(join(directory, file), 'utf8').split('\n').filter(Boolean)) {
          let event;
          try { event = JSON.parse(line); } catch { report.parseFailures++; continue; }
          const msg = event.msg;
          if (event.direction === 'to-server' && msg?.method === 'tools/call' && msg.params?.name !== 'turn_ended') {
            report.calls++;
            const code = msg.params?.arguments?.code ?? '';
            if (/…\(\d+\)$/.test(code)) report.truncatedCode++;
            // Independent literal oracle. No eval, and no assertion prints a source string.
            for (const match of code.matchAll(/\.(?:typeText|paste|selectText|setValue)\(\s*(?:\d+\s*,\s*)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$\\]*`)/g)) {
              report.literalInputs++;
              let value;
              try { value = match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1).replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'); }
              catch { continue; }
              if (value.length >= 3) { secrets.add(value); report.checkedInputs++; }
            }
            journal.request(msg);
          } else if (event.direction === 'to-client' && msg?.method === undefined) journal.reply(msg);
        }
        const receipt = JSON.stringify(journal.finish({ review: true }));
        for (const value of secrets) if (receipt.includes(value) || receipt.includes(JSON.stringify(value).slice(1, -1))) report.leaks++;
      }
    }
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = auditRecordedTraces();
  console.log(JSON.stringify(report, null, 2));
  if (report.leaks || report.parseFailures || !report.files) process.exitCode = 1;
}
