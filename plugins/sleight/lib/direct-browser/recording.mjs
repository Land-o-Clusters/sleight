import { createRequire } from 'node:module';
import { trustedRead } from './trusted-dom.mjs';
import { assertEndpointRead } from './endpoint-guard.mjs';

// Mask all input, including ordinary text fields, plus opaque embedded surfaces. Never inspect values.
export const RECORDING_MASK = 'input,textarea,select,button,[contenteditable],[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"],iframe,frame,object,embed,canvas,video,[data-sleight-private]';
const require = createRequire(import.meta.url);

export async function captureRecordingFrame(entry, { pages, current, endpoint, sites } = {}) {
  const page = entry.page;
  const check = async () => {
    if (!current() || pages.tab(entry.tab) !== entry || page.isClosed() || entry.state.dialog || entry.state.actionPending ||
        sites?.(page.url())) throw Error('RECORDING_TARGET_UNAVAILABLE');
    // Electron/native windows need their own lease and protected-field evidence. No fallback to desktop capture.
    if (!/^https?:\/\//.test(page.url())) throw Error('RECORDING_TARGET_UNAVAILABLE');
    await assertEndpointRead(page, endpoint);
    if (!current()) throw Error('RECORDING_TURN_ENDED');
  };
  await check();
  const cdp = await page.context().newCDPSession(page);
  let frozen = false;
  try {
    await check();
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true }); frozen = true;
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const size = metrics.cssLayoutViewport;
    if (!size || size.clientWidth * size.clientHeight > 16000000 || size.clientWidth > 10000 || size.clientHeight > 10000)
      throw Error('RECORDING_VIEWPORT_LIMIT');
    // Author shadow trees cannot be fully masked with a CSS locator. UA controls are masked at their host.
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let nodes = 0;
    const inspect = node => {
      if (++nodes > 20000 || node.shadowRoots?.some(root => root.shadowRootType !== 'user-agent')) throw Error('RECORDING_OPAQUE_TREE');
      for (const child of node.children ?? []) inspect(child);
    };
    inspect(root);
    const document = await page.locator(':root').elementHandle({ timeout: 1000 });
    try { if (!document || await trustedRead(document, (el, unused, read) => Document.prototype.getAnimations.call(read(el, 'ownerDocument')).some(a => a.playState === 'running')))
      throw Error('RECORDING_MOTION_UNAVAILABLE'); }
    finally { await document?.dispose(); }
    await check();
    // Playwright paints the masks in its isolated utility world. Scripts stay disabled through pixel capture.
    const png = await page.screenshot({ type: 'png', fullPage: false, scale: 'css', caret: 'hide',
      mask: [page.locator(RECORDING_MASK)], maskColor: '#000000', timeout: 1500 });
    await check();
    if (png.length > 8 * 1024 * 1024) throw Error('RECORDING_IMAGE_LIMIT');
    const { PNG } = require('../../vendor/playwright-core/lib/utilsBundle.js');
    return PNG.sync.read(png, { checkCRC: true });
  } finally {
    // Resume only this owned target, even when Stop revokes the recording while capture awaits.
    let resumeFailed = false;
    try { if (frozen) await cdp.send('Emulation.setScriptExecutionDisabled', { value: false }); }
    catch { resumeFailed = !page.isClosed(); }
    try { await cdp.detach(); }
    finally { if (resumeFailed) throw Error('RECORDING_RESUME_UNCONFIRMED'); }
  }
}
