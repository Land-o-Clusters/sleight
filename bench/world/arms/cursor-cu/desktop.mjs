// Independent benchmark glue. This uses Cursor's ordinary UI and reads its profile;
// no Cursor implementation code, smoke driver, print route or worker route is loaded.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBundle, launchPlan } from './setup.mjs';
import { CURSOR_PIN, ordinaryPath, assertDesktopReady } from './contract.mjs';
import { profileState, pendingAppApprovals } from './state.mjs';
import { validateCalibration, verifySelection } from './calibrate.mjs';
import { inventory, accessibility, assertNoForeignCursor, sameLaunch, HELPER_BUNDLE, answerCards } from './host.mjs';
import { bounded } from './bounds.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class DesktopDriver {
  constructor({ launch, inspect = inspectBundle, readState = profileState, exists = existsSync,
    processes = inventory, ax = accessibility, calibrationReader = assertDesktopReady,
    now = Date.now, pause = wait, operationTimeoutMs = 20000, launchTimeoutMs = 30000 } = {}) {
    this.launch = launch; this.inspect = inspect; this.stateReader = readState; this.exists = exists;
    this.processes = processes; this.ax = ax; this.calibrationReader = calibrationReader; this.helpers = [];
    this.now = now; this.pause = pause; this.operationTimeoutMs = operationTimeoutMs; this.launchTimeoutMs = launchTimeoutMs;
  }
  read(operation, label) { return bounded(operation, label, this.operationTimeoutMs); }
  async preflight(plan, { calibration = false } = {}) {
    const rows = await this.read(() => this.processes(plan.paths), 'process read');
    try { assertNoForeignCursor(rows, plan.paths); }
    catch (error) { if (!this.app && !this.partialLaunch) error.cleanupConfirmed = true; throw error; }
    if (rows.some(p => p.bundleId === HELPER_BUNDLE)) throw Object.assign(Error('Cursor benchmark refused: quit your own Cursor first; a pre-existing shared helper cannot be owned by this run'), { cleanupConfirmed: true });
    if (!calibration) this.calibration = validateCalibration(this.calibrationReader(plan.paths));
  }
  async open(plan, { signal, calibration = false } = {}) {
    await this.preflight(plan, { calibration });
    this.paths = plan.paths; this.inspect(this.paths.app);
    // Persistent profiles are never deleted. Refuse concurrent instances before touching them.
    if (this.exists(join(this.paths.userData, 'SingletonLock'))) throw Error('Cursor benchmark profile is already in use');
    for (const path of [this.paths.home, this.paths.userData, this.paths.extensions, this.paths.workspace])
      mkdirSync(ordinaryPath(path), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    const launch = this.launch ?? (await import('playwright-core'))._electron.launch.bind((await import('playwright-core'))._electron);
    this.launchedAt = Date.now();
    this.partialLaunch = true;
    this.app = await bounded(() => launch({ ...launchPlan(this.paths), timeout: this.launchTimeoutMs }), 'launch', this.launchTimeoutMs);
    const identity = await this.read(() => this.app.evaluate(({ app }) => ({ userData: app.getPath('userData'), home: app.getPath('home'), version: app.getVersion() })), 'launch identity read');
    if (identity.userData !== this.paths.userData || identity.home !== this.paths.home || identity.version !== '3.27.12')
      throw Error('Cursor launched-copy identity differs from isolated paths or version');
    const rows = await this.read(() => this.processes(this.paths), 'process read');
    this.identity = rows.find(p => p.pid === this.app.process().pid && p.bundleId === CURSOR_PIN.bundleId &&
      p.executable === launchPlan(this.paths).executablePath && p.launchAt >= Math.floor(this.launchedAt / 1000) * 1000);
    if (!this.identity) throw Error('Cursor launched-copy PID, executable or launch identity unproved');
    await this.foreignGuard();
    this.page = await this.read(() => this.app.firstWindow(), 'first window read'); this.page.setDefaultTimeout(5000);
    if (!calibration) await this.guard(plan);
  }
  async unique(locator, message) {
    const visible = [];
    for (const item of await this.read(() => locator.all(), 'controls read')) if (await this.read(() => item.isVisible(), 'visibility read')) visible.push(item);
    if (visible.length !== 1) throw Error(`${message}: expected one visible control, found ${visible.length}`);
    return visible[0];
  }
  async setup(plan, { signal } = {}) {
    const before = await this.readState(), baselineIds = before.composers.map(c => c.composerId);
    await this.guard(plan); signal?.throwIfAborted();
    // Prefer semantic controls to coordinates or a global URL handler. Unknown UI refuses.
    await (await this.unique(this.page.getByRole('button', { name: /^(New Agent|New Chat)$/ }), 'new agent composer')).click();
    const input = await this.unique(this.page.locator('[contenteditable="true"][role="textbox"], textarea[placeholder*="Ask"]'), 'agent composer');
    // The owner chooses defaults once. Persisted markers are authoritative even when
    // the UI renders the local target as an icon or hides a model parameter in a menu.
    for (let i = 0; i < 50; i++) {
      signal?.throwIfAborted(); await this.guard(plan);
      const candidates = (await this.readState()).composers.filter(c => !baselineIds.includes(c.composerId));
      if (candidates.length > 1) throw Error('Cursor prepared composer is ambiguous');
      if (candidates.length === 1) {
        verifySelection(candidates[0], this.calibration);
        this.composerId = candidates[0].composerId; this.input = input;
        await input.fill(plan.prompt);
        return { baselineIds };
      }
      await wait(100);
    }
    throw Error('Cursor composer state is unavailable; capture a desktop state sample before qualification');
  }
  async submit(plan, { signal, onSubmit } = {}) {
    signal?.throwIfAborted(); await this.guard(plan);
    if (!this.input || await this.read(() => this.input.innerText(), 'prompt read') !== plan.prompt) throw Error('Cursor prompt changed before submit');
    verifySelection((await this.readState()).composers.find(c => c.composerId === this.composerId), this.calibration);
    // One Enter is the submit boundary. No app input is posted through macOS APIs.
    onSubmit();
    this.submitted = true;
    await this.input.press('Enter');
  }
  readState() { return this.read(() => this.stateReader(this.paths), 'profile read'); }
  async foreignGuard({ closing = false } = {}) {
    if (!closing && this.exists('/tmp/sleight-hold')) throw Error('sleight-hold appeared; cancel Cursor');
    const rows = await this.read(() => this.processes(this.paths), 'process read');
    assertNoForeignCursor(rows, this.paths, this.identity);
    if (!closing && !rows.some(p => sameLaunch(p, this.identity))) throw Error('Cursor launched-copy process disappeared');
    const helpers = rows.filter(p => p.bundleId === HELPER_BUNDLE);
    for (const helper of helpers) {
      if (!helper.executable.endsWith('/Contents/MacOS/CUCursorService') || helper.launchAt < Math.floor(this.launchedAt / 1000) * 1000)
        throw Error('Cursor shared helper launch ownership unproved');
      if (!this.helpers.some(p => sameLaunch(p, helper))) this.helpers.push(helper);
    }
    if (helpers.length > 1 || this.helpers.length > 1) throw Error('Cursor shared helper launch is ambiguous');
    return rows;
  }
  async guard(plan) {
    const rows = await this.foreignGuard();
    if (this.exists('/tmp/sleight-hold')) throw Error('sleight-hold appeared; cancel Cursor');
    const owners = [this.identity, ...this.helpers.filter(h => rows.some(p => sameLaunch(h, p)))];
    const expectedExecutable = launchPlan(this.paths).executablePath;
    const cardVisible = async () => {
      let visible = false;
      for (const dialog of await this.read(() => this.page.getByRole('dialog').all(), 'dialogs read')) {
        if (!await this.read(() => dialog.isVisible(), 'dialog visibility read')) continue;
        if (!/^Allow Cursor to use .+\?$/m.test(await this.read(() => dialog.innerText(), 'dialog read')))
          throw Error('Cursor approval stop: unknown dialog');
        visible = true;
      }
      for (const card of await this.read(() => this.page.getByText(/^Allow Cursor to use .+\?$/).all(), 'card locator read'))
        if (await this.read(() => card.isVisible(), 'card visibility read')) visible = true;
      return visible;
    };
    const requestsNow = async () => this.submitted ? pendingAppApprovals(await this.readState(), this.composerId) : [];
    const deadline = this.now() + 2000;
    for (;;) {
      const visible = await cardVisible(), requests = await requestsNow();
      // SQLite can trail the rendered card. With neither signal, avoid a native tree scan.
      if (!requests.length && !visible) return;
      let pressed = 0, unbound = false;
      if (requests.length) {
        const ax = { read: identities => this.read(() => this.ax.read(identities, expectedExecutable), 'AX card read'), press: async (card, identities) => {
          await this.foreignGuard();
          const fresh = await requestsNow();
          if (!requests.some(r => r.bundleId === card.bundleId && r.name === card.name && fresh.some(f =>
            f.toolCallId === r.toolCallId && f.bundleId === r.bundleId && f.name === r.name && f.generationId === r.generationId)))
            throw Error('Cursor approval stop: pending request changed');
          return this.read(() => this.ax.press(card, identities, expectedExecutable), 'AX card press');
        } };
        try { pressed = await answerCards(plan, owners, ax, requests); }
        catch (error) {
          if (error.code !== 'CURSOR_CARD_UNBOUND' || this.now() >= deadline) throw error;
          unbound = true;
        }
        if (!pressed && !visible && !unbound) return;
      }
      if (pressed) {
        // Never press again while a slow card dismisses. Bind every subsequent native read too.
        const clearDeadline = this.now() + 2000;
        for (;;) {
          await this.pause(100); await this.foreignGuard();
          const visible = await cardVisible();
          const remaining = await this.read(() => this.ax.read(owners, expectedExecutable), 'AX card dismissal read');
          if (!visible && !remaining.length) return;
          if (this.now() >= clearDeadline) throw Error('Cursor approval stop: card did not clear after bound AX pass');
        }
      }
      if (this.now() >= deadline) throw Error('Cursor approval stop: unbound card or dialog remains');
      await this.pause(100); await this.foreignGuard();
    }
  }
  async cancel() {
    if (!this.app) return !this.partialLaunch;
    try { if (!(await this.foreignGuard({ closing: true })).some(p => sameLaunch(p, this.identity))) return false; }
    catch { return false; }
    // Escape in the bound composer is the ordinary desktop cancel path. Quit and
    // child exit are still required, since a key alone is not cancellation evidence.
    if (this.input && await this.read(() => this.input.isVisible(), 'cancel visibility read')) await this.read(() => this.input.press('Escape'), 'cancel');
    return false;
  }
  async close() {
    if (!this.app) return !this.partialLaunch;
    // A foreign launch can now be using the shared helper. Leave it untouched and retain the lock.
    try { await this.foreignGuard({ closing: true }); } catch { return false; }
    const child = this.app.process();
    let exited = child.exitCode !== null;
    const closed = new Promise(resolve => child.once('exit', () => { exited = true; resolve(true); }));
    // Electron's app.quit allows the extension's deactivate hook to shut down the
    // helper. No owner instance is selected by name or bundle id.
    try { await this.read(() => this.app.evaluate(({ app }) => app.quit()), 'quit'); }
    catch (error) { if (/timeout/.test(error.message)) return false; }
    if (!exited) await Promise.race([closed, wait(15000)]);
    if (!exited) return false;
    // The copy's ordinary quit owns extension deactivation. Never signal the shared helper.
    for (let i = 0; i < 150; i++) {
      const rows = await this.read(() => this.processes(this.paths), 'cleanup process read');
      if (!rows.some(p => sameLaunch(p, this.identity) || this.helpers.some(h => sameLaunch(h, p)) || p.bundleId === HELPER_BUNDLE)) {
        this.app = undefined;
        this.partialLaunch = false;
        return true;
      }
      await wait(100);
    }
    return false;
  }
}
