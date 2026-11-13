// Own-runtime preservation has no clipboard capability. Copy/Cut and a Paste
// shortcut without explicit text cannot satisfy strict text-input semantics.
const commandNames = new Set(['super', 'cmd', 'command', 'meta', 'super_l', 'super_r', 'meta_l', 'meta_r', 'controlormeta']);
const controlNames = new Set(['control', 'ctrl', 'control_l', 'control_r', 'ctrl_l', 'ctrl_r']);
const shiftNames = new Set(['shift', 'shift_l', 'shift_r']);
export const STRICT_TEXT_REFUSAL = 'No qualified direct text operation supports this request. Nothing was sent. Read again and use typeText or setValue where the app supports it.';
export const STRICT_TEXT_CONTROL_REFUSAL = 'Line breaks and tabs require a qualified selected-text insertion path. Unicode key events could submit a form or move focus. Nothing was sent.';
// The Mac text check backs up the resolved native planner. Control Copy/Cut
// reaches that planner; the browser keeps its broader clipboard refusal.
export function isClipboardChord(key, platform = 'browser') {
  const parts = typeof key === 'string' ? key.toLowerCase().split('+').map(part => part.trim()) : [];
  const main = parts.pop()?.replace(/^key([cxv])$/, '$1');
  const control = parts.some(mod => controlNames.has(mod));
  const command = parts.some(mod => commandNames.has(mod));
  const shift = parts.some(mod => shiftNames.has(mod));
  return (command || control && (platform !== 'darwin' || main === 'v')) && ['c', 'x', 'v'].includes(main) ||
    main === 'insert' && (control || shift || parts.includes('controlormeta')) || ['delete', 'del'].includes(main) && shift;
}
export function strictTextRefusal(reason = STRICT_TEXT_REFUSAL) {
  return Object.assign(Error(reason), { code: 'ACTION_UNSUPPORTED', textInput: 'unsupported', delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' });
}
// These integrator-owned entries use the strict native dispatcher. Its key
// planner checks resolved codes, layout modifiers and menu equivalents before
// input. Never infer this capability from raw handle methods.
export function createMacClipboardPreserver({ dispatchPaste, dispatchPressKey } = {}) {
  const wrapped = new WeakMap();
  let closed = false;
  function wrap(raw) {
    if (wrapped.has(raw)) return wrapped.get(raw);
    const proxy = new Proxy(raw, { get(target, name) {
      if (typeof name === 'symbol') return Reflect.get(target, name);
      if (name === 'paste') return async (...args) => {
        if (closed) throw Object.assign(Error('DRIVER_CLOSED'), { code: 'DRIVER_CLOSED', delivery: 'not-sent', retry: 'safe' });
        if (typeof dispatchPaste !== 'function') throw strictTextRefusal();
        return dispatchPaste(target, ...args);
      };
      const value = Reflect.get(target, name);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        if (closed) throw Object.assign(Error('DRIVER_CLOSED'), { code: 'DRIVER_CLOSED', delivery: 'not-sent', retry: 'safe' });
        if (name === 'pressKey') {
          if (isClipboardChord(args[0], typeof dispatchPressKey === 'function' ? 'darwin' : 'browser'))
            throw strictTextRefusal();
          if (typeof dispatchPressKey === 'function') return dispatchPressKey(target, ...args);
        }
        return value.apply(target, args);
      };
    } });
    wrapped.set(raw, proxy); wrapped.set(proxy, proxy); return proxy;
  }
  return Object.freeze({ wrap, reset: async () => {}, close: async () => { closed = true; } });
}
