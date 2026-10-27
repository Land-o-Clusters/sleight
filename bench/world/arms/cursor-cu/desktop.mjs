// Attach through scoped Accessibility to the owner's existing Cursor session.
import { existsSync } from 'node:fs';
import { inspectBundle, readLoginReadiness } from './setup.mjs';
import { ordinaryPath, assertDesktopReady, requireOwnerFree } from './contract.mjs';
import { profileState, pendingAppApprovals } from './state.mjs';
import { validateCalibration, verifySelection } from './selection.mjs';
import { inventory, accessibility, installedCursor, sameLaunch, HELPER_BUNDLE, answerCards } from './host.mjs';
import { CursorUI, RUN_SELECTION } from './ui.mjs';
import { bounded } from './bounds.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class DesktopDriver {
  constructor({ inspect = inspectBundle, readState = profileState, exists = existsSync,
    processes = inventory, ax = accessibility, calibrationReader = assertDesktopReady, readiness = readLoginReadiness, ui = new CursorUI(),
    now = Date.now, pause = wait, operationTimeoutMs = 20000 } = {}) {
    Object.assign(this, { inspect, stateReader: readState, exists, processes, ax, calibrationReader, readiness, ui, now, pause, operationTimeoutMs });
    this.helpers = [];
  }
  read(operation, label) { return bounded(operation, label, this.operationTimeoutMs); }
  async mutate(operation, label) {
    const controller = new AbortController();
    const pending = Promise.resolve().then(() => operation(controller.signal));
    // Keep collection separate from the deadline. A timed-out input may still be in flight.
    this.pendingMutation = pending.then(() => true, () => true);
    try { return await this.read(() => pending, label); }
    finally { controller.abort(); }
  }
  async preflight(plan, { calibration = false } = {}) {
    requireOwnerFree(plan);
    this.paths = plan.paths;
    try {
      ordinaryPath(this.paths.app);
      this.pin = this.inspect(this.paths.app);
      const rows = await bounded(() => this.processes(this.paths), 'process read', Math.max(this.operationTimeoutMs, 70000));
      this.identity = installedCursor(rows, this.paths, this.pin.bundleId);
      await this.read(() => this.ui.bind(this.identity, this.paths), 'bind existing window');
      const stored = await this.read(() => this.readiness(this.paths), 'login metadata read');
      const visible = await this.read(() => this.ui.readiness(), 'session readiness read');
      if (!stored.authStored || visible.loggedIn !== true) throw Error('Cursor owner login is unavailable; keep the existing signed-in session open');
      if (visible.busy !== false) throw Error('Cursor owner chat is busy; refuse to interrupt it');
      if (!calibration) this.calibration = validateCalibration(this.calibrationReader(this.paths));
    } catch (error) { if (!this.savedSelection) error.cleanupConfirmed = true; throw error; }
  }
  async open(plan, options = {}) {
    await this.preflight(plan, options);
    options.signal?.throwIfAborted();
    // Keep only selection labels in memory. Never persist owner content or change settings files.
    this.savedSelection = await this.read(() => this.ui.selection(), 'owner selection read');
    this.attached = true;
  }
  async prepareChat(plan, { signal } = {}) {
    const before = await this.readState(), baselineIds = before.composers.map(c => c.composerId);
    await this.foreignGuard(); signal?.throwIfAborted();
    await this.mutate(() => this.ui.newChat(), 'new chat');
    for (let i = 0; i < 50; i++) {
      signal?.throwIfAborted(); await this.foreignGuard();
      const candidates = (await this.readState()).composers.filter(c => !baselineIds.includes(c.composerId));
      if (candidates.length > 1) throw Error('Cursor prepared composer is ambiguous');
      if (candidates.length === 1) {
        this.composerId = candidates[0].composerId;
        await this.read(() => this.ui.bindChat(this.composerId), 'new chat UI binding');
        return { baselineIds };
      }
      await this.pause(100);
    }
    throw Error('Cursor new chat state unavailable');
  }
  setupCalibration(plan, options) { this.prompt = plan.prompt; return this.prepareChat(plan, options); }
  async verifyCalibrationUI() {
    if (JSON.stringify(await this.read(() => this.ui.selection(), 'calibration selection read')) !== JSON.stringify(RUN_SELECTION))
      throw Error('Cursor calibration requires visible Grok 4.7 High, high effort, normal speed, Computer Use / This Mac');
  }
  async setup(plan, options = {}) {
    const bound = await this.prepareChat(plan, options);
    await this.mutate(signal => this.ui.select(RUN_SELECTION, { signal }), 'run selection');
    if (this.calibration) verifySelection((await this.readState()).composers.find(c => c.composerId === this.composerId), this.calibration);
    await this.guard(plan); options.signal?.throwIfAborted();
    await this.mutate(() => this.ui.fill(plan.prompt), 'prompt fill');
    this.prompt = plan.prompt;
    return bound;
  }
  async submit(plan, { signal, onSubmit } = {}) {
    signal?.throwIfAborted(); await this.guard(plan);
    if (!this.composerId || this.prompt !== plan.prompt) throw Error('Cursor prepared prompt binding missing');
    if (this.calibration) verifySelection((await this.readState()).composers.find(c => c.composerId === this.composerId), this.calibration);
    onSubmit(); this.submitted = true;
    await this.mutate(() => this.ui.submit(plan.prompt), 'submit');
  }
  readState() { return this.read(() => this.stateReader(this.paths, { composerId: this.composerId }), 'profile read'); }
  async foreignGuard({ closing = false } = {}) {
    if (!closing && this.exists('/tmp/sleight-hold')) throw Error('sleight-hold appeared; cancel Cursor');
    const rows = await this.read(() => this.processes(this.paths), 'process read');
    const current = installedCursor(rows, this.paths, this.pin?.bundleId);
    if (!sameLaunch(current, this.identity)) throw Error('Cursor installed process changed during the run');
    this.helpers = rows.filter(p => p.bundleId === HELPER_BUNDLE);
    if (this.helpers.length > 1 || this.helpers.some(p => !p.executable.endsWith('/Contents/MacOS/CUCursorService')))
      throw Error('Cursor shared helper is ambiguous');
    return rows;
  }
  async guard(plan) {
    const rows = await this.foreignGuard();
    if (this.exists('/tmp/sleight-hold')) throw Error('sleight-hold appeared; cancel Cursor');
    const owners = [this.identity, ...this.helpers.filter(h => rows.some(p => sameLaunch(h, p)))];
    const expectedExecutable = this.paths.app + '/Contents/MacOS/Cursor';
    const cardVisible = () => this.read(() => this.ui.cardsVisible(), 'card visibility read');
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
          return this.mutate(() => this.ax.press(card, identities, expectedExecutable), 'AX card press');
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
  async cancel(_plan, { calibration = false } = {}) {
    if (!this.attached || !this.composerId || (!this.submitted && !calibration)) return true;
    try {
      if (this.pendingMutation) await this.read(() => this.pendingMutation, 'input collection');
      await this.foreignGuard({ closing: true });
      const before = (await this.readState()).composers.find(c => c.composerId === this.composerId);
      if (calibration && before && before.status !== 'generating' && !before.generatingBubbleIds?.length) return true;
      await this.mutate(() => this.ui.cancel(), 'cancel run chat');
      for (let i = 0; i < 100; i++) {
        const c = (await this.readState()).composers.find(c => c.composerId === this.composerId);
        if (c && c.status !== 'generating' && !c.generatingBubbleIds?.length && await this.read(() => this.ui.idle(), 'chat idle read')) return true;
        await this.pause(100);
      }
    } catch { /* A failed cancellation cannot certify the run is idle. */ }
    this.cancelUnconfirmed = true;
    return false;
  }
  async close() {
    if (!this.savedSelection) return !this.attached;
    try {
      if (this.pendingMutation) await this.read(() => this.pendingMutation, 'input collection before restore');
      await this.foreignGuard({ closing: true });
      // Restore is deliberately independent of the aborted run signal.
      await this.mutate(signal => this.ui.select(this.savedSelection, { signal }), 'restore owner selection');
      const restored = await this.read(() => this.ui.selection(), 'restore verification');
      if (JSON.stringify(restored) !== JSON.stringify(this.savedSelection)) return false;
      return !this.cancelUnconfirmed;
    } catch { return false; }
    // No quit, close-window, close-chat, relaunch, profile writes or helper shutdown.
  }
}
