// Advisory screenshot guidance; this never changes an input event.
const simulatorApp = app => ['Device Hub', 'DeviceHub', 'com.apple.dt.Devices'].includes(app) ? 'Device Hub'
  : ['Simulator', 'com.apple.iphonesimulator'].includes(app) ? 'Simulator' : undefined;

export function simulatorScreenshotNote(content, target, sizeOf) {
  const app = simulatorApp(target?.app);
  if (!app || typeof target.title !== 'string' || !target.title) return undefined;
  const images = content.filter(block => block?.type === 'image');
  if (images.length !== 1 || typeof images[0].data !== 'string') return undefined;
  const size = sizeOf(images[0].data);
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) return undefined;
  // A standalone screenshot has no header. The caller must supply its acquired window;
  // any header present must agree with that window before advice can name it.
  for (const block of content) {
    if (block?.type !== 'text') continue;
    for (const header of (block.text ?? '').matchAll(/^Window: ("(?:[^"\\]|\\.)*"), App: ([^\n]+?)\.?$/gm)) {
      try {
        if (JSON.parse(header[1]) !== target.title || simulatorApp(header[2]) !== app) return undefined;
      } catch { return undefined; }
    }
  }
  return `sleight: ${JSON.stringify(target.title)} in ${app}, engine screenshot ${size.width} × ${size.height} pixels. ` +
    'Use app.click coordinates in these engine screenshot pixels; if your viewer downscales it, map each axis back to these dimensions once. ' +
    'After tapping a Safari field, read a fresh screenshot and confirm visible focus before typeText. ' +
    'A missed tap does not establish a scale change. Leave Capture Keyboard unchanged.';
}
