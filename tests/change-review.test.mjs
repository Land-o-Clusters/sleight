import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ChangeReview } from '../plugins/sleight/lib/change-review.mjs';

function fixture(t) {
  const root = mkdtempSync('/private/tmp/sleight-review-test-');
  const review = new ChangeReview();
  t.after(() => { review.dispose(); rmSync(root, { recursive: true, force: true }); });
  const path = join(root, 'a.txt');
  writeFileSync(path, 'before\n');
  return { root, review, path, doc: { title: 'a.txt', app: 'TextEdit', url: pathToFileURL(path).href } };
}

test('captures before forwarding, retains the first copy and shows a unified diff', t => {
  const { review, path, doc } = fixture(t);
  const entry = review.before(doc);
  assert.equal(readFileSync(entry.snapshot, 'utf8'), 'before\n');
  assert.equal(statSync(review.directory).mode & 0o777, 0o700);
  writeFileSync(path, 'after\n'); review.after(entry);
  review.before(doc);
  writeFileSync(path, 'again\n'); review.after(entry);
  const listing = review.describe(entry);
  assert.match(listing, /--- before/);
  assert.match(listing, /\+\+\+ after/);
  assert.match(listing, /-before\n\+again/);
  assert.equal(readFileSync(entry.snapshot, 'utf8'), 'before\n');
});

test('undo restores only the requested document and retains snapshots until disposal', t => {
  const { review, root, path, doc } = fixture(t);
  const b = join(root, 'b.txt'); writeFileSync(b, 'second before\n');
  const aEntry = review.before(doc);
  writeFileSync(path, 'after\n'); review.after(aEntry);
  const bEntry = review.before({ ...doc, url: pathToFileURL(b).href });
  writeFileSync(b, 'second after\n'); review.after(bEntry);
  review.decide(aEntry, 'undo'); review.decide(bEntry, 'keep');
  assert.equal(readFileSync(path, 'utf8'), 'before\n');
  assert.equal(readFileSync(b, 'utf8'), 'second after\n');
  assert.ok(existsSync(aEntry.snapshot));
  const bank = review.directory; review.dispose();
  assert.equal(existsSync(bank), false);
});

test('refuses undo after an external edit, including an edit during the prompt', t => {
  const { review, path, doc } = fixture(t);
  const entry = review.before(doc);
  writeFileSync(path, 'agent\n'); review.after(entry);
  review.describe(entry);
  writeFileSync(path, 'person\n');
  assert.throws(() => review.decide(entry, 'undo'), /changed.*last action.*user/s);
  assert.equal(readFileSync(path, 'utf8'), 'person\n');
});

test('does not adopt outside edits made between agent actions', t => {
  const { review, path, doc } = fixture(t);
  const entry = review.before(doc);
  writeFileSync(path, 'agent\n'); review.after(entry);
  writeFileSync(path, 'person\n');
  assert.throws(() => review.before(doc), /changed.*last action/);
  review.decide(entry, 'keep');
  assert.equal(readFileSync(path, 'utf8'), 'person\n');
  assert.throws(() => review.decide(entry, 'undo'), /changed.*last action/);
});

test('package backups include nested files, summarize sizes and restore the package', t => {
  const { review, root, doc } = fixture(t);
  const path = join(root, 'document.rtfd'); mkdirSync(path); mkdirSync(join(path, 'nested'));
  writeFileSync(join(path, 'nested', 'binary'), Buffer.from([0, 1, 2]));
  const entry = review.before({ ...doc, url: pathToFileURL(path).href });
  writeFileSync(join(path, 'nested', 'binary'), Buffer.from([3, 4, 5, 6]));
  review.after(entry);
  assert.match(review.describe(entry), /Before:.*3 bytes.*modified/);
  assert.match(review.describe(entry), /After:.*4 bytes.*modified/);
  review.decide(entry, 'undo');
  assert.deepEqual(readFileSync(join(path, 'nested', 'binary')), Buffer.from([0, 1, 2]));
});

test('binary files use a size/date summary and deleted or replaced paths refuse undo', t => {
  const { review, path, doc } = fixture(t);
  writeFileSync(path, Buffer.from([0, 1]));
  const entry = review.before(doc);
  writeFileSync(path, Buffer.from([0, 1, 2])); review.after(entry);
  assert.match(review.describe(entry), /Before:.*2 bytes.*After:.*3 bytes/s);
  rmSync(path);
  assert.throws(() => review.decide(entry, 'undo'), /cannot verify|changed/);
});

test('rejects symlinks in a package or at the source and leaves targets intact', t => {
  const { review, root, path, doc } = fixture(t);
  const link = join(root, 'link'); symlinkSync(path, link);
  assert.throws(() => review.before({ ...doc, url: pathToFileURL(link).href }), /symbolic|symlink/);
  const pkg = join(root, 'bad.rtfd'); mkdirSync(pkg); symlinkSync(path, join(pkg, 'link'));
  assert.throws(() => review.before({ ...doc, url: pathToFileURL(pkg).href }), /symbolic|symlink/);
  assert.equal(readFileSync(path, 'utf8'), 'before\n');
});

test('unsaved and non-file documents get no backup directory', t => {
  const { review } = fixture(t);
  assert.equal(review.before({ title: 'Unsaved', app: 'TextEdit', url: null }), undefined);
  assert.equal(review.before({ title: 'Web', app: 'Safari', url: 'https://example.org' }), undefined);
  assert.equal(review.directory, undefined);
});

test('a late-discovered document is listed as uncaptured and cannot be undone', t => {
  const { review, doc } = fixture(t);
  const entry = review.uncaptured(doc);
  assert.match(review.describe(entry), /no snapshot before the action/i);
  assert.throws(() => review.decide(entry, 'undo'), /no snapshot/i);
  assert.throws(() => review.before(doc), /no snapshot/i);
});

test('macOS undo preserves extended attributes and detects outside metadata edits', { skip: process.platform !== 'darwin' }, t => {
  const { review, path, doc } = fixture(t);
  const attr = 'com.sleight.review-test';
  execFileSync('/usr/bin/xattr', ['-w', attr, 'before', path]);
  const entry = review.before(doc);
  writeFileSync(path, 'after\n');
  execFileSync('/usr/bin/xattr', ['-w', attr, 'agent', path]); review.after(entry);
  review.decide(entry, 'undo');
  assert.equal(execFileSync('/usr/bin/xattr', ['-p', attr, path], { encoding: 'utf8' }).trim(), 'before');
  execFileSync('/usr/bin/xattr', ['-w', attr, 'person', path]);
  assert.throws(() => review.decide(entry, 'undo'), /changed.*last action/);
});

test('an oversized text diff refuses undo instead of offering an unseen restore', t => {
  const { review, path, doc } = fixture(t);
  const size = 9 * 1024 * 1024;
  writeFileSync(path, 'a'.repeat(size) + '\n');
  const entry = review.before(doc);
  writeFileSync(path, 'b'.repeat(size) + '\n'); review.after(entry);
  assert.match(review.describe(entry), /Review unavailable/);
  assert.throws(() => review.decide(entry, 'undo'), /review unavailable/);
  assert.equal(readFileSync(path, 'utf8')[0], 'b');
});

test('cleanup removes backup packages with read-only directories', t => {
  const { review, root, doc } = fixture(t);
  const path = join(root, 'readonly.rtfd'); mkdirSync(path);
  writeFileSync(join(path, 'body'), 'before'); chmodSync(path, 0o555);
  try {
    review.before({ ...doc, url: pathToFileURL(path).href });
    const bank = review.directory;
    review.dispose(); assert.equal(existsSync(bank), false);
  } finally { chmodSync(path, 0o755); }
});
