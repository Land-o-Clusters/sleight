import { hostCall } from './host.mjs';
import { rememberCursorPrivateNames } from './scrub.mjs';

export const RUN_SELECTION = Object.freeze({ model: 'Grok 4.7 High', effort: 'High', speed: 'Normal', attachment: 'Computer Use', target: 'This Mac' });
export const SELECTION_CONTROLS = Object.freeze({ model: 'Select model', effort: 'Reasoning effort', speed: 'Speed', attachment: 'Computer Use', target: 'Computer Use target' });
export function validateUISelection(value) {
  if (!value || Object.keys(value).sort().join() !== Object.keys(SELECTION_CONTROLS).sort().join() ||
    Object.values(value).some(v => typeof v !== 'string' || !v.trim() || v.length > 160 || /[\r\n\0]/.test(v))) throw Error('Cursor selection controls unavailable or ambiguous; supervised UI calibration required');
  return Object.fromEntries(Object.keys(SELECTION_CONTROLS).map(k => [k, value[k]]));
}
export class CursorUI {
  constructor(call = hostCall) { this.call = call; }
  async bind(owner, paths) {
    this.owner = owner; this.expectedExecutable = paths.app + '/Contents/MacOS/Cursor';
    this.window = undefined; this.composerId = undefined;
    this.window = (await this.invoke('bind')).window;
  }
  invoke(action, extra = {}, { timeoutMs = 20000 } = {}) { return this.call('ui', { owner: this.owner, expectedExecutable: this.expectedExecutable, window: this.window, composerId: this.composerId, action, ...extra }, { timeoutMs }); }
  readiness(extra = {}) { return this.invoke('readiness', extra); }
  async accessibilityState(options) {
    const result = await this.invoke('accessibility-state', {}, options);
    rememberCursorPrivateNames(result.privateNames);
    return result.enabled;
  }
  async setAccessibility(enabled, options) { return this.invoke('accessibility-set', { enabled }, options); }
  async bindCurrentChat() { this.composerId = (await this.invoke('bind-current-chat')).composerId; }
  async selection(options) {
    const value = validateUISelection(await this.invoke('selection', { controls: SELECTION_CONTROLS }, options));
    this.lastVerifiedSelection = value; return value;
  }
  async select(value, { signal, restore = false } = {}) {
    const wanted = validateUISelection(value);
    const budget = { timeoutMs: restore ? 60000 : 20000 };
    for (const [key, label] of Object.entries(wanted)) {
      signal?.throwIfAborted();
      for (let attempt = 0; attempt < (restore ? 2 : 1); attempt++) {
        const current = await this.selection(budget);
        if (current[key] === label) break;
        let opened = false;
        try {
          // No abort checkpoint inside this pair. Complete the pick or dismiss our menu.
          await this.invoke('choose', { control: SELECTION_CONTROLS[key], value: label }, budget);
          opened = true;
          await this.invoke('choose', { control: SELECTION_CONTROLS[key], value: label, menuOpen: true }, budget);
          if ((await this.selection(budget))[key] !== label) throw Error('Cursor selection did not settle');
          break;
        } catch (error) {
          // A native refusal before AXPress must not send Escape into an owner's dialog.
          if (opened || error.mutationAttempted !== false) await this.invoke('close-menu', {}, budget);
          try { await this.selection(budget); } catch { this.lastVerifiedSelection = null; }
          if (!restore || attempt === 1) throw error;
        }
      }
    }
    signal?.throwIfAborted();
    if (JSON.stringify(await this.selection(budget)) !== JSON.stringify(wanted)) throw Error('Cursor selection did not settle');
  }
  async newChat() { await this.invoke('new-chat'); }
  async bindChat(composerId) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(composerId)) throw Error('Cursor chat binding invalid');
    await this.invoke('bind-chat', { composerId });
    this.composerId = composerId;
  }
  fill(text) { return this.invoke('fill', { text }); }
  submit(text) { return this.invoke('submit', { text }); }
  cancel() { return this.invoke('cancel'); }
  async idle() { return (await this.invoke('readiness')).busy === false; }
  async cardsVisible() { return (await this.invoke('cards-visible')).visible; }
}
