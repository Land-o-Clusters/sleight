// Independent benchmark glue. This uses Cursor's ordinary UI and reads its profile;
// no Cursor implementation code, smoke driver, print route or worker route is loaded.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBundle, launchPlan } from './setup.mjs';
import { resolveModel, ordinaryPath, assertDesktopReady } from './contract.mjs';
import { profileState } from './state.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class DesktopDriver {
  constructor({ launch, inspect = inspectBundle, readState = profileState, exists = existsSync } = {}) {
    this.launch = launch; this.inspect = inspect; this.stateReader = readState; this.exists = exists;
  }
  async open(plan, { signal } = {}) {
    assertDesktopReady();
    this.paths = plan.paths; this.inspect(this.paths.app);
    // Persistent profiles are never deleted. Refuse concurrent instances before touching them.
    if (this.exists(join(this.paths.userData, 'SingletonLock'))) throw Error('Cursor benchmark profile is already in use');
    for (const path of [this.paths.home, this.paths.userData, this.paths.extensions, this.paths.helperSupport, this.paths.workspace])
      mkdirSync(ordinaryPath(path), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    const launch = this.launch ?? (await import('playwright-core'))._electron.launch.bind((await import('playwright-core'))._electron);
    this.app = await launch({ ...launchPlan(this.paths), timeout: 30000 });
    const identity = await this.app.evaluate(({ app }) => ({ userData: app.getPath('userData'), home: app.getPath('home'), version: app.getVersion() }));
    if (identity.userData !== this.paths.userData || identity.home !== this.paths.home || identity.version !== '3.27.12')
      throw Error('Cursor launched-copy identity differs from isolated paths or version');
    this.page = await this.app.firstWindow(); this.page.setDefaultTimeout(5000);
    await this.guard(plan);
  }
  async unique(locator, message) {
    const visible = [];
    for (const item of await locator.all()) if (await item.isVisible()) visible.push(item);
    if (visible.length !== 1) throw Error(`${message}: expected one visible control, found ${visible.length}`);
    return visible[0];
  }
  async setup(plan, { signal } = {}) {
    const before = await this.readState(), baselineIds = before.composers.map(c => c.composerId);
    await this.guard(plan); signal?.throwIfAborted();
    // Prefer semantic controls to coordinates or a global URL handler. Unknown UI refuses.
    await (await this.unique(this.page.getByRole('button', { name: /^(New Agent|New Chat)$/ }), 'new agent composer')).click();
    const input = await this.unique(this.page.locator('[contenteditable="true"][role="textbox"], textarea[placeholder*="Ask"]'), 'agent composer');
    // Account-controlled defaults are selected once by the owner. This arm never silently
    // falls back to Auto, a different model, a cloud machine or a code-only attachment.
    await this.unique(this.page.getByText('Computer Use', { exact: true }), 'Computer Use attachment');
    await this.unique(this.page.getByText('This Mac', { exact: true }), 'This Mac target');
    await this.unique(this.page.getByText('Grok 4.7 High', { exact: true }), 'Grok 4.7 High model');
    await input.fill(plan.prompt);
    for (let i = 0; i < 50; i++) {
      signal?.throwIfAborted(); await this.guard(plan);
      const candidates = (await this.readState()).composers.filter(c => !baselineIds.includes(c.composerId) && c.text === plan.prompt);
      if (candidates.length > 1) throw Error('Cursor prepared composer is ambiguous');
      if (candidates.length === 1) {
        resolveModel(candidates[0].modelConfig);
        this.composerId = candidates[0].composerId; this.input = input;
        return { baselineIds };
      }
      await wait(100);
    }
    throw Error('Cursor composer state is unavailable; capture a desktop state sample before qualification');
  }
  async submit(plan, { signal, onSubmit } = {}) {
    signal?.throwIfAborted(); await this.guard(plan);
    if (!this.input || await this.input.innerText() !== plan.prompt) throw Error('Cursor prompt changed before submit');
    // One Enter is the submit boundary. No app input is posted through macOS APIs.
    onSubmit();
    await this.input.press('Enter');
  }
  readState() { return this.stateReader(this.paths); }
  async guard() {
    if (this.exists('/tmp/sleight-hold')) throw Error('sleight-hold appeared; cancel Cursor');
    const dialogs = this.page.getByRole('dialog');
    for (const dialog of await dialogs.all()) if (await dialog.isVisible()) throw Error('Cursor dialog needs owner: ' + (await dialog.innerText()).slice(0, 200));
    // App approvals are not always modal. They remain manual until a live card can
    // supply the bundle id, source and scope to approvalDecision, never by name alone.
    const card = this.page.getByText(/^Allow Cursor to use .+\?$/);
    if (await card.count()) throw Error('Cursor Computer Use app approval needs owner; no calibrated bundle-bound card reader');
  }
  async cancel() {
    if (!this.app) return true;
    // Escape in the bound composer is the ordinary desktop cancel path. Quit and
    // child exit are still required, since a key alone is not cancellation evidence.
    if (this.input && await this.input.isVisible()) await this.input.press('Escape');
    return false;
  }
  async close() {
    if (!this.app) return false;
    const child = this.app.process();
    let exited = child.exitCode !== null;
    const closed = new Promise(resolve => child.once('exit', () => { exited = true; resolve(true); }));
    // Electron's app.quit allows the extension's deactivate hook to shut down the
    // helper. No owner instance is selected by name or bundle id.
    try { await this.app.evaluate(({ app }) => app.quit()); } catch {}
    if (!exited) await Promise.race([closed, wait(15000)]);
    if (!exited) return false;
    // service.json is Cursor's helper liveness receipt. A surviving helper keeps
    // the lock; no global helper or owner's Cursor process is signalled.
    const service = join(this.paths.helperSupport, 'service.json');
    if (this.exists(service)) {
      try {
        const receipt = JSON.parse(readFileSync(ordinaryPath(service), 'utf8'));
        if (receipt.pid) return false;
      } catch { return false; }
    }
    this.app = undefined;
    return true;
  }
}
