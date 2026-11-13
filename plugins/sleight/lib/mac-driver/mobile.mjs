import { chromeOnlyTree, screenshotFrame } from '../relay.mjs';
import { normalizeMacAction } from '../repl/arguments.mjs';

export const mobileWindow = window => ['com.apple.ScreenContinuity', 'com.apple.iphonesimulator'].includes(window?.bundleId);
const identity = window => JSON.stringify([window?.windowId, window?.processStart, window?.pid,
  window?.bundleId, window?.title, ...['x', 'y', 'width', 'height'].map(key => window?.bounds?.[key])]);

// Parent-observed, window-bound dimensions only. No worker source rewriting or
// input route of its own: the returned drag still goes through native admission.
export function createMobileScroll() {
  const frames = new Map();
  return {
    observe(result) {
      const window = result?.window;
      if (!mobileWindow(window) || !result.capture && !result.screenshot) return;
      frames.delete(window.windowId);
      if (!result.screenshot) return;
      const frame = screenshotFrame([
        { type: 'text', text: result.capture?.note ?? '' }, { type: 'image', ...result.screenshot },
      ]);
      if (frame && ['x', 'y', 'width', 'height'].every(key => frame.windowBounds[key] === window.bounds?.[key]))
        frames.set(window.windowId, { identity: identity(window), size: [frame.pixelWidth, frame.pixelHeight] });
      if (frames.size > 16) frames.delete(frames.keys().next().value);
    },
    request(method, params, window, tree) {
      const original = { method, params }, frame = frames.get(params?.windowId);
      if (method !== 'scroll' || !mobileWindow(window) || !chromeOnlyTree(tree) ||
          !frame || frame.identity !== identity(window) || window.processStart !== params.processStart) return original;
      // Keep the runtime's argument limits, including positive bounded distance.
      // Invalid calls retain their normal admission/refusal path.
      try { normalizeMacAction('scroll', params.args); } catch { return original; }
      const [, direction, distance] = params.args, size = frame.size;
      const axis = ['up', 'down'].includes(direction) ? 1 : 0;
      const span = Math.min(size[axis] * 0.65, typeof distance === 'number' ? distance * size[axis] * 0.65 : distance.pixels);
      const sign = ['up', 'left'].includes(direction) ? 1 : -1;
      const from = [size[0] * 0.5, size[1] * 0.525], to = [...from];
      from[axis] -= sign * span / 2; to[axis] += sign * span / 2;
      return { method: 'drag', params: { ...params, args: [from, to] } };
    },
    invalidate(params) { frames.delete(params?.windowId); },
    clear() { frames.clear(); },
  };
}

// The relay already uses waitForMatchingScreenshots for chrome-only action
// replies (100 ms intervals, 1500 ms limit). It replaces the last trusted image.
// Suppress that image's old worker copy when assembling the final mobile view.
// Other images and non-mobile views keep their existing display behavior.
export function replacedMobileImage(view, result) {
  const original = view.trusted.content.findLast(item => item.type === 'image');
  const replacement = result.content?.findLast(item => item.type === 'image');
  if (!original || !replacement || original.data === replacement.data) return;
  return view.observations.some(row => mobileWindow(row.window) && chromeOnlyTree(row.text) &&
    row.screenshot?.data === original.data && row.screenshot?.mimeType === original.mimeType) ? original : undefined;
}
