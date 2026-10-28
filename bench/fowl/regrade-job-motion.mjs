// Offline only. Read saved job rounds, print JSON, and never rewrite evidence.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gradeJob, jobColors } from '../world/job-fixtures.mjs';

// The private answer descriptor was not saved. Recover order only from a complete,
// canonical fixture completion event, independently of the model's answer.
function recordedExpected(site) {
  const events = site?.events?.filter(event => event.kind === 'motion') ?? [];
  const valid = event => event.reduced === false && Array.isArray(event.phases)
    && event.phases.length === 3 && new Set(event.phases).size === 3
    && event.phases.every(color => Object.hasOwn(jobColors, color));
  if (!events.length || !events.every(event => valid(event)
    && JSON.stringify(event.phases) === JSON.stringify(events[0].phases))) return undefined;
  return { phases: events[0].phases };
}

export function regradeJobMotionBank(bank) {
  const rows = [], digest = createHash('sha256');
  const totals = Object.fromEntries(['fowlbrowser', 'sleight-turbo'].map(arm => [arm, { before: 0, after: 0, total: 0, unverified: 0 }]));
  for (const group of ['jobs', 'jobs-topup']) {
    const root = join(bank, group);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const match = /^fixtures-.+-([1-9]\d*)-(fowlbrowser|sleight-turbo)-job-motion$/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      const relative = `${group}/${entry.name}/round/results.json`;
      const raw = readFileSync(join(bank, relative));
      digest.update(relative).update(raw);
      const recorded = JSON.parse(raw);
      if (!Array.isArray(recorded) || recorded.length !== 1) throw Error(`expected one recorded job-motion row: ${relative}`);
      const row = recorded[0], arm = match[2];
      if (row.task?.worldFixture !== 'job-motion' || row.task.name !== 'job-motion' || row.surface !== arm
        || typeof row.outcome?.ok !== 'boolean' || !Array.isArray(row.outcome.problems)
        || row.outcome.ok !== (row.outcome.problems.length === 0)) throw Error(`invalid recorded job-motion row: ${relative}`);
      const expected = recordedExpected(row.site);
      const fixture = expected ? gradeJob({ task: row.task, site: row.site, expected, answer: row.run?.result?.result }) : null;
      // Replace only the old answer mismatch. Keep all other recorded failures.
      const problems = fixture ? row.outcome.problems.filter(problem => problem !== 'JOB_ANSWER_MISMATCH') : [...row.outcome.problems];
      if (fixture) problems.push(...fixture.problems);
      else problems.push('JM1_EXPECTED_ORDER_UNAVAILABLE');
      if (row.run?.exitCode !== 0) problems.push(`exit ${row.run?.exitCode ?? 'none'}`);
      if (row.run?.timedOut || row.run?.result?.is_error || !row.run?.result) problems.push('agent did not finish successfully');
      const afterProblems = [...new Set(problems)], after = afterProblems.length === 0;
      const summary = totals[arm];
      summary.total++; summary.before += Number(row.outcome.ok); summary.after += Number(after); summary.unverified += Number(!expected);
      rows.push({ round: `${group}/${entry.name}`, arm, repetition: Number(match[1]), wallMs: row.wallMs,
        before: row.outcome.ok, after, beforeProblems: row.outcome.problems, afterProblems,
        expected: expected ?? null, expectedSource: expected ? 'saved canonical fixture motion event' : 'unavailable',
        answer: row.run?.result?.result ?? null });
    }
  }
  return { bank: resolve(bank), status: rows.length ? 'regraded' : 'no recorded job-motion rounds',
    evidenceSha256: digest.digest('hex'), colors: jobColors, totals, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 3) throw Error('usage: node bench/fowl/regrade-job-motion.mjs BANK [BANK ...]');
  process.stdout.write(JSON.stringify(process.argv.slice(2).map(regradeJobMotionBank), null, 2) + '\n');
}
