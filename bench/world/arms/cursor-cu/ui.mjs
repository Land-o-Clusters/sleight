import { hostCall } from './host.mjs';

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
  invoke(action, extra = {}) { return this.call('ui', { owner: this.owner, expectedExecutable: this.expectedExecutable, window: this.window, composerId: this.composerId, action, ...extra }); }
  readiness() { return this.invoke('readiness'); }
  async selection() { return validateUISelection(await this.invoke('selection', { controls: SELECTION_CONTROLS })); }
  async select(value, { signal } = {}) {
    const wanted = validateUISelection(value);
    for (const [key, label] of Object.entries(wanted)) {
      signal?.throwIfAborted();
      const current = await this.selection();
      if (current[key] !== label) {
        await this.invoke('choose', { control: SELECTION_CONTROLS[key], value: label });
        signal?.throwIfAborted();
        await this.invoke('choose', { control: SELECTION_CONTROLS[key], value: label, menuOpen: true });
      }
    }
    signal?.throwIfAborted();
    if (JSON.stringify(await this.selection()) !== JSON.stringify(wanted)) throw Error('Cursor selection did not settle');
  }
  async newChat() { this.composerId = undefined; await this.invoke('new-chat'); }
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
