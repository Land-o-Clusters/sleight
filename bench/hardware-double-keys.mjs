// UC1 owner-present reproduction worksheet and offline analyzer.
// This module never starts a client, opens an app, observes input or posts events.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isMainModule } from '../plugins/sleight/lib/main-module.mjs';

export const TOKEN = 'Sleight47|';
const stages = [
  ['baseline', 'Owner closes sleight sessions normally and disables its Claude app plugin. Keep the ChatGPT app as it was.'],
  ['native-only', 'Owner starts one Claude native computer-use session with sleight disabled. Leave it idle.'],
  ['one-idle', 'Owner enables sleight in one host session. Make no computer-use calls.'],
  ['many-idle', 'Owner adds Code sessions one at a time up to five, plus the Claude app plugin. Make no computer-use calls.'],
  ['after-read', 'Owner asks one session for one read of an already-open disposable TextEdit document, then waits for all calls to finish.'],
  ['after-input', 'Owner asks that session to type one distinct fixed token into that disposable document, then waits for all calls to finish.'],
  ['after-close', 'Owner closes those sessions normally one at a time. Repeat the hardware trial and record exact surviving process identities after each close.'],
];

export function reproductionPlan() {
  return {
    mode: 'manual-owner-present', automation: false, token: TOKEN, trialsPerStage: 3,
    instructions: [
      'Schedule a separate owner-present sitting. This script only prints the worksheet or analyzes an explicit evidence file.',
      'Use a fresh unsent Claude draft. Physically type the token once per trial, with brief taps and no held keys. Do not paste or submit it. Clear only that draft by hand.',
      'Record the exact observed token and UTC interval for each trial. Include host, plugin and ChatGPT versions, input source, and physical keyboard identity in private sitting notes.',
      'Before and after each stage, record PID, PPID and start identity for each launcher, probe supervisor, app-health helper and native helper using the approved process inspector. Old start times alone do not prove orphaning.',
      'If permission already exists and the owner approves passive observation, census enabled keyboard filter taps with bench/keyboard-taps.swift. Record tap owner PIDs. Never enable a filter tap or request permission during a trial.',
      'For event-level attribution, a separately reviewed listen-only recorder must count HID and session key downs, source PID/state and repeat flags over the trial interval. Do not log characters, clipboard contents or the owner\'s real chat.',
      'Stop on a system prompt, unexpected input or duplication. Preserve the first failing stage. Compare one session at a time; do not kill every process together.',
      'After a failure, close the implicated session normally, repeat, and only in an agreed sitting recreate that same stage. A clean result from zero sessions is a correlation, not process attribution.',
      'The October automated typeText probe did not exercise physical typing. Do not substitute bench/double-keys.mjs for this worksheet.',
    ],
    stages: stages.map(([id, action]) => ({ id, action })),
    expectedSignatures: [
      'One physical token, exactly doubled in the draft, zero requested input and zero forwarded input: investigate a resident input path or host text handling. A stale helper count alone is insufficient.',
      'HID key-down count equals token length, session count is twice that length, and extra events name a source PID: investigate that poster or tap owner. Align intervals and exclude shortcuts and repeat events.',
      'Both passive streams show one token but the draft doubles: process-directed events or host text/IME handling remain candidates. Session taps do not prove the absence of CGEventPostToPid.',
      'A new enabled keyboard filter tap appears with the failing stage and its removal clears the failure: inspect that PID for a pass-through plus repost path. This still needs a repeat of the same stage.',
      'Two submitted/forwarded tool inputs explain two tool tokens, but cannot explain duplicated hardware typing when no input call runs.',
    ],
    evidence: {
      version: 1,
      trials: [{ stage: 'one-idle', observed: TOKEN, inputCalls: 0, forwardedInputs: 0,
        // Counts are optional. Supply them only from aligned passive recordings.
        hidDown: null, sessionDown: null }],
    },
    limits: 'No live collector is included. Missing passive counts stay unknown. The analyzer never assigns a responsible process.',
  };
}

const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const optionalCount = value => value === undefined || value === null || nonnegative(value);
export function analyzeReproduction(evidence) {
  if (evidence?.version !== 1 || !Array.isArray(evidence.trials) || evidence.trials.length < 1 || evidence.trials.length > 1000)
    throw Error('Expected version 1 and 1..1000 trials.');
  const doubled = [...TOKEN].map(char => char + char).join('');
  const rows = evidence.trials.map((trial, index) => {
    if (!stages.some(([id]) => id === trial?.stage) || typeof trial.observed !== 'string' || trial.observed.length > 128 ||
        !nonnegative(trial.inputCalls) || !nonnegative(trial.forwardedInputs) || !optionalCount(trial.hidDown) || !optionalCount(trial.sessionDown))
      throw Error(`Invalid trial ${index + 1}.`);
    const multiplicity = trial.observed === TOKEN ? 'single' : trial.observed === doubled ? 'doubled' : 'other';
    const idle = trial.inputCalls === 0 && trial.forwardedInputs === 0;
    const countsKnown = nonnegative(trial.hidDown) && nonnegative(trial.sessionDown);
    let signature = 'not-isolated';
    if (multiplicity === 'doubled' && idle) {
      signature = !countsKnown ? 'hardware-doubling-without-requested-input'
        : trial.hidDown === TOKEN.length && trial.sessionDown === 2 * TOKEN.length ? 'extra-session-events'
        : trial.hidDown === TOKEN.length && trial.sessionDown === TOKEN.length ? 'downstream-of-session-observer'
        : 'event-counts-inconclusive';
    }
    return { stage: trial.stage, multiplicity, idle, signature };
  });
  const doubleCount = rows.filter(row => row.multiplicity === 'doubled').length;
  return { trials: rows.length, single: rows.filter(row => row.multiplicity === 'single').length,
    doubled: doubleCount, other: rows.filter(row => row.multiplicity === 'other').length,
    verdict: doubleCount ? 'reproduced-without-process-attribution' : 'not-reproduced', rows };
}

export async function main(argv = process.argv.slice(2), write = text => process.stdout.write(text)) {
  if (!argv.length || argv.length === 1 && argv[0] === '--dry-run') {
    write(JSON.stringify(reproductionPlan(), null, 2) + '\n'); return 0;
  }
  if (argv.length !== 2 || argv[0] !== '--analyze') throw Error('Use --dry-run or --analyze EVIDENCE.json. No live mode exists.');
  const file = await open(argv[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error('Evidence must be a regular JSON file of at most 1 MiB.');
    // A concurrent append cannot turn the bounded read into an unbounded one.
    const bytes = Buffer.alloc(1024 * 1024 + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024) throw Error('Evidence exceeds 1 MiB.');
    write(JSON.stringify(analyzeReproduction(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))), null, 2) + '\n');
    return 0;
  } finally { await file.close(); }
}

if (isMainModule(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`hardware-double-keys: ${error.message}\n`); process.exitCode = 1; }
}
