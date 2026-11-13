// Browser.Bounds is a CDP screen rectangle, not a Win32 HWND or proof of physical monitor coordinates.
// Minimized windows return their restored bounds. A cursor renderer must skip minimized/unknown states and prove PID/HWND,
// desktop, cover, content origin and per-monitor DPI before drawing. Never manufacture displays/exposure here.
export function parseWindowsWindowBounds(value) {
  const bounds = value?.bounds, state = bounds?.windowState === undefined ? 'unknown' : bounds.windowState;
  const coordinate = n => Number.isSafeInteger(n) && Math.abs(n) <= 10000000;
  if (!Number.isSafeInteger(value?.windowId) || value.windowId < 1 || !bounds ||
      !['unknown', 'normal', 'minimized', 'maximized', 'fullscreen'].includes(state) ||
      ![bounds.left, bounds.top, bounds.width, bounds.height].every(coordinate) || bounds.width <= 0 || bounds.height <= 0)
    throw Error('WINDOWS_GEOMETRY_UNPROVED');
  return { windowId: value.windowId, rect: [bounds.left, bounds.top, bounds.width, bounds.height], state, units: 'cdp-bounds' };
}
