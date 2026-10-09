// The JavaScript the mod runs in the computer-use engine's session (through
// the `js` tool) to draw its pane. It must stay self-contained: it runs in the
// engine, not here. snapshotCode() fills in the app and the frame size.
//
// It writes one line, `SLEIGHT_FRAME <json>`: the app's screenshot as
// terminal cells (upper half blocks, two pixels per cell) for a terminal pane,
// or else as an image small enough to embed in an SVG. Only one, to keep the
// result small. The engine's sandbox can't load `sharp`, so it decodes with
// the bundled pure-JS jpeg-js and pngjs.

const SNAPSHOT_JS = `await (async () => {
  // Claude Code replaces an MCP result over its token limit (25,000 by default)
  // with a notice, and base64 counts heavily: a 51,135-character image never
  // reached the desktop pane (2026-10-08). So the image stays near 16,000.
  const APP = __APP__, COLS = __COLS__, ROWS = __ROWS__, TERMINAL = __TERMINAL__, MAX_IMAGE_B64 = 16000;
  const app = await cua.getApp(APP);
  const shot = Buffer.from(await app.getScreenshot({ emit: false }));
  const isJpeg = shot[0] === 0xff && shot[1] === 0xd8;
  // A desktop image that fits needs dimensions, not decoded pixels. Read PNG's IHDR or JPEG's
  // frame header; unsupported or truncated headers fall through to the existing decoder.
  const dimensions = () => {
    if (!isJpeg) {
      if (shot.length >= 33 && shot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          shot.readUInt32BE(8) === 13 && shot.toString('ascii', 12, 16) === 'IHDR') {
        return { width: shot.readUInt32BE(16), height: shot.readUInt32BE(20) };
      }
      return;
    }
    let at = 2;
    while (at < shot.length) {
      if (shot[at++] !== 0xff) return;
      while (shot[at] === 0xff) at++;
      const marker = shot[at++];
      if (marker === 0xda || marker === 0xd9 || at + 2 > shot.length) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = shot.readUInt16BE(at);
      if (length < 2 || at + length > shot.length) return;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: shot.readUInt16BE(at + 5), height: shot.readUInt16BE(at + 3) };
      }
      at += length;
    }
  };
  if (!TERMINAL && Math.ceil(shot.length / 3) * 4 <= MAX_IMAGE_B64) {
    const size = dimensions();
    if (size?.width > 0 && size?.height > 0) {
      const scale = Math.max(size.width / COLS, size.height / (ROWS * 2));
      const columns = Math.max(1, Math.min(COLS, Math.round(size.width / scale)));
      const rows = Math.ceil(Math.max(2, Math.min(ROWS * 2, Math.round(size.height / scale))) / 2);
      nodeRepl.write('SLEIGHT_FRAME ' + JSON.stringify({ app: APP, ...size,
        columns, rows, image: { mime: isJpeg ? 'image/jpeg' : 'image/png', base64: shot.toString('base64') } }));
      return;
    }
  }
  const decoded = isJpeg
    ? (await import('jpeg-js')).default.decode(shot, { useTArray: true })
    : (await import('pngjs')).PNG.sync.read(shot);
  const { width, height, data } = decoded;

  // Fit the screenshot into COLS x ROWS*2 pixels, keeping its aspect ratio,
  // averaging each source block.
  const scale = Math.max(width / COLS, height / (ROWS * 2));
  const outW = Math.max(1, Math.min(COLS, Math.round(width / scale)));
  const outH = Math.max(2, Math.min(ROWS * 2, Math.round(height / scale)));
  const px = (x, y) => {
    const x0 = Math.floor(x * width / outW), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / outW));
    const y0 = Math.floor(y * height / outH), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / outH));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * width + xx) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
  };
  const rows = Math.ceil(outH / 2);
  const cells = Buffer.alloc(TERMINAL ? outW * rows * 12 : 0);
  if (TERMINAL) for (let r = 0; r < rows; r++) for (let c = 0; c < outW; c++) {
    const o = (r * outW + c) * 12;
    cells.writeUInt32LE(0x2580, o);
    cells.writeUInt32LE(px(c, r * 2), o + 4);
    cells.writeUInt32LE(r * 2 + 1 < outH ? px(c, r * 2 + 1) : 0x01000000, o + 8);
  }

  let image = { mime: isJpeg ? 'image/jpeg' : 'image/png', base64: shot.toString('base64') };
  if (TERMINAL) image = undefined;
  else if (image.base64.length > MAX_IMAGE_B64) {
    // Too big to embed: re-encode as a JPEG, from 1.5 times the 320 px the desktop
    // pane draws, smaller and rougher until it fits.
    const { encode } = (await import('jpeg-js')).default;
    for (const [maxW, quality] of [[480, 70], [400, 60], [320, 55], [240, 50], [160, 45], [96, 40], [48, 35]]) {
      const w = Math.min(width, maxW), h = Math.max(1, Math.round(height * w / width));
      const small = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const si = (Math.floor(y * height / h) * width + Math.floor(x * width / w)) * 4, di = (y * w + x) * 4;
        small[di] = data[si]; small[di + 1] = data[si + 1]; small[di + 2] = data[si + 2]; small[di + 3] = 255;
      }
      image = { mime: 'image/jpeg', base64: Buffer.from(encode({ data: small, width: w, height: h }, quality).data).toString('base64') };
      if (image.base64.length <= MAX_IMAGE_B64) break;
    }
  }

  nodeRepl.write('SLEIGHT_FRAME ' + JSON.stringify({
    app: APP, width, height, columns: outW, rows, cells: TERMINAL ? cells.toString('base64') : undefined, image,
  }));
})()
`

export const FRAME_MARKER = 'SLEIGHT_FRAME '

export function snapshotCode(app: string, columns: number, rows: number, terminal: boolean): string {
  return SNAPSHOT_JS
    .replace('__APP__', JSON.stringify(app))
    .replace('__TERMINAL__', String(terminal))
    .replace('__COLS__', String(columns))
    .replace('__ROWS__', String(rows))
}
