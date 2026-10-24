// Bounded, action-sampled GIFs. Only already-masked RGBA pixels reach this writer.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
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
function recordingDirectory({ home = userInfo().homedir, uid = process.getuid() } = {}) {
  let folder = parse(home).root;
  for (const name of [...relative(folder, home).split('/'), 'Library', 'Application Support', 'sleight', 'recordings']) {
    folder = join(folder, name);
    try { mkdirSync(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(folder) !== folder || stat.mode & 0o022 ||
        ![uid, 0].includes(stat.uid)) throw Error('RECORDING_DESTINATION_UNSAFE');
  }
  return folder;
}

// Only ordinary, owned, private banks with the single expected file are eligible. Never follow a link.
async function pruneDirectory(folder, uid = process.getuid(), now = Date.now()) {
  for (const name of await readdir(folder)) {
    if (!/^turn-[A-Za-z0-9]+$/.test(name)) continue;
    const dir = join(folder, name), path = join(dir, 'actions.gif');
    try {
      const bank = await lstat(dir);
      if (!bank.isDirectory() || bank.isSymbolicLink() || bank.uid !== uid || bank.mode & 0o077 ||
          now - bank.mtimeMs <= 30 * 86400000 || await realpath(dir) !== dir) continue;
      const names = await readdir(dir);
      if (names.length !== 1 || names[0] !== 'actions.gif') continue;
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== uid || file.mode & 0o077 || file.nlink !== 1 ||
          now - file.mtimeMs <= 30 * 86400000) continue;
      // Recheck identities after the asynchronous reads, immediately before deleting.
      const finalDir = lstatSync(dir), finalFile = lstatSync(path), finalNames = readdirSync(dir);
      if (finalDir.ino !== bank.ino || finalDir.dev !== bank.dev || finalDir.mtimeMs !== bank.mtimeMs ||
          finalFile.ino !== file.ino || finalFile.dev !== file.dev || finalFile.mtimeMs !== file.mtimeMs ||
          finalFile.mode !== file.mode || finalFile.nlink !== 1 || finalDir.mode !== bank.mode ||
          finalNames.length !== 1 || finalNames[0] !== 'actions.gif' || realpathSync(dir) !== dir) continue;
      unlinkSync(path); rmdirSync(dir);
    } catch { /* A changed bank or failed prune must not remove any other entry. */ }
  }
}

export function recordingFile(options = {}) {
  const folder = recordingDirectory(options);
  const dir = mkdtempSync(join(folder, 'turn-'));
  const path = join(dir, 'actions.gif');
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    return { path, fd, prune: () => pruneDirectory(folder, options.uid) };
  } catch (error) { try { rmdirSync(dir); } catch {} throw error; }
}

export function createTurnRecording({ current, capture, createFile = recordingFile, limits = RECORDING_LIMITS } = {}) {
  if (typeof current !== 'function' || typeof capture !== 'function') throw Error('RECORDING_AUTHORITY_REQUIRED');
  let ended = false, frames = 0, skipped = 0, file, fileIdentity, dirIdentity, pruning, bytes = 0, failed = false, limited = false, resumeUnconfirmed = false, queue = Promise.resolve();
  const costs = [], reasons = new Set();
  const valid = () => { try { return !ended && current() === true; } catch { return false; } };
  const close = () => { if (file?.fd !== undefined) { closeSync(file.fd); file.fd = undefined; } };
  const displayPath = path => path.startsWith(userInfo().homedir + '/') ? '~/' + path.slice(userInfo().homedir.length + 1) : path;
  const warning = () => resumeUnconfirmed ? 'Page script resumption is unconfirmed; further recording frames are blocked for this turn. Browser actions remain available.' : '';
  const note = () => `Recording: ${frames ? `${displayPath(file.path)} (${frames} frames${skipped ? ', ' + skipped + ' skipped' : ''}${limited ? ', cap reached' : ''}${failed ? ', stopped' : ''}).`
    : failed ? 'unavailable; no frames saved.' : limited ? 'cap reached; no frames saved.' : ended ? `no frames saved${skipped ? ' (' + skipped + ' skipped)' : ''}.`
      : `armed for this turn${skipped ? ' (' + skipped + ' skipped)' : ''}.`}${reasons.size ? ' Skipped: ' + [...reasons].join(', ') + '.' : ''}${warning() ? ' ' + warning() : ''}` +
      (costs.length ? ' Pixel processing per frame (decode/mask + quantise ms): ' + costs.map(([decode, quantise]) => `${decode.toFixed(1)}+${quantise.toFixed(1)}`).join(', ') + '.' : '');
  const skip = error => {
    skipped++;
    const reason = { RECORDING_MOTION_UNAVAILABLE: 'animation', RECORDING_SCROLL_UNSETTLED: 'scroll settling', RECORDING_TREE_LIMIT: 'tree size',
      RECORDING_IMAGE_LIMIT: 'image size', RECORDING_VIEWPORT_LIMIT: 'viewport size', RECORDING_OPAQUE_TREE: 'shadow tree',
      RECORDING_TARGET_UNAVAILABLE: 'target unavailable', RECORDING_TIMEOUT: 'timeout' }[String(error?.message).match(/\bRECORDING_[A-Z_]+\b/)?.[0]];
    reasons.add(reason ?? 'capture unavailable');
  };
  return Object.freeze({
    capture(entry, target) {
      if (!valid() || failed || limited) return Promise.resolve();
      const task = queue.then(async () => {
        if (!valid() || failed || limited) return;
        if (frames >= limits.frames) { limited = true; close(); return; }
        // Pending input and dialogs must never gain another browser operation.
        if (entry.state?.dialog || entry.state?.actionPending || entry.page?.isClosed?.()) { skip(); return; }
        try {
          let image;
          try { image = await capture(entry, target, valid); }
          catch (error) {
            if (error?.message === 'RECORDING_RESUME_UNCONFIRMED') throw error;
            skip(error); return;
          }
          if (!valid()) return;
          const start = performance.now(), frame = gifFrame(image, limits), quantiseMs = performance.now() - start;
          const header = frames ? Buffer.alloc(0) : gifHeader(limits.width, limits.height);
          if (bytes + header.length + frame.length + 1 > limits.bytes) { limited = true; close(); return; }
          file ??= createFile();
          fileIdentity ??= lstatSync(file.path);
          dirIdentity ??= lstatSync(join(file.path, '..'));
          if (!valid()) { close(); return; }
          if (fstatSync(file.fd).size !== bytes) throw Error('RECORDING_FILE_CHANGED');
          const block = Buffer.concat([header, frame, Buffer.from([0x3b])]);
          let at = 0, position = frames ? bytes - 1 : 0;
          while (at < block.length) {
            const written = writeSync(file.fd, block, at, block.length - at, position + at);
            if (written <= 0) throw Error('RECORDING_WRITE_FAILED');
            at += written;
          }
          bytes = position + block.length; frames++;
          if (frames === 1 && file.prune) pruning = Promise.resolve().then(() => file.prune()).catch(() => {});
          costs.push([Number.isFinite(image.decodeMaskMs) ? image.decodeMaskMs : 0, quantiseMs]);
          if (frames >= limits.frames) { limited = true; close(); }
        } catch (error) {
          failed = true; resumeUnconfirmed = error?.message === 'RECORDING_RESUME_UNCONFIRMED'; try { close(); } catch {}
          if (!frames && fileIdentity?.isFile()) try {
            const now = lstatSync(file.path);
            if (now.isFile() && now.ino === fileIdentity.ino && now.dev === fileIdentity.dev && now.nlink === 1) {
              unlinkSync(file.path);
              const dir = join(file.path, '..'), parent = lstatSync(dir);
              if (parent.isDirectory() && !parent.isSymbolicLink() && parent.ino === dirIdentity?.ino && parent.dev === dirIdentity?.dev) rmdirSync(dir);
            }
          } catch {}
        }
      });
      queue = task.catch(() => { failed = true; });
      return queue;
    },
    note,
    warning,
    blocked: () => resumeUnconfirmed,
    end() { ended = true; return queue.finally(async () => { try { close(); } catch {} await pruning; }); },
  });
}
