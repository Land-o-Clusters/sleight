#!/usr/bin/env node
// Owner-operated consent run for EPV3-1. It compiles the native consent host into a temporary folder, shows each
// Electron card once on the owner's screen, and writes a receipt of the choices and results. It launches no app, reads
// no app content and opens no pipe. The app it names is made up, and the debugger store is a file in the same folder.
//   node bench/electron-consent-run.mjs --receipt <path to a new .json file>
// Each step prints the button to click. A different click is recorded as a mismatch, not an error.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUiChannel } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { createConsentUi } from '../plugins/sleight/lib/direct-browser/consent-ui.mjs';
import { createElectronConsent, createGrantStore } from '../plugins/sleight/lib/direct-browser/electron-consent.mjs';
import { swiftModuleCache } from './swift-cache.mjs';

const labels = { once: 'Allow once', session: 'Allow this session', always: 'Always allow', relaunch: 'Quit and reopen', cancel: 'Cancel' };
const doc = name => ({ url: () => 'file:///Applications/Sleight Consent Run.app/Contents/Resources/app/' + name, parentFrame: () => null });

export async function runConsentRun({ ui, directory, say = console.log, wait = 240000 }) {
  const profile = join(directory, 'profile'), path = join(directory, 'grants', 'turbo-electron.json');
  const app = { name: 'Sleight Consent Run', bundleId: 'invalid.sleight.consent-run', signer: 'NOT-A-REAL-TEAM', version: '1.0.0', runtime: 'electron/0.0.0',
    profile, temporary: false, pid: 40001, pidBirth: '1700000000.0',
    executable: '/Applications/Sleight Consent Run.app/Contents/MacOS/Sleight Consent Run', cdhash: '0'.repeat(40) };
  let engine = 'approved', cards = 0;
  const watched = { authenticate: event => ui.authenticate(event), revoke: () => ui.revoke?.(),
    present(...args) { cards++; return ui.present(...args); } };
  const store = createGrantStore({ path });
  const consent = createElectronConsent({ ui: watched, store, engineApproval: () => engine, ttlMs: wait });
  const steps = [], run = async (id, want, work, good) => {
    const before = cards;
    if (want) say(`\nStep ${steps.length + 1} (${id}): a card appears. Click "${labels[want]}".`); else say(`\nStep ${steps.length + 1} (${id}): no card should appear.`);
    const started = Date.now(); let result, error;
    try { result = await work(); } catch (caught) { error = String(caught?.message ?? caught); }
    const shown = cards - before;
    steps.push({ id, wanted: want ?? 'no card', cardsShown: shown, ok: !error && good(result) && shown === (want ? 1 : 0), error, result: result && { status: result.status, scope: result.grant?.scope, persisted: result.persisted, code: result.code }, seconds: Math.round((Date.now() - started) / 100) / 10 });
    say(`  -> ${steps.at(-1).ok ? 'as expected' : 'DIFFERENT from expected'} (${JSON.stringify(steps.at(-1).result ?? error)})`);
    return result;
  };
  const on = (session, turn = 'turn-1') => ({ session, turn });
  await run('debugger-once', 'once', () => consent.requestDebugger(app, on('run-a')), r => r.status === 'granted' && r.grant.scope === 'once');
  await run('debugger-session', 'session', () => consent.requestDebugger(app, on('run-b')), r => r.status === 'granted' && r.grant.scope === 'session');
  await run('debugger-session-next-turn', null, () => consent.requestDebugger(app, on('run-b', 'turn-2')), r => r.status === 'granted' && r.grant.scope === 'session');
  const always = await run('debugger-always', 'always', () => consent.requestDebugger(app, on('run-c')), r => r.status === 'granted' && r.grant.scope === 'always' && r.persisted === true);
  let mode; try { mode = statSync(path).mode & 0o777; } catch {}
  steps.push({ id: 'grant-file-mode', wanted: '0600', ok: mode === 0o600, seconds: 0, result: { mode: mode?.toString(8) } });
  await run('always-new-process', null, () => consent.requestDebugger({ ...app, pid: 40002, pidBirth: '1700000100.0' }, on('run-d')), r => r.status === 'granted' && r.grant.scope === 'always');
  await run('changed-build-cancel', 'cancel', () => consent.requestDebugger({ ...app, version: '2.0.0' }, on('run-e')), r => r.status === 'declined');
  engine = 'refused';
  await run('engine-refused', null, () => consent.requestDebugger({ ...app, version: '3.0.0' }, on('run-f')), r => r.status === 'refused' && r.code === 'ENGINE_APP_APPROVAL_REQUIRED');
  engine = 'approved';
  const ticket = await run('relaunch', 'relaunch', () => consent.requestRelaunch(app, on('run-g')), r => r.status === 'approved');
  const spent = (() => { try { consent.consumeRelaunch(ticket?.ticket, app, on('run-g')); } catch { return false; } try { consent.consumeRelaunch(ticket.ticket, app, on('run-g')); return false; } catch { return true; } })();
  steps.push({ id: 'relaunch-ticket-spends-once', wanted: 'consumed once', ok: spent, seconds: 0 });
  await run('relaunch-cancel', 'cancel', () => consent.requestRelaunch(app, on('run-h')), r => r.status === 'declined');
  if (!always?.grant) return { version: 1, finished: new Date().toISOString(), cards, passed: false, steps };
  // An app document payment card: the same native sheet, naming the document as an app document.
  const binding = consent.bindApp({ grant: always.grant, instance: app, window: { id: 1, epoch: 1 }, brokerEpoch: 1, recipe: { schemes: [], fileRoots: ['/Applications/Sleight Consent Run.app/Contents/Resources/app'] } });
  const place = binding.classify(doc('checkout.html'), 'null');
  const operation = { browserIncarnation: binding.incarnation, brokerEpoch: 1, clientSession: 'run-c', turn: 'turn-1', leaseGeneration: 1, target: 'd1', frame: 'd1', document: 'd1',
    sequence: 1, origin: place.origin, action: 'click', args: { ref: 'e1', key: null, accept: null }, destination: place.origin + '/',
    payment: { item: 'Consent run item', amount: '1.00', payee: 'Consent run shop', method: 'Consent run card' }, principal: place.principal };
  const sheet = createConsentUi({ authenticate: event => ui.authenticate(event) === true, ttlMs: 300000, checkCurrent: () => true,
    present(view, privateOperation) { cards++; ui.present(view.id, { view, operation: privateOperation }, view.choices, event => { try { const ticket = sheet.respond(event); done(ticket ? sheet.consume(ticket, privateOperation) : 'cancelled'); } catch (error) { done('error ' + error.message); } }); } });
  let done; const answered = new Promise(resolve => { done = resolve; });
  await run('app-document-payment-sheet', 'once', async () => { sheet.request(operation); const outcome = await answered; return { status: typeof outcome === 'string' ? outcome : 'consumed' }; }, r => r.status === 'consumed');
  consent.revokeApp(app);
  steps.push({ id: 'revoke-removes-always', wanted: '0 records', ok: store.list().length === 0 && always.grant.current() === false, seconds: 0, result: { records: store.list().length, grantCurrent: always.grant.current() } });
  await run('after-revoke-asks-again', 'cancel', () => consent.requestDebugger({ ...app, pid: 40003, pidBirth: '1700000200.0' }, on('run-i')), r => r.status === 'declined');
  return { version: 1, finished: new Date().toISOString(), cards, passed: steps.every(step => step.ok), steps };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--receipt'), receipt = at > 0 ? process.argv[at + 1] : undefined;
  if (!receipt || !isAbsolute(receipt)) { console.error('usage: node bench/electron-consent-run.mjs --receipt <absolute path of a new .json file>'); process.exit(2); }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-consent-run-')));
  const binary = join(directory, 'consent-host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url)), '-o', binary], { encoding: 'utf8' });
  if (built.status !== 0) { console.error(built.stderr); process.exit(1); }
  const child = spawn(binary, [], { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const ui = createUiChannel({ read: child.stdout, write: child.stdin, onLoss: () => { console.error('consent host closed'); } });
  console.log('A sleight menu bar item appears. Open it, choose "Review sleight request", and click the button named in each step.');
  try {
    const result = await runConsentRun({ ui, directory });
    writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`\n${result.passed ? 'All steps as expected' : 'Some steps differ'}. Receipt: ${receipt}`);
  } finally { ui.close(); child.kill(); rmSync(directory, { recursive: true, force: true }); }
}
