import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const module = await import('../bench/tasks-mail-to-sheet.mjs');
  assert.equal(typeof module.findNumbersLeftovers, 'function');
  const home = mkdtempSync(join(tmpdir(), 'bt2b-leftovers-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const roots = [join(home, 'Documents'), join(home, 'Desktop'), join(home, 'Library/Containers/com.apple.iWork.Numbers/Data/Documents'),
    join(home, 'Library/Autosave Information'), join(home, 'Library/Containers/com.apple.iWork.Numbers/Data/Library/Autosave Information'),
    join(home, 'Library/Mobile Documents/com~apple~Numbers/Documents'), join(home, 'Library/Mobile Documents/com~apple~CloudDocs')];
  for (const root of roots) mkdirSync(root, { recursive: true });
  const dir = join(roots[0], 'run'); mkdirSync(dir);
  const ctx = { dir, nonce: 'bt2bnonce', mailToSheet: { startedAtMs: 1 } };
  return { ctx, home, roots, scan: options => module.findNumbersLeftovers(ctx, { home, ...options }) };
}

test('leftover scan reports only nonce Numbers names outside the run in default and iCloud locations', async t => {
  const f = await fixture(t);
  for (const [i, root] of f.roots.entries()) {
    const nested = join(root, 'nested'); mkdirSync(nested);
    const packagePath = join(nested, `Transfer-bt2bnonce-${i}.numbers`); mkdirSync(packagePath);
    writeFileSync(join(packagePath, 'index.zip'), 'private content');
    writeFileSync(join(root, 'Owner.numbers'), 'owner data');
    writeFileSync(join(root, 'Transfer-bt2bnonce.csv'), 'source');
  }
  writeFileSync(join(f.ctx.dir, 'In-run-bt2bnonce.numbers'), 'owned');
  symlinkSync(f.ctx.dir, join(f.roots[1], 'alias'));
  symlinkSync(join(f.roots[0], 'Owner.numbers'), join(f.roots[0], 'Linked-bt2bnonce.numbers'));
  assert.deepEqual(f.scan(), ['Transfer-bt2bnonce-0.numbers', 'Transfer-bt2bnonce-1.numbers',
    'Transfer-bt2bnonce-2.numbers', 'Transfer-bt2bnonce-3.numbers', 'Transfer-bt2bnonce-4.numbers',
    'Transfer-bt2bnonce-5.numbers', 'Transfer-bt2bnonce-6.numbers']);
  assert.equal(readFileSync(join(f.roots[0], 'nested/Transfer-bt2bnonce-0.numbers/index.zip'), 'utf8'), 'private content');
  assert.equal(readFileSync(join(f.roots[0], 'Owner.numbers'), 'utf8'), 'owner data');
  assert.equal(existsSync(join(f.ctx.dir, 'In-run-bt2bnonce.numbers')), true);
});

test('creation time, rather than modification time, bounds the run leftover check', async t => {
  const f = await fixture(t), path = join(f.roots[0], 'Transfer-bt2bnonce.numbers');
  writeFileSync(path, 'keep');
  const created = lstatSync(path).birthtimeMs;
  f.ctx.mailToSheet.startedAtMs = created;
  assert.deepEqual(f.scan({ now: () => created }), ['Transfer-bt2bnonce.numbers']);
  f.ctx.mailToSheet.startedAtMs = created + 1;
  utimesSync(path, new Date(), new Date(created + 1000));
  assert.deepEqual(f.scan({ now: () => created + 1000 }), []);
  f.ctx.mailToSheet.startedAtMs = created - 1000;
  assert.deepEqual(f.scan({ now: () => created - 1 }), []);
});

test('a default location redirected to iCloud is scanned without following interior aliases', async t => {
  const f = await fixture(t);
  const redirected = join(f.home, 'redirected-documents'); mkdirSync(redirected);
  rmSync(f.roots[0], { recursive: true });
  symlinkSync(redirected, f.roots[0]);
  writeFileSync(join(redirected, 'Transfer-bt2bnonce.numbers'), 'preserve');
  assert.deepEqual(f.scan(), ['Transfer-bt2bnonce.numbers']);
});

test('missing locations are empty but incomplete or invalid scans use a fixed name-free refusal', async t => {
  const f = await fixture(t);
  for (const root of f.roots) rmSync(root, { recursive: true });
  assert.deepEqual(f.scan(), []);
  mkdirSync(f.roots[0]);
  let nested = f.roots[0];
  for (let i = 0; i < 14; i++) { nested = join(nested, 'private-folder'); mkdirSync(nested); }
  assert.throws(() => f.scan(), /^Error: NUMBERS_LEFTOVER_SCAN_UNCONFIRMED$/);
  f.ctx.nonce = '';
  assert.throws(() => f.scan(), /^Error: NUMBERS_LEFTOVER_SCAN_IDENTITY_UNCONFIRMED$/);
});
