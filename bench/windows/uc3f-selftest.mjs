// Guest lifecycle diagnostics. No trial, app input or capture.
import { collectorPlan, fixtureTargets, assertFixture, parseGuestLines } from './uc3f-collect.mjs';

export const SELFTEST_SCHEMA = 'sleight.uc3f-guest-selftest/1';
const fixedCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'SELFTEST_OPERATION_FAILED';

export function guestSelftestPlan() {
  const fixtures = ['notepad', 'wpf', 'cover', 'edge', 'firefox', 'terminal', 'calculator-refused'];
  return [
    ...fixtures.map(target => ({ id: `fixture-${target}`, rowId: 'person-idle', target })),
    ...collectorPlan().map(row => ({ id: `setup-${row.id}`, rowId: row.id })),
    { id: 'setup-person-idle-present', rowId: 'person-idle', presentCases: true },
  ];
}

// Typing metadata diagnostics are opt-in and outside the 27-job suite.
export function guestDiagnosticPlan() {
  return [{ id: 'diagnostic-typing-fixtures', rowId: 'person-idle', typingDiagnostic: true }];
}

export async function runGuestSelftest(o, job, backend) {
  const operations = o.selftestOperations ?? [], fixtures = [];
  let observer, hookRemoved = false, unavailable = false;
  let safetyStop;
  const check = async () => {
    if (safetyStop) throw safetyStop;
    if (o.signal?.aborted) throw Error('COLLECTION_INTERRUPTED');
    await backend.guard();
  };
  const record = async (operation, work, { cleanup = false, skip = false } = {}) => {
    if (skip) { operations.push({ operation, status: 'skip', code: 'DEPENDENCY_UNAVAILABLE' }); return; }
    try {
      if (!cleanup) await check();
      const value = await work();
      operations.push({ operation, status: 'pass', code: 'OK', ...value?.code ? { code: value.code } : {},
        ...Array.isArray(value?.matchedFields) ? { matchedFields: value.matchedFields } : {},
        ...value?.browserRefusal === 'BROWSER_TARGET_REFUSED' ? { browserRefusal: value.browserRefusal } : {} });
      return value;
    } catch (error) {
      operations.push({ operation, status: 'fail', code: fixedCode(error) });
      if (fixedCode(error) === 'FOREIGN_WINDOW') safetyStop = error;
      return undefined;
    }
  };
  const row = collectorPlan([job.rowId])[0];
  if (job.rowId === 'person-idle') row.cases = row.cases.filter(c => job.presentCases ? c.id === 'background-word' : c.id !== 'background-word');
  const targets = job.target ? [job.target] : fixtureTargets(row);
  try {
    await record('preflight', () => backend.preflight());
    const admitted = operations.at(-1).status === 'pass';
    await record('readiness', async () => {
      const ready = await backend.readiness();
      if (ready.unlocked !== true || ready.connected !== true) throw Error('SESSION_UNAVAILABLE');
    });
    await record('desktop', async () => { if ((await backend.desktop())?.isDefault !== true) throw Error('SECURE_DESKTOP_ACTIVE'); });
    let unavailableCode;
    const probes = targets.filter(t => ['edge', 'firefox', 'terminal', 'calculator-refused'].includes(t));
    if (job.rowId === 'browser-refused-renamed' && !probes.includes('edge')) probes.unshift('edge');
    if (admitted) for (const target of probes) {
      const state = await record(`${target}-availability`, () => backend.available(target));
      if (state?.installed === false) { unavailable = true; unavailableCode = target.toUpperCase().replaceAll('-', '_') + '_NOT_INSTALLED'; break; }
      if (state?.installed !== true) { unavailable = true; break; }
    }
    if (unavailable) operations.push({ operation: 'setup', status: 'skip', code: unavailableCode ?? 'DEPENDENCY_UNAVAILABLE' });
    else await record('setup', () => backend.setup(row, { check, register: fixture => {
      assertFixture(fixture, [fixture]);
      fixtures.push(Object.freeze({ ...fixture }));
    } }), { skip: !admitted });
    for (const fixture of fixtures) await record(`identity-${fixture.target}`, async () => assertFixture(await backend.inspect(fixture), fixtures));
    if (job.typingDiagnostic) for (const fixture of fixtures.filter(f => ['notepad', 'wpf'].includes(f.target)))
      await record(`typing-diagnostic-${fixture.target}`, () => backend.typingDiagnostic(fixture));
    // Workers are exercised even after a fixture fails. The observer does not
    // need a fixture, and the injector never receives a go file.
    observer = await record('observer-start', async () => {
      const handle = await backend.startObserver(row, { check });
      observer = handle; // Retain the cleanup handle even on a missed ready line.
      if (handle.ready !== true) throw Error('OBSERVER_NOT_READY');
      return handle;
    }, { skip: !admitted }) ?? observer;
    if (fixtures.length) await record('injector-start-stop', () => backend.selftestInjector(fixtures[0], { check }));
    else operations.push({ operation: 'injector-start-stop', status: 'skip', code: 'DEPENDENCY_UNAVAILABLE' });
  } finally {
    await record('observer-stop', async () => {
      if (!observer) throw Error('OBSERVER_NOT_STARTED');
      const lines = parseGuestLines(await observer.finish(), 'observer'), end = lines.at(-1);
      hookRemoved = end?.kind === 'end' && end.hookRemoved === true && end.keyboardHookRemoved === true && end.mouseHookRemoved === true;
      if (!hookRemoved) throw Error('HOOK_REMOVAL_UNCONFIRMED');
    }, { cleanup: true, skip: !observer });
    await record('close-clients', () => backend.closeClients(), { cleanup: true });
    const end = { schema: SELFTEST_SCHEMA, kind: 'end', job: job.id, trials: 0, sentInputs: 0, hookRemoved,
      code: operations.some(r => r.status === 'fail') ? 'SELFTEST_FAILED' : 'SELFTEST_COMPLETE' };
    await record('end-record', () => backend.writeRaw(job.rowId, [end]), { cleanup: true });
  }
  return { schema: SELFTEST_SCHEMA, job: job.id, operations, hookRemoved, trials: 0 };
}

export function validateSelftestJob(value, job) {
  const required = ['preflight', 'readiness', 'desktop', 'setup', 'observer-start', 'observer-stop',
    'injector-start-stop', 'close-clients', 'end-record'];
  if (value?.schema !== SELFTEST_SCHEMA || value.job !== job.id || value.trials !== 0 || typeof value.hookRemoved !== 'boolean' ||
      !Array.isArray(value.operations) || value.operations.length > 128 || required.some(name => !value.operations.some(r => r.operation === name)) ||
      value.operations.some(r => !/^[a-z][a-z0-9-]{0,63}$/.test(r.operation) || !['pass', 'fail', 'skip'].includes(r.status) ||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(r.code))) throw Error('SELFTEST_REPLY_INVALID');
  return value;
}

export function selftestTable(report) {
  const rows = report.selftest ?? [];
  return ['| Job | Operation | Status | Code |', '| --- | --- | --- | --- |',
    ...rows.flatMap(job => job.operations.map(r => `| ${job.id} | ${r.operation} | ${r.status} | ${r.code} |`))].join('\n') + '\n';
}

export function selftestOutcome(job) {
  if (!job.hookRemoved || job.operations.some(r => r.status === 'fail')) return 'fail';
  return job.operations.some(r => r.operation === 'setup' && r.status === 'skip' && r.code.endsWith('_NOT_INSTALLED')) ? 'skip' : 'pass';
}
