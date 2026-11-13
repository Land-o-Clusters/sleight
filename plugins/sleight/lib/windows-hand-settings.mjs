import { handConfigPath, handSetting } from './hand/settings.mjs';
import { validWindowsHand } from './windows-settings-data.mjs';
import { createWindowsFileWorker } from './platform/win32-files.mjs';

// Native reads stay off the synchronous MCP path. An expired or unproved snapshot draws nothing.
export function createWindowsHandSettingReader({ worker = createWindowsFileWorker(), path = handConfigPath(undefined, { platform: 'win32' }),
  env = process.env, now = Date.now } = {}) {
  let file = { state: 'unsafe' }, checked = -Infinity, obtained = -Infinity, pending, closed = false, timer;
  const refresh = () => {
    if (closed || pending) return pending;
    checked = now();
    pending = Promise.resolve().then(() => worker.operate({ operation: 'read', path })).then(reply => {
      if (reply.ok !== true) throw Error('WINDOWS_FILE_UNSAFE');
      if (reply.absent) file = { state: 'absent' };
      else {
        if (typeof reply.text !== 'string' || Buffer.byteLength(reply.text) > 4096) throw Error('WINDOWS_FILE_UNSAFE');
        const value = validWindowsHand(JSON.parse(reply.text));
        file = { ...value, state: value.enabled ? 'on' : 'off' };
      }
      obtained = now();
    }).catch(() => { file = { state: 'unsafe' }; }).finally(() => { pending = undefined; });
    return pending;
  };
  const reader = () => {
    const at = now();
    if (!closed && (at < checked || at - checked >= 250)) refresh();
    const value = handSetting({ platform: 'win32', env, path,
      read: () => !closed && at >= obtained && at - obtained <= 1000 ? file : { state: 'unsafe' } });
    return { ...value, style: ['ring', 'seam', 'sprite'].includes(value.style) ? value.style : 'ring' };
  };
  reader.ready = async () => {
    await (pending ?? refresh());
    if (!closed && !timer) { timer = setInterval(refresh, 250); timer.unref?.(); }
  };
  reader.close = async () => { closed = true; clearInterval(timer); await worker.close(); await pending; };
  Object.defineProperty(reader, 'cachedHandSetting', { value: true });
  return reader;
}
