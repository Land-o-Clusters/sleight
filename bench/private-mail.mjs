import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

const ids = new Set(['mimestream-label', 'mimestream-message', 'mimestream-thread', 'mimestream-scroll', 'mimestream-search']);

function answerValue(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).join() === 'answer' && typeof parsed.answer === 'string') return parsed.answer;
  } catch {}
  return value;
}

// No salt, raw answer or native receipt leaves this function. Independent runs
// cannot use their hashes to correlate the owner's mail.
export function privateMailResult(task, ctx, result, { arm, run }) {
  const salt = randomBytes(32);
  const hash = value => typeof value === 'string' ? createHash('sha256').update(salt).update(value).digest('hex') : null;
  return publicPrivateMailRow({ arm, task: task.id, run, passed: result.passed === true,
    seconds: result.seconds, turns: result.out?.num_turns,
    expectedHash: hash(task.privateExpected(ctx)), actualHash: hash(answerValue(result.out?.result)) });
}

export function publicPrivateMailRow(row) {
  if (row.arm !== 'sleight' || !ids.has(row.task) || !Number.isSafeInteger(row.run) || row.run < 1) throw new Error('PRIVATE_MAIL_RESULT_INVALID');
  const digest = value => value == null ? null : /^[a-f0-9]{64}$/.test(value) ? value : (() => { throw new Error('PRIVATE_MAIL_RESULT_INVALID'); })();
  return { arm: row.arm, task: row.task, run: row.run, passed: row.passed === true,
    seconds: Number.isFinite(row.seconds) && row.seconds >= 0 ? row.seconds : 0,
    turns: Number.isSafeInteger(row.turns) && row.turns >= 0 ? row.turns : null,
    expectedHash: digest(row.expectedHash), actualHash: digest(row.actualHash) };
}

// The patterns travel over stdin. Quiet literal grep cannot print a matching
// line or expose a label in the process argument vector. Publish atomically
// only after checking the exact bytes destined for the results file.
export function publishPrivateMailResults(file, json, { terms = [], ownerName = '' } = {}) {
  const stage = `${file}.audit-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(stage, `${json}\n`, { mode: 0o600, flag: 'wx' });
    const patterns = [...new Set(['@', ownerName, ...terms].flatMap(value => String(value).split(/\r?\n/)).filter(Boolean))];
    let absent = false;
    try { execFileSync('/usr/bin/grep', ['-F', '-q', '-f', '-', stage], { input: patterns.join('\n') + '\n', stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch (error) { absent = error.status === 1; }
    if (!absent) throw new Error('PRIVATE_MAIL_PUBLICATION_REFUSED');
    renameSync(stage, file);
  } catch (error) { throw new Error(['EPERM', 'EACCES', 'EROFS'].includes(error.code) ? 'PRIVATE_MAIL_RESULTS_WRITE_DENIED' : 'PRIVATE_MAIL_PUBLICATION_REFUSED'); }
  finally { rmSync(stage, { force: true }); }
}
