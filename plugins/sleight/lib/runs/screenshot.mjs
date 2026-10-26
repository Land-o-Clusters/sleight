// Re-encode existing pixels only. This module has no capture or application API.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpegSize } from '../direct-browser/screenshot.mjs';

export async function downscaleScreenshot(image) {
  let dir;
  try {
    if (typeof image.data !== 'string' || image.data.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return;
    const input = Buffer.from(image.data, 'base64');
    if (input.toString('base64') !== image.data || input.length > 16 * 1024 * 1024) return;
    // Bound decoding before handing the bytes to the system image converter.
    let dimensions;
    if (image.mimeType === 'image/png' && input.length >= 24 && input.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && input.toString('ascii', 12, 16) === 'IHDR')
      dimensions = { width: input.readUInt32BE(16), height: input.readUInt32BE(20) };
    else if (image.mimeType === 'image/jpeg') {
      // The header reader's default cap fits turbo images; large engine JPEGs are conservatively skipped.
      dimensions = jpegSize(image.data);
    }
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > 16000000) return;
    dir = await realpath(await mkdtemp(join(tmpdir(), 'sleight-run-image-')));
    const source = join(dir, 'source'), output = join(dir, 'image.jpg');
    await writeFile(source, input, { mode: 0o600, flag: 'wx' });
    await new Promise((resolve, reject) => execFile('/usr/bin/sips', ['-Z', '960', '-s', 'format', 'jpeg', '-s', 'formatOptions', '55', source, '--out', output],
      { timeout: 3000, maxBuffer: 8192 }, error => error ? reject(error) : resolve()));
    const bytes = await readFile(output);
    if (bytes.length > 192 * 1024) return;
    const data = bytes.toString('base64'), size = jpegSize(data);
    if (Math.max(size.width, size.height) > 960) return;
    return { mimeType: 'image/jpeg', data, ...size };
  } catch { return undefined; }
  finally { if (dir) await rm(dir, { recursive: true, force: true }); }
}
