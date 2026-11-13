// Offline harness diagnostics. No desktop reads or child processes on import.
const fail = code => { throw Object.assign(Error(code), { code }); };
const uint = x => Number.isSafeInteger(x) && x >= 0;

// Removal is a cleanup fact, separate from polling/coverage qualification.
// Call only with schema-checked records from parseGuestLines.
export function observerRemoval(lines, context, invocation) {
  const start = lines[0], end = lines.at(-1);
  return start?.kind === 'start' && end?.kind === 'end' && end.records === lines.length &&
    start.rowToken === context.token && start.rowId === context.row && start.invocation === invocation &&
    lines.every((r, n) => r.seq === n + 1) &&
    end.hookRemoved === true && end.keyboardHookRemoved === true && end.mouseHookRemoved === true;
}

// The readiness marker is not an error code. Keep published records available
// even when the observer process reports a failure after removing its hooks.
export function observerResult(result, text, stopError) {
  if (result.reason || result.cleanup === 'tree-unconfirmed' || result.status !== 0 || result.error || stopError) {
    const coded = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) &&
      value !== 'SLEIGHT_UC3F_OBSERVER_READY' ? value : undefined;
    const stderr = String(result.stderr ?? '').split(/\r?\n/).map(s => s.trim()).filter(coded);
    const detail = { stderr, process: coded(result.error?.code), stop: coded(stopError?.code) };
    const code = stderr.at(-1) ?? detail.process ?? detail.stop ?? 'OBSERVER_PROCESS_FAILED';
    const error = Object.assign(Error(code), { code, observerText: text, detail });
    throw error;
  }
  return text;
}

// Retain setup replies without document text, screenshot bytes or exception text.
// The caller supplies projectReply, which enforces the shared metadata vocabulary.
export async function recordSetup(send, write, name, project) {
  let reply;
  try {
    reply = await send();
  } catch (error) {
    try { write(name, project(error, true)); } catch { /* retain the setup cause if its receipt cannot be written */ }
    throw error;
  }
  write(name, project(reply));
  return reply;
}

export function directReply(raw, target, project) {
  const result = project(raw, raw.ok === false);
  if (raw.ok === true) {
    const window = raw.window;
    result.windowMatched = !window ? null : ['windowId', 'pid', 'processStart'].every(k =>
      target[k] !== undefined && window[k] === target[k]) && typeof window.image === 'string' &&
      typeof target.image === 'string' && window.image.toLowerCase() === target.image.toLowerCase();
  }
  return result;
}

export async function waitFixtureInput({ read, check, sleep, now, finished, sent }) {
  const end = now() + 2000;
  for (;;) {
    await check();
    let fixture;
    try { fixture = await read(); } catch (error) { if (error.code !== 'EBUSY') throw error; }
    if (fixture?.truncated) fail('FIXTURE_LOG_TRUNCATED');
    if (finished()) fail('CANCEL_JOB_ALREADY_FINISHED');
    if (Array.isArray(fixture?.events) && fixture.events.some(e => e.tickMs > sent.tickMs && e.message === 0x102)) return;
    if (now() >= end) fail('CANCEL_INPUT_NOT_OBSERVED');
    await sleep(20);
  }
}

// A receiver snapshot older than the stopped job proves nothing about later
// delivery. Observe a fresh snapshot at least 100 ms after the terminal reply.
export async function stoppedFixture(facts, { read, check, sleep, now, graceMs = 100 }) {
  const job = facts.driver.find(d => d.method === 'typeText' && d.raw?.ok === false &&
    ['USER_STOPPED', 'PERSON_TOOK_OVER', 'SCREEN_LOCKED'].includes(d.raw.code));
  if (!job) return read();
  const end = now() + 2000;
  for (;;) {
    await check();
    const fixture = await read();
    if (fixture.truncated) fail('FIXTURE_LOG_TRUNCATED');
    if (uint(fixture.tickMs) && fixture.tickMs >= job.replyTickMs + graceMs) {
      if (!Array.isArray(fixture.events) || fixture.events.some(e => !uint(e.tickMs) ||
          ![0x100, 0x101, 0x102, 0x104, 0x105].includes(e.message))) fail('FIXTURE_STOP_UNPROVED');
      return { ...fixture, postsAfterStop: fixture.events.filter(e => e.tickMs >= job.replyTickMs).length };
    }
    if (now() >= end) fail('FIXTURE_STOP_UNPROVED');
    await sleep(20);
  }
}

// File failures are counted in memory during polling, then published once per
// distinct path/operation/code at the row boundary, outside the input window.
export function fileFailureRecorder(write) {
  const failures = new Map();
  return {
    record(diagnostic) {
      if (!diagnostic) return;
      const key = JSON.stringify([diagnostic.path, diagnostic.operation, diagnostic.code]);
      const previous = failures.get(key);
      if (previous) { previous.count++; previous.attempt = diagnostic.attempt ?? previous.attempt; }
      else failures.set(key, { ...diagnostic, count: 1 });
    },
    flush() { let n = 0; for (const value of failures.values()) write(`file-io-${++n}.json`, value); failures.clear(); },
  };
}

export function readTelemetryFailure(driver) {
  if (driver.some(d => d.raw?.ok && d.raw.windowMatched === false)) return 'FIXTURE_WINDOW_MISMATCH';
  if (driver.some(d => d.raw?.ok && !d.reply?.window && d.raw?.windowMatched !== true &&
      !['cancel', 'turn-end'].includes(d.method))) return 'DRIVER_TELEMETRY_INCOMPLETE';
}

export function discoveryWindows(windows) {
  return windows.map(w => Object.fromEntries(['windowId', 'pid', 'processStart', 'image', 'className', 'title',
    'coreWindowId', 'framePid', 'frameProcessStart', 'refused'].filter(k => w[k] !== undefined).map(k => [k, w[k]])));
}

// Admission only. Never activate a window or supply input to unlock activation.
export async function requireFixtureForeground(read, write, fixture) {
  const foreground = await read();
  write(foreground);
  if (foreground.isDefault !== true || foreground.windowId !== fixture.windowId || foreground.pid !== fixture.pid ||
      foreground.processStart !== fixture.processStart || foreground.className !== fixture.className ||
      typeof foreground.image !== 'string' || foreground.image.toLowerCase() !== fixture.image.toLowerCase()) {
    throw Object.assign(Error('FOREGROUND_NOT_FIXTURE'), { code: 'FOREGROUND_NOT_FIXTURE', detail: { foreground } });
  }
  return foreground;
}
