// Advisory screenshot guidance; this never changes an input event.
// Claude Code shows an image unresized up to a 2000-pixel long edge and scales larger ones to it
// (2026-10-10: a 2200 × 1600 engine screenshot reached Claude at 2000 × 1455 with a 1.10
// multiplier in the image metadata).
const SHOWN_LONG_EDGE = 2000;

export function simulatorScreenshotNote(content, target, sizeOf) {
  const app = target?.app;
  if (typeof app !== 'string' || !app || typeof target.title !== 'string' || !target.title) return undefined;
  const images = content.filter(block => block?.type === 'image');
  if (images.length !== 1 || typeof images[0].data !== 'string') return undefined;
  const size = sizeOf(images[0].data);
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) return undefined;
  const factor = Math.max(size.width, size.height) / SHOWN_LONG_EDGE;
  // At or below the shown size the pixels Claude sees are the engine's, so no scale advice.
  if (factor <= 1) return undefined;
  // A standalone screenshot has no header. The caller must supply its acquired window;
  // any header present must agree with that window before advice can name it.
  for (const block of content) {
    if (block?.type !== 'text') continue;
    for (const header of (block.text ?? '').matchAll(/^Window: ("(?:[^"\\]|\\.)*"), App: ([^\n]+?)\.?$/gm)) {
      try {
        if (JSON.parse(header[1]) !== target.title || header[2] !== app) return undefined;
      } catch { return undefined; }
    }
  }
  return `sleight: ${JSON.stringify(target.title)} in ${app}, engine screenshot ${size.width} × ${size.height} pixels. ` +
    `The engine reads coordinates in these screenshot pixels. Claude Code shows this image smaller, at ` +
    `${Math.round(size.width / factor)} × ${Math.round(size.height / factor)}, so multiply each x and y by ` +
    `${Number(factor.toFixed(4))} before sending coordinates. ` +
    'A missed tap does not establish a scale change.';
}
