import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureRecordingFrame } from '../../plugins/sleight/lib/direct-browser/recording.mjs';
import { createTurnRecording } from '../../plugins/sleight/lib/turn-recording.mjs';
// A Pillow child that stops reading stdin under heavy load once held a full check for 13 minutes; fail fast instead.
const PIL_TIMEOUT_MS = 60000;

// Optional macOS image decoders operate only on synthetic fixture pixels.
let grader;
test.after(() => { if (grader) rmSync(grader.dir, { recursive: true, force: true }); });
export function imageGrader(t) {
  if (process.platform !== 'darwin') return undefined;
  if (!grader) {
    const dir = mkdtempSync(join(tmpdir(), 'sleight-g13e-decoder-'));
    const executable = join(dir, 'grade');
    grader = { dir, executable, images: 0 };
    const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'),
      new URL('./recording-image-grade.swift', import.meta.url).pathname, '-o', executable], {
      encoding: 'utf8', timeout: 120000, env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' } });
    assert.equal(compiled.status, 0, `${compiled.error?.code ?? compiled.signal ?? ''}\n${compiled.stderr}`);
  }
  return grader;
}
export function recognize(t, data, mode = 'ocr') {
  const tool = imageGrader(t);
  if (!tool) return undefined;
  const path = join(tool.dir, `image-${tool.images++}.png`); writeFileSync(path, data);
  const result = spawnSync(tool.executable, [mode, path], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.error?.code ?? result.signal ?? ''}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

const require = createRequire(import.meta.url);
export const { PNG } = require('../../plugins/sleight/vendor/playwright-core/lib/utilsBundle.js');
// Independent image reference. The fixture supplies the expected CSS block size.
export function average(raw, size) {
  const data = Buffer.from(raw.data);
  for (let y = 0; y < raw.height; y += size) for (let x = 0; x < raw.width; x += size) {
    const endX = Math.min(x + size, raw.width), endY = Math.min(y + size, raw.height), sums = [0, 0, 0];
    for (let j = y; j < endY; j++) for (let i = x; i < endX; i++)
      for (let c = 0; c < 3; c++) sums[c] += raw.data[(j * raw.width + i) * 4 + c];
    const colour = [...sums.map(sum => Math.round(sum / ((endX - x) * (endY - y)))), 255];
    for (let j = y; j < endY; j++) for (let i = x; i < endX; i++) data.set(colour, (j * raw.width + i) * 4);
  }
  return data;
}
export function differences(frame, reference, box) {
  let count = 0;
  for (let y = Math.ceil(box.y); y < Math.floor(box.y + box.height); y++)
    for (let x = Math.ceil(box.x); x < Math.floor(box.x + box.width); x++) {
      const at = (y * frame.width + x) * 4;
      if (frame.data.subarray(at, at + 4).some((value, i) => value !== reference[at + i])) count++;
    }
  return count;
}
export const inset = (box, n = 4) => ({ x: box.x + n, y: box.y + n, width: box.width - 2 * n, height: box.height - 2 * n });
// OCR uses macOS Vision and the GIF checks use Pillow; skip where either is missing (Linux CI, clean Macs).
export function gradeSkip() {
  if (process.platform !== 'darwin') return 'macOS Vision OCR required';
  return spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8', timeout: PIL_TIMEOUT_MS }).status === 0 ? false : 'python3 Pillow required';
}
export async function rawFrame(page) { return PNG.sync.read(await page.screenshot({ type: 'png', scale: 'css', caret: 'hide' })); }
export async function record(f, handle, t) {
  // A deadline skips one sampled frame in production. Privacy assertions need
  // an admitted frame, so allow three samples and report every deadline miss.
  for (let attempt = 1; ; attempt++) {
    try {
      return await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: handle ? { handle } : undefined });
    } catch (error) {
      if (attempt >= 3 || !/^RECORDING_(TIMEOUT|RESUME_UNCONFIRMED|TREE_LIMIT)$/.test(error.message)) throw error;
      t?.diagnostic(`sample ${attempt} skipped: ${error.message}`);
    }
  }
}
export async function savedGrade(t, frame, reference, box) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13e-grade-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = createTurnRecording({ current: () => true, capture: async () => frame,
    createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) });
  await recorder.capture({ state: {} }); await recorder.end();
  const result = spawnSync('python3', ['-c', `from PIL import Image
import sys,json,math
w,h,box=json.loads(sys.argv[2]); raw=sys.stdin.buffer.read(); im=Image.open(sys.argv[1]).convert('RGB')
s=min(1,640/w,480/h); left=(640-math.floor(w*s))//2; top=(480-math.floor(h*s))//2; count=0
for y in range(math.ceil(box['y']*s)+top,math.floor((box['y']+box['height'])*s)+top):
 for x in range(math.ceil(box['x']*s)+left,math.floor((box['x']+box['width'])*s)+left):
  at=(min(h-1,math.floor((y-top)/s))*w+min(w-1,math.floor((x-left)/s)))*4
  r,g,b=raw[at:at+3]; want=(round((r>>5)*255/7),round((g>>5)*255/7),round((b>>6)*255/3))
  count+=im.getpixel((x,y))!=want
print(count)
assert count==0,('unmasked GIF pixels',count)
`, path, JSON.stringify([frame.width, frame.height, box])], { input: reference, encoding: 'utf8', timeout: PIL_TIMEOUT_MS });
  assert.equal(result.status, 0, result.stderr);
  t.diagnostic(`saved GIF: ${result.stdout.trim()} differing pixels`);
  const gif = readFileSync(path);
  gradeUnreadable(t, frame, gif, box);
  return gif;
}

export function gradeUnreadable(t, frame, gif, box) {
  const errors = [];
  for (const [bytes, label] of [[PNG.sync.write(frame), 'masked PNG'], [gif, 'saved GIF']]) {
    try { unreadable(t, bytes, label, frame, box); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'OCR/QR grading failed');
}

// Grade the fixture's content region. Synthetic outlines can look like letters
// to OCR, so the same inset used for pixel comparison excludes those annotations.
export function unreadable(t, bytes, label, frame, box) {
  const original = bytes;
  if (box) {
    const cropped = spawnSync('python3', ['-c', `from PIL import Image
import sys,json,io,math
w,h,box=json.loads(sys.argv[1]); raw=sys.stdin.buffer.read(); image=Image.open(io.BytesIO(raw)).convert('RGB'); gif=raw[:3]==b'GIF'
s=min(1,640/w,480/h) if gif else 1
left=(640-math.floor(w*s))//2 if gif else 0; top=(480-math.floor(h*s))//2 if gif else 0
image.crop((math.ceil(box['x']*s)+left,math.ceil(box['y']*s)+top,math.floor((box['x']+box['width'])*s)+left,math.floor((box['y']+box['height'])*s)+top)).save(sys.stdout.buffer,format='PNG')
`, JSON.stringify([frame.width, frame.height, box])], { input: bytes, timeout: PIL_TIMEOUT_MS });
    assert.equal(cropped.status, 0, cropped.error?.message ?? cropped.stderr.toString());
    bytes = cropped.stdout;
  }
  const ocr = recognize(t, bytes), qr = recognize(t, original, 'decode-qr');
  if (ocr) {
    t.diagnostic(`${label}: OCR ${ocr.text.length}, whole-image QR ${qr.qr.length}`);
    assert.deepEqual(qr.qr, [], label + ': zero decodable QR');
    if (ocr.text.length) t.diagnostic(label + ': ' + JSON.stringify(ocr.regions));
    // Acceptance (sleight-arch, 2026-10-24): nothing private is recovered. Pixel blocks can make OCR emit short noise
    // glyphs, so a run of 4 or more letters or digits in the OCR output is the failure, whatever the fixture text was.
    const recovered = ocr.text.flatMap(text => String(text).match(/[\p{L}\p{N}@.]{4,}/gu) ?? []);
    assert.deepEqual(recovered, [], label + ': no recovered text (4+ characters)');
  }
}
