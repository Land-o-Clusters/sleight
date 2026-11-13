// Executed in the guest's interactive user session. No input or capture method.
import { pathToFileURL } from 'node:url';
import { win32 } from 'node:path';
import { readFileSync } from 'node:fs';

export async function readGuestFixture({ root, state, createClient } = {}) {
  if (process.platform !== 'win32' && !createClient) throw Error('WINDOWS_REQUIRED');
  const factory = createClient ?? (await import(pathToFileURL(win32.join(root, 'plugins/sleight/lib/windows-driver/client.mjs')))).createWindowsDriverClient;
  const client = factory();
  try {
    const inventory = await client.request('getState', {});
    const windows = inventory.windows?.filter(w => w.windowId === state.windowId && w.processStart === state.processStart);
    if (windows?.length !== 1 || !/(^|[\\/])notepad\.exe$/i.test(windows[0].image ?? '')) throw Error('NOTEPAD_NOT_FIXTURE');
    if (inventory.windows.filter(w => w.pid === windows[0].pid).length !== 1 || windows[0].minimized || windows[0].cloaked || windows[0].popup || windows[0].refused) throw Error('GUEST_WINDOW_BLOCKED');
    const result = await client.request('getAXState', { windowId: state.windowId, processStart: state.processStart });
    if (result.window?.windowId !== state.windowId || result.window.processStart !== state.processStart || result.truncated || result.partialTree) throw Error('GUEST_READ_UNCONFIRMED');
    if (!result.text?.includes(state.token)) throw Error('NOTEPAD_NOT_FIXTURE');
    return { windowId: state.windowId, processStart: state.processStart, driverRead: true, readId: result.readId,
      // Only fixture text crosses the boundary; the full tree is not published.
      fixtureTitle: true };
  } finally { await client.close(); }
}
export async function discoverGuestFixture({ root, token, createClient } = {}) {
  if (process.platform !== 'win32' && !createClient) throw Error('WINDOWS_REQUIRED');
  const factory = createClient ?? (await import(pathToFileURL(win32.join(root, 'plugins/sleight/lib/windows-driver/client.mjs')))).createWindowsDriverClient;
  const client = factory();
  try {
    const r = await client.request('getState', {});
    const w = r.windows?.filter(w => (w.title ?? '').includes(token) && /(^|[\\/])notepad\.exe$/i.test(w.image ?? ''));
    if (w?.length !== 1) throw Error('NOTEPAD_NOT_FIXTURE');
    return { windowId: w[0].windowId, processStart: w[0].processStart, token };
  } finally { await client.close(); }
}
if (process.argv[1]?.endsWith('rt31-guest-read.mjs')) {
  const [mode, root, path] = process.argv.slice(2);
  try {
    const state = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    const r = mode === 'discover' ? await discoverGuestFixture({ root, token: state.token }) : mode === 'read' ? await readGuestFixture({ root, state }) : (() => { throw Error('INVALID_OPERATION'); })();
    console.log(JSON.stringify(r));
  } catch { console.error('GUEST_READ_REFUSED'); process.exitCode = 1; }
}
