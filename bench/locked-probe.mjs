// RT24 plan only. This module has no driver, app, capture or input dependency.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Pure evidence check for the future sitting. It neither samples nor posts.
export function lockedProbePreflight({ postingPath, ownerSaysLocked, rawSessionDictionary } = {}) {
  if (postingPath !== 'pid-targeted') return { abort: true, reason: 'POSTING_PATH_NOT_PID_TARGETED' };
  if (ownerSaysLocked !== true) return { abort: true, reason: 'OWNER_LOCK_NOT_CONFIRMED' };
  if (!rawSessionDictionary || !Object.hasOwn(rawSessionDictionary, 'CGSSessionScreenIsLocked')) {
    return { abort: true, reason: 'LOCK_KEY_ABSENT_WHILE_OWNER_REPORTS_LOCKED' };
  }
  const flag = value => value === true || value === 1;
  if (!flag(rawSessionDictionary.CGSSessionScreenIsLocked) ||
      !flag(rawSessionDictionary.kCGSSessionOnConsoleKey) || !flag(rawSessionDictionary.kCGSessionLoginDoneKey)) {
    return { abort: true, reason: 'LOCKED_CONSOLE_NOT_VERIFIED' };
  }
  return { abort: false };
}

// Pure comparison for the future sitting, never a Calculator read.
export function calculatorDisplayMatches(display, expectedDigits) {
  return typeof display === 'string' && typeof expectedDigits === 'string' && /^[0-9]+$/.test(expectedDigits) &&
    display.replace(/[, \u00a0\u2009\u202f'\u2019]/g, '') === expectedDigits;
}

export function lockedProbePlan({ postingPath = 'pid-targeted' } = {}) {
  if (postingPath !== 'pid-targeted') throw Error('POSTING_PATH_NOT_PID_TARGETED');
  const sessionEvidence = {
    local: {
      path: '~/Library/Caches/sleight-bench/rt24/<sitting-id>/session-dictionaries.jsonl',
      mode: '0600', directoryMode: '0700', publish: false,
      valueTypes: 'Record each original Core Foundation type, distinguishing CFBoolean from CFNumber before JSON conversion.',
      storage: 'Create a new owner-only file in an owner-only directory. Refuse symlinks or unsafe ownership or modes.',
    },
    published: { keys: ['onConsole', 'loginDone', 'sessionLocked', 'hidIdleSeconds'], additionalKeys: false },
  };
  const binding = app => ({ windowId: `<${app}-windowId>`, processStart: `<${app}-processStart>` });
  const request = (method, params) => ({ method, params });
  const cells = ['posted-click', 'typed-text', 'window-capture'];
  const makeTrials = phase => {
    const locked = phase === 'locked';
    const digits = locked ? ['Seven', 'Eight', 'Nine', 'Four', 'Five'] : ['One', 'Two', 'Three', 'Six', 'Zero'];
    const sequence = locked ? '78945' : '12360';
    const marker = trial => `RT24-${locked ? 'L' : 'U'}-${trial} `;
    const expectedText = (locked ? 'LOCKED ' : '') + Array.from({ length: 5 }, (_, i) => marker(i + 1)).join('');
    return cells.flatMap(cell => Array.from({ length: 5 }, (_, index) => {
      const trial = index + 1;
      const params = app => ({ ...binding(app), ...(locked ? { allowLocked: true } : {}) });
      const action = cell === 'posted-click'
        ? request('click', { ...params('calculator'), readId: '<calculator-readId>', args: [{ id: digits[index] }] })
        : cell === 'typed-text'
          ? request('typeText', { ...params('textedit'), readId: '<textedit-readId>', args: [marker(trial)] })
          : request('getScreenshot', params('textedit'));
      return {
        id: `${phase}-${cell}-${trial}`, phase, cell, trial,
        app: cell === 'posted-click' ? 'Calculator' : 'TextEdit',
        before: request('health', {}), request: action, after: request('health', {}),
        expected: { onConsole: true, loginDone: true, sessionLocked: locked,
          ...(cell === 'window-capture' ? { capture: { status: 'ok' } } : { postingPath: 'pid-targeted' }) },
        verification: cell === 'window-capture'
          ? { mode: 'per-capture', expected: `PNG shows only the TextEdit fixture with ${expectedText}and no lock-screen image.` }
          : { mode: locked ? 'one-comparison-after-unlock' : 'one-comparison-before-lock',
            contribution: cell === 'posted-click' ? sequence[index] : marker(trial),
            ...(cell === 'posted-click' ? { compare: 'calculatorDisplayMatches' } : {}),
            expectedFinal: cell === 'posted-click' ? (locked ? '246' : '') + sequence : expectedText },
      };
    }));
  };
  const baselineTrials = makeTrials('unlocked');
  const trials = makeTrials('locked');
  const controls = [
    request('click', { ...binding('calculator'), readId: '<calculator-readId>', args: [{ id: 'AC' }] }),
    request('typeText', { ...binding('textedit'), readId: '<textedit-readId>', args: ['CTRL-1 '] }),
    request('getScreenshot', binding('textedit')),
  ].map((action, index) => ({
    id: `control-${cells[index]}`, phase: 'locked', cell: cells[index],
    before: request('health', {}), request: action, after: request('health', {}),
    expected: { code: 'SCREEN_LOCKED', delivery: 'not-sent', retry: 'safe', captureBytes: 0,
      effect: 'unchanged', onConsole: true, loginDone: true, sessionLocked: true },
  }));
  const snapshot = (block, boundary) => ({
    id: `${block}-${boundary}`, kind: 'session-evidence', block, boundary,
    record: ['health', 'displaySleepState', 'timestamp'],
    localRecord: ['rawSessionDictionary', 'rawSessionValueTypes', 'health', 'displaySleepState', 'timestamp'],
    rawSessionDestination: sessionEvidence.local.path,
    rawSessionDictionary: 'Every key and value from the current session dictionary, without filtering or truncation, in the private local file only.',
    gate: 'lockedProbePreflight', requiredPostingPath: 'pid-targeted', ownerSaysLocked: true,
    abortIf: ['lock-key-absent', 'lock-key-not-true-or-1', 'console-or-login-not-true-or-1', 'posting-path-not-pid-targeted'],
    persistBeforeGate: true,
  });
  const lockedBlocks = [
    { id: 'locked-controls', steps: controls },
    ...cells.map(cell => ({ id: `locked-${cell}`, steps: trials.filter(trial => trial.cell === cell) })),
  ];
  const steps = [
    { id: 'prepare-unlocked', kind: 'fixture-preparation', calculatorDisplay: '0', texteditText: '' },
    ...baselineTrials,
    { id: 'verify-baseline', kind: 'fixture-verification', requireVerifiedTrials: 15,
      abortOnFailure: true, note: 'Verify both final strings and all five captures before locking.' },
    { id: 'prepare-locked', kind: 'fixture-preparation', calculatorDisplay: '246', texteditText: 'LOCKED ',
      note: 'Prepare while unlocked. AC or CTRL-1 leakage must remain visible in the final comparison.' },
    { id: 'owner-lock', kind: 'owner-action', action: 'Owner locks the screen manually.' },
    ...lockedBlocks.flatMap(block => [snapshot(block.id, 'before'), ...block.steps, snapshot(block.id, 'after')]),
    { id: 'owner-unlock', kind: 'owner-action', action: 'Owner unlocks, then verify the fixtures and cleanup.' },
  ];
  const totalTrialRequests = baselineTrials.length + controls.length + trials.length;
  return {
    schema: 'sleight.locked-probe-plan/2', mode: 'plan-only', liveExecution: false,
    totalTrials: trials.length, baselineTrialCount: baselineTrials.length, controlCount: controls.length,
    totalTrialRequests, totalHealthRequests: totalTrialRequests * 2, totalRequests: totalTrialRequests * 3, trialsPerCell: 5,
    sessionEvidence,
    displaySleepCollector: {
      api: 'CGDisplayIsAsleep(displayID)', displayID: 'Fixture display ID recorded while unlocked.',
      readOnly: true, wakesDisplay: false, onFailure: 'unknown',
      note: 'Read the asleep flag for each fixture display before and after every trial and control. Record its display ID, API source and timestamp; an unavailable or disconnected display stays unknown. Never assert display activity or wake it.',
    },
    calculatorComparison: 'Strip thousands separators (commas, spaces, nonbreaking spaces, thin spaces and straight or curly apostrophes) with calculatorDisplayMatches; preserve decimal points and signs. Compare the remaining digits exactly with expectedFinal.',
    transport: { postingPath, allowFallback: false, requiredBinding: 'fixture-pid-and-processStart', abortOnMismatch: true },
    prerequisites: [
      'sleight-arch runs this sitting after the owner agrees to the window and locks the screen manually.',
      'Wait for the lane test marker and the agreed quiet window. Follow the existing live-run ownership rules.',
      'Use only approved disposable Calculator and TextEdit windows. Never target loginwindow or authentication UI.',
      'Posting is pid-targeted only, bound to the fixture PID, so typed text can never reach the lock screen password field. Refuse to plan a trial on any other posting path, including a session-level tap or fallback.',
      'Before locking, verify every digit identifier and AC, fixture caret and all 15 unlocked baseline effects.',
      'Retain processStart, windowId and the latest readId for both windows. Stop on stale identity or read; do not reacquire another window.',
      'Integrate RT2 session health and power scope, RT4/RT5/RT7 handlers, and RT8 owner-only allowLocked admission first.',
      'Provide a raw session dictionary sampler for every locked block boundary. Store all keys, values and original types in the named private local file only, created at mode 0600 under a mode 0700 directory.',
      'Record the source SHA, helper hash, macOS version, grants and elapsed time. Preserve every failure.',
    ],
    procedure: [
      'Run the 15 unlocked baseline trials first. A failed or unverified baseline aborts the locked sitting.',
      'Wait for the owner to lock. Never programmatically lock or unlock.',
      'The first locked step records every raw dictionary key, value and original type in the private local file before any control or trial. Persist it there even when preflight aborts.',
      'Abort if CGSSessionScreenIsLocked is absent while the owner says the screen is locked. Require it present and true or 1 at every locked block boundary.',
      'Record the complete raw dictionary and original value types in the private local file before and after each locked block, including controls. Abort on a failed preflight.',
      'Require onConsole=true, loginDone=true and sessionLocked=true before each locked request and after it.',
      'Run the three planned controls without allowLocked. All three must refuse SCREEN_LOCKED, delivery not-sent, with no input or capture. Stop on any different result.',
      'Use only the separately authorized owner flag for the 15 allowLocked=true trials.',
      'Give each protocol envelope a fresh increasing id, the current nonce and a deadline at most 30 seconds ahead.',
      'Use the read-only CoreGraphics CGDisplayIsAsleep(displayID) collector for display sleep state before and after every trial and control, with the fixture display ID, timestamps and API evidence source. Unknown state stays unknown; never wake the display.',
      'Record capture.status and capture.note per request, using not-requested for input and absent when a refusal has no capture. An unavailable capture is not a successful image.',
      'Record delivery and retry separately from effect. Never repeat input after a missing or ambiguous reply.',
      'Stop on unlock, console change, takeover, identity change, unexpected UI, permission prompt or cleanup failure.',
      'After the owner unlocks, make one end-of-sitting comparison for Calculator and one for TextEdit. Compare the ordered unique contributions to attribute missing or extra input; never claim an intermediate read.',
      'Use calculatorDisplayMatches for both baseline and locked Calculator comparisons, stripping thousands separators before comparing with expectedFinal.',
      'Grade each capture visually against the fixture. SCREEN_LOCKED controls must have zero capture bytes.',
      'Publish all 15 baseline, 3 control and 15 locked outcomes including failures. A stopped or unverified trial stays unverified, never a pass.',
      'Published session records keep only onConsole, loginDone, sessionLocked and hidIdleSeconds, including null for unknown samples. Never publish raw dictionaries, their key lists or value types, private file contents or paths; do not copy them into benchmark results or commits.',
      'sleight-arch closes only the owned fixtures after the owner unlocks and verifies cleanup.',
    ],
    resultFields: ['id', 'phase', 'cell', 'trial', 'healthBefore', 'healthAfter',
      'displaySleepBefore', 'displaySleepAfter', 'displaySleepDisplayID', 'displaySleepEvidenceSource', 'displaySleepTimestampBefore', 'displaySleepTimestampAfter',
      'elapsedMs', 'code', 'delivery', 'retry', 'replyReceived', 'effectAfterUnlock',
      'capture.status', 'capture.note', 'captureBytes', 'captureSHA256', 'verdict', 'reason'],
    acceptance: 'Report baseline and locked N/5 verified effects separately for each cell, plus N/3 refused controls. Session sampling and a sent reply alone prove no effect. Capture status unavailable or missing bytes cannot pass.',
    baselineTrials, controls, trials, steps,
  };
}

export function main(argv = process.argv.slice(2), io = process) {
  if (argv.length !== 1 || argv[0] !== '--dry-run') {
    io.stderr.write('Plan only. Use --dry-run to print JSON. Live execution is unavailable.\n');
    return 64;
  }
  io.stdout.write(JSON.stringify(lockedProbePlan(), null, 2) + '\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
