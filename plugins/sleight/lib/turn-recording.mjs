// Bounded, action-sampled GIFs. Only already-masked RGBA pixels reach this writer.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, parse, relative } from 'node:path';

export const RECORDING_LIMITS = Object.freeze({ width: 640, height: 480, frames: 30, bytes: 12 * 1024 * 1024 });
const word = n => Buffer.from([n & 255, n >> 8 & 255]);

export function gifHeader(width, height) {
  const palette = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) {
    palette[i * 3] = Math.round((i >> 5) * 255 / 7);
    palette[i * 3 + 1] = Math.round((i >> 2 & 7) * 255 / 7);
    palette[i * 3 + 2] = Math.round((i & 3) * 255 / 3);
  }
  // No loop extension: a short recording plays once. Every frame lasts half a second.
  return Buffer.concat([Buffer.from('GIF89a'), word(width), word(height), Buffer.from([0xf7, 0, 0]), palette]);
}

export function gifFrame({ width, height, data }, canvas = RECORDING_LIMITS) {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 10000) || width * height > 16000000 ||
      !Buffer.isBuffer(data) || data.length !== width * height * 4) throw Error('RECORDING_PIXELS_INVALID');
  const scale = Math.min(1, canvas.width / width, canvas.height / height);
  const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  const left = Math.floor((canvas.width - w) / 2), top = Math.floor((canvas.height - h) / 2);
  const pixels = Buffer.alloc(canvas.width * canvas.height);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const at = (Math.min(height - 1, Math.floor(y / scale)) * width + Math.min(width - 1, Math.floor(x / scale))) * 4;
    // Transparent pixels become black, never hidden RGB values from the original image.
    const alpha = data[at + 3] / 255;
    pixels[(top + y) * canvas.width + left + x] = (Math.round(data[at] * alpha) >> 5) << 5 |
      (Math.round(data[at + 1] * alpha) >> 5) << 2 | Math.round(data[at + 2] * alpha) >> 6;
  }
  // Clear the dictionary every 250 literals, keeping all codes at 9 bits. Bounded and dependency-free.
  const packed = []; let bits = 0, count = 0;
  const code = value => { bits |= value << count; count += 9; while (count >= 8) { packed.push(bits & 255); bits >>>= 8; count -= 8; } };
  for (let i = 0; i < pixels.length; i++) { if (i % 250 === 0) code(256); code(pixels[i]); }
  code(257); if (count) packed.push(bits & 255);
  const bytes = Buffer.from(packed), blocks = [];
  for (let at = 0; at < bytes.length; at += 255) { const block = bytes.subarray(at, at + 255); blocks.push(Buffer.from([block.length]), block); }
  return Buffer.concat([Buffer.from([0x21, 0xf9, 4, 4, 50, 0, 0, 0, 0x2c]), word(0), word(0), word(canvas.width), word(canvas.height),
    Buffer.from([0, 8]), ...blocks, Buffer.from([0])]);
}

// Fixed user-home destination, never HOME, a tool path, a page title or a session string.
export function recordingFile({ home = userInfo().homedir, uid = process.getuid() } = {}) {
  let folder = parse(home).root;
  for (const name of [...relative(folder, home).split('/'), 'Library', 'Application Support', 'sleight', 'recordings']) {
    folder = join(folder, name);
    try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(folder) !== folder || stat.mode & 0o022 ||
        ![uid, 0].includes(stat.uid)) throw Error('RECORDING_DESTINATION_UNSAFE');
  }
  const dir = mkdtempSync(join(folder, 'turn-'));
  const path = join(dir, 'actions.gif');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  return { path, fd };
}

export function createTurnRecording({ current, capture, createFile = recordingFile, limits = RECORDING_LIMITS } = {}) {
  if (typeof current !== 'function' || typeof capture !== 'function') throw Error('RECORDING_AUTHORITY_REQUIRED');
  let ended = false, frames = 0, skipped = 0, file, bytes = 0, failed = false, limited = false, resumeUnconfirmed = false, queue = Promise.resolve();
  const valid = () => { try { return !ended && current() === true; } catch { return false; } };
  const close = () => { if (file?.fd !== undefined) { closeSync(file.fd); file.fd = undefined; } };
  const note = () => `Recording: ${frames ? `${file.path} (${frames} frames${skipped ? ', ' + skipped + ' skipped' : ''}${limited ? ', cap reached' : ''}${failed ? ', stopped' : ''}).`
    : failed ? 'unavailable; no frames saved.' : limited ? 'cap reached; no frames saved.' : ended ? 'no frames saved.'
      : `armed for this turn${skipped ? ' (' + skipped + ' skipped)' : ''}.`}${resumeUnconfirmed ? ' Page script resumption is unconfirmed; check the tab before continuing.' : ''}`;
  return Object.freeze({
    capture(entry) {
      if (!valid() || failed || limited) return Promise.resolve(resumeUnconfirmed ? { stop: true } : undefined);
      const task = queue.then(async () => {
        if (!valid() || failed || limited) return;
        if (frames >= limits.frames) { limited = true; close(); return; }
        // Pending input and dialogs must never gain another browser operation.
        if (entry.state?.dialog || entry.state?.actionPending || entry.page?.isClosed?.()) { skipped++; return; }
        try {
          const image = await capture(entry, valid);
          if (!valid()) return;
          const frame = gifFrame(image, limits), header = frames ? Buffer.alloc(0) : gifHeader(limits.width, limits.height);
          if (bytes + header.length + frame.length + 1 > limits.bytes) { limited = true; close(); return; }
          file ??= createFile();
          if (!valid()) { close(); return; }
          if (fstatSync(file.fd).size !== bytes) throw Error('RECORDING_FILE_CHANGED');
          const block = Buffer.concat([header, frame, Buffer.from([0x3b])]);
          let at = 0, position = frames ? bytes - 1 : 0;
          while (at < block.length) at += writeSync(file.fd, block, at, block.length - at, position + at);
          bytes = position + block.length; frames++;
          if (frames >= limits.frames) { limited = true; close(); }
        } catch (error) { failed = true; resumeUnconfirmed = error?.message === 'RECORDING_RESUME_UNCONFIRMED'; try { close(); } catch {} }
      });
      queue = task.catch(() => { failed = true; });
      return queue.then(() => resumeUnconfirmed ? { stop: true } : undefined);
    },
    note,
    blocked: () => resumeUnconfirmed,
    end() { ended = true; return queue.finally(() => { try { close(); } catch {} }); },
  });
}
