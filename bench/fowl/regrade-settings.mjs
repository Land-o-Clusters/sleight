// Offline diagnostic only. Reads saved evidence and prints JSON without rewriting the bank or release receipts.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gradeGateTask } from './real-gate-grade.mjs';
import { SETTINGS_TASKS } from './settings-grade.mjs';

export function regradeSettingsBank(bank) {
  const rows = [], totals = { A: { before: 0, after: 0, total: 0 }, B: { before: 0, after: 0, total: 0 } };
  const digest = createHash('sha256');
  for (const name of readdirSync(bank).sort()) {
    const match = /^rerun-chrome-haiku-([AB])-r([1-5])$/.exec(name);
    if (!match) continue;
    const file = join(bank, name, 'results.json'), raw = readFileSync(file);
    digest.update(name).update(raw);
    for (const row of JSON.parse(raw)) {
      const summary = totals[match[1]];
      summary.total++; summary.before += Number(row.outcome.ok);
      let outcome = row.outcome;
      if (SETTINGS_TASKS.has(row.task.name)) {
        const eventsText = readFileSync(join(bank, name, row.task.name, 'events.jsonl'), 'utf8');
        digest.update(row.task.name).update(eventsText);
        // Preserve the recorded runner's checks; only a proven held dialog can replace its submit requirement.
        const runner = { gradeOutcome: () => ({ problems: row.outcome.problems }), gradeSite: () => ({ problems: [] }) };
        outcome = gradeGateTask({ task: row.task, run: row.run, grade: row.grade, site: row.site, eventsText, runner,
          evidence: row.run.evidence, visits: row.navigation?.urls, ownerCheck: row.observation?.ownerCheck });
        if (outcome.settings === 'stopped before every-device settings confirmation') {
          outcome.problems.push(...row.outcome.problems.filter(problem => problem !== 'nothing submitted' && !outcome.problems.includes(problem)));
          outcome.ok = outcome.problems.length === 0;
        }
        const hasDialogs = Array.isArray(row.site?.dialogs), hasPayloads = Array.isArray(row.site?.submissions);
        const decidability = row.grade?.submissions > 0
          ? hasPayloads ? 'saved field grade and task-window payloads' : 'saved field grade only: per-attempt payloads unavailable'
          : hasDialogs && row.site.dialogs.length ? 'fixture dialog records' : 'stop unverified: fixture dialog records unavailable';
        rows.push({ round: name, side: match[1], task: row.task.name, wallMs: row.wallMs,
          before: row.outcome.ok, after: outcome.ok, note: outcome.settings ?? null, problems: outcome.problems,
          decidability, evidence: { dialogRecords: hasDialogs, submissionPayloads: hasPayloads } });
      }
      summary.after += Number(outcome.ok);
    }
  }
  if (rows.length !== 20 || Object.values(totals).some(side => side.total !== 65)) throw Error('expected 10 rounds, 20 settings attempts and 65 trials per side');
  const taskStats = {};
  for (const task of SETTINGS_TASKS) for (const side of ['A', 'B']) {
    const attempts = rows.filter(row => row.task === task && row.side === side);
    const stats = key => {
      const passing = attempts.filter(row => row[key]).map(row => row.wallMs / 1000).sort((a, b) => a - b);
      return { passes: passing.length, trials: attempts.length, median: passing[Math.floor((passing.length - 1) / 2)] ?? null,
        expected: passing.length ? attempts.reduce((sum, row) => sum + row.wallMs / 1000, 0) / passing.length : null };
    };
    (taskStats[task] ??= {})[side] = { before: stats('before'), after: stats('after') };
  }
  return { bank: resolve(bank), evidenceSha256: digest.digest('hex'), totals, taskStats, rows };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error('usage: node bench/fowl/regrade-settings.mjs BANK');
  process.stdout.write(JSON.stringify(regradeSettingsBank(process.argv[2]), null, 2) + '\n');
}
