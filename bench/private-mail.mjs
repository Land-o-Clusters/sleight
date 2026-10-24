import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

function publicTiming(timing) {
  const starts = ['spawn', 'system/init', 'ready-prompt-and-mcp-submit', 'submit', 'outer-drive'];
  const ends = ['final-result-event', 'result-and-idle', 'persisted-clientSettleTime', 'task-check', 'task-cleanup', 'driver-collection'];
  return timing && starts.includes(timing.start) && ends.includes(timing.end) && typeof timing.startupIncluded === 'boolean'
    ? { start: timing.start, end: timing.end, startupIncluded: timing.startupIncluded } : undefined;
}

const ids = new Set(['mimestream-label', 'mimestream-message', 'mimestream-thread', 'mimestream-scroll', 'mimestream-search',
  'slack-read', 'discord-read', 'whatsapp-read']);

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
    seconds: result.seconds, ...(result.agentSeconds !== undefined && { agentSeconds: result.agentSeconds }), agentTiming: result.agentTiming, secondsTiming: result.secondsTiming, turns: result.out?.num_turns,
    expectedHash: hash(task.privateExpected(ctx)), actualHash: hash(answerValue(result.out?.result)) });
}

export function publicPrivateMailRow(row) {
  if (row.arm !== 'sleight' || !ids.has(row.task) || !Number.isSafeInteger(row.run) || row.run < 1) throw new Error('PRIVATE_MAIL_RESULT_INVALID');
  const digest = value => value == null ? null : /^[a-f0-9]{64}$/.test(value) ? value : (() => { throw new Error('PRIVATE_MAIL_RESULT_INVALID'); })();
  return { arm: row.arm, task: row.task, run: row.run, passed: row.passed === true,
    seconds: Number.isFinite(row.seconds) && row.seconds >= 0 ? row.seconds : 0,
    ...(row.agentSeconds !== undefined && { agentSeconds: Number.isFinite(row.agentSeconds) && row.agentSeconds >= 0 ? row.agentSeconds : null }),
    ...(publicTiming(row.agentTiming) && { agentTiming: publicTiming(row.agentTiming) }),
    ...(publicTiming(row.secondsTiming) && { secondsTiming: publicTiming(row.secondsTiming) }),
    turns: Number.isSafeInteger(row.turns) && row.turns >= 0 ? row.turns : null,
    expectedHash: digest(row.expectedHash), actualHash: digest(row.actualHash) };
}

// Preflight and pass-stop rows have no run. They used to crash publication, so a chat pass saved
// nothing (2026-10-10). They're published as a failed phase so the file still shows that the pass
// stopped, with no reason text, which can quote what an app showed. A numbered row still has to be
// a known private task with only digest fields.
export function publicPrivateMailRows(results) {
  return results.map(row => {
    if (Number.isSafeInteger(row.run) && row.run >= 1) return publicPrivateMailRow(row);
    if (row.expectedHash != null || row.actualHash != null || row.answer != null) throw new Error('PRIVATE_MAIL_RESULT_INVALID');
    return { ...(row.arm === 'sleight' && { arm: row.arm }), phase: /^[a-z-]{1,32}$/.test(row.phase ?? '') ? row.phase : 'stop', passed: false };
  });
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
