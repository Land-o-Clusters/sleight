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
  // Claude Code replaces an MCP result over about 100,000 characters with a
  // notice, so the image's share stays well under that.
  const APP = __APP__, COLS = __COLS__, ROWS = __ROWS__, TERMINAL = __TERMINAL__, MAX_IMAGE_B64 = 40000;
  const app = await cua.getApp(APP);
  const shot = Buffer.from(await app.getScreenshot({ emit: false }));
  const isJpeg = shot[0] === 0xff && shot[1] === 0xd8;
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
    // Too big to embed: re-encode as a JPEG twice the width the desktop pane draws.
    const w = Math.min(width, 640), h = Math.max(1, Math.round(height * w / width));
    const small = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = (Math.floor(y * height / h) * width + Math.floor(x * width / w)) * 4, di = (y * w + x) * 4;
      small[di] = data[si]; small[di + 1] = data[si + 1]; small[di + 2] = data[si + 2]; small[di + 3] = 255;
    }
    const jpeg = (await import('jpeg-js')).default.encode({ data: small, width: w, height: h }, 75);
    image = { mime: 'image/jpeg', base64: Buffer.from(jpeg.data).toString('base64') };
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
