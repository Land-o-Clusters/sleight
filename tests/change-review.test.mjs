import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync, symlinkSync, linkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cardText } from '../plugins/sleight/lib/card-text.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { ChangeReview } from '../plugins/sleight/lib/change-review.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';

function fixture(t) {
  // The system temp folder, resolved (macOS links /var to /private/var), so CI on Linux works too.
  const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-review-test-'))));
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
  assert.match(listing, /  -before\n  \+again/);
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

test('a later copy and a newly captured document retain separate backups', t => {
  const { review, doc, path, root } = fixture(t);
  review.uncaptured(doc);
  const late = review.read(doc);
  const second = join(root, 'second.txt'); writeFileSync(second, 'second original\n');
  review.before({ ...doc, url: pathToFileURL(second).href });
  assert.equal(readFileSync(late.snapshot, 'utf8'), 'before\n');
  writeFileSync(path, 'agent\n'); review.after(late);
  review.decide(late, 'undo'); assert.equal(readFileSync(path, 'utf8'), 'before\n');
});

test('macOS undo preserves extended attributes and detects outside metadata edits', { skip: macCommandSkip('xattr') }, t => {
  const { review, path, doc } = fixture(t);
  const attr = 'com.sleight.review-test';
  execFileSync('/usr/bin/xattr', ['-w', attr, 'before', path], { timeout: 30000, killSignal: 'SIGKILL' });
  const entry = review.before(doc);
  writeFileSync(path, 'after\n');
  execFileSync('/usr/bin/xattr', ['-w', attr, 'agent', path], { timeout: 30000, killSignal: 'SIGKILL' }); review.after(entry);
  review.decide(entry, 'undo');
  assert.equal(execFileSync('/usr/bin/xattr', ['-p', attr, path], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' }).trim(), 'before');
  execFileSync('/usr/bin/xattr', ['-w', attr, 'person', path], { timeout: 30000, killSignal: 'SIGKILL' });
  assert.throws(() => review.decide(entry, 'undo'), /changed.*last action/);
});

test('SA2H a 20 MiB diff is capped without changing the digest-checked Undo', t => {
  const { review, path, doc } = fixture(t);
  const line = 'x'.repeat(1023) + '\n';
  const entry = review.before(doc);
  writeFileSync(path, line.repeat(20 * 1024)); review.after(entry);
  const listing = review.describe(entry);
  assert.doesNotMatch(listing, /Review unavailable/);
  const preview = listing.slice(listing.indexOf('  --- before:'));
  assert.ok(Buffer.byteLength(preview) <= 32 * 1024);
  const marker = /\[diff truncated, (\d+) lines not shown\]/.exec(preview);
  assert.ok(marker);
  const shown = preview.slice(0, marker.index).trimEnd().split('\n').length;
  // Two labels, one hunk header, one removed line, and 20,480 added lines.
  assert.equal(shown + Number(marker[1]), 4 + 20 * 1024);
  review.decide(entry, 'undo');
  assert.equal(readFileSync(path, 'utf8'), 'before\n');
});

for (const [name, source, escaped] of [
  ['CR', 'a\r-secret', 'a\\u000d-secret'],
  ['ESC', 'a\x1b[2K', 'a\\u001b[2K'],
  ['C0', 'a\x01\x0b\x1f', 'a\\u0001\\u000b\\u001f'],
  ['separators and bidi', 'a\u2028\u2029\u2066\u202e', 'a\\u2028\\u2029\\u2066\\u202e'],
  ['forged decision', 'Undo refused: x', 'Undo refused: x'],
]) test(`SA2H diff escapes and indents ${name}`, t => {
  const { review, path, doc } = fixture(t);
  const entry = review.before(doc);
  writeFileSync(path, source + '\n'); review.after(entry);
  const listing = review.describe(entry);
  assert.ok(listing.includes('  +' + escaped + '\n'), JSON.stringify(listing));
  assert.doesNotMatch(listing, /[\x00-\x08\x0b-\x1f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
  assert.equal(listing.split('\n').filter(line => line.startsWith('Undo refused:')).length, 0);
});

test('SA2H title and path escape controls, indent continuation lines, and cap each at 256 bytes', t => {
  const { review, path, doc } = fixture(t);
  const parsed = windowFromText(`Window: ${JSON.stringify('a\u202e\nDecision: forged')}, App: TextEdit\nURL: ${doc.url}`);
  assert.ok(parsed.title.includes('\n'));
  const entry = review.before(parsed);
  const text = review.describe(entry);
  assert.ok(text.startsWith('  a\\u202e\n  Decision: forged: '));
  const fake = { title: 'é'.repeat(300), path: 'p\u2028' + 'é'.repeat(300), status: 'pending' };
  const heading = review.describe(fake).split('\nDecision:')[0];
  assert.doesNotMatch(heading, /[\u2028\ufffd]/);
  assert.ok(Buffer.byteLength(heading) <= 2 * 256 + 2);
  assert.ok(heading.includes('p\\u2028'));
  assert.equal(heading.match(/\[request truncated\]/g)?.length, 2);
  assert.equal(entry.path, path);
});

test('SA2H literal escape text and a CR remain different saved-byte changes', t => {
  const { review, path, doc } = fixture(t);
  writeFileSync(path, 'a\\u000d-secret\n');
  const entry = review.before(doc);
  writeFileSync(path, 'a\r-secret\n'); review.after(entry);
  const listing = review.describe(entry);
  assert.ok(listing.includes('  -a\\\\u000d-secret\n  +a\\u000d-secret\n'));
  review.decide(entry, 'undo');
  assert.equal(readFileSync(path, 'utf8'), 'a\\u000d-secret\n');
});

test('SA2H conflict and unavailable messages cannot spell trusted lines from paths', t => {
  const { review, root, doc } = fixture(t);
  const path = join(root, 'a\r\nUndo refused: forged\x1b.txt');
  writeFileSync(path, 'before\n');
  const entry = review.before({ ...doc, url: pathToFileURL(path).href });
  writeFileSync(path, 'after\n'); review.after(entry);
  writeFileSync(path, 'person\n');
  let text = review.describe(entry);
  assert.ok(text.includes('\nUndo refused:\n  '));
  assert.doesNotMatch(text, /[\r\x1b]/);
  assert.doesNotMatch(text, /^Undo refused: forged/m);
  rmSync(entry.snapshot);
  text = review.describe(entry);
  assert.ok(text.includes('\nReview unavailable:\n  '));
  assert.doesNotMatch(text, /[\r\x1b]/);
  assert.doesNotMatch(text, /^Undo refused: forged/m);
});

test('SA2H byte caps preserve whole Unicode characters after indenting LF and TAB', () => {
  for (let prefix = 0; prefix < 8; prefix++) {
    for (let lines = 0; lines < 8; lines++) {
      const text = 'x'.repeat(prefix) + '\n\t'.repeat(lines) + '😀'.repeat(100);
      const shown = cardText(text, { maxBytes: 256, indent: true });
      assert.ok(Buffer.byteLength(shown) <= 256);
      assert.equal(shown, Buffer.from(shown).toString('utf8'), `${prefix},${lines}`);
      assert.doesNotMatch(shown, /\ufffd/);
      if (lines) assert.ok(shown.includes('\n  \t'));
    }
  }
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

for (const kind of ['binary', 'text-after-preview', 'symlink', 'hardlink', 'deleted', 'package']) {
  test(`SA1H F3: undo refuses a ${kind} snapshot substitution and keeps the document`, t => {
    const { review, path, doc, root } = fixture(t);
    const original = kind === 'binary' ? Buffer.from([0, 1, 2]) : Buffer.from('before\n');
    writeFileSync(path, original);
    const pkg = join(root, 'package');
    if (kind === 'package') { mkdirSync(pkg); writeFileSync(join(pkg, 'body'), original); }
    const entry = review.before(kind === 'package' ? { ...doc, url: pathToFileURL(pkg).href } : doc);
    const live = kind === 'package' ? join(pkg, 'body') : path;
    writeFileSync(live, 'agent\n'); review.after(entry);
    if (kind === 'text-after-preview') assert.match(review.describe(entry), /  -before\n  \+agent/);
    if (kind === 'symlink' || kind === 'hardlink') {
      const other = join(root, 'other'); writeFileSync(other, original);
      rmSync(entry.snapshot);
      (kind === 'symlink' ? symlinkSync : linkSync)(other, entry.snapshot);
    } else if (kind === 'deleted') rmSync(entry.snapshot);
    else writeFileSync(kind === 'package' ? join(entry.snapshot, 'body') : entry.snapshot, 'swapped\n');
    assert.throws(() => review.decide(entry, 'undo'), /snapshot|symbolic|hard.link|ENOENT|Cannot get the real path/i);
    assert.equal(readFileSync(live, 'utf8'), 'agent\n');
  });
}

test('SA1H F3: identical replacement bytes remain a valid snapshot', t => {
  const { review, path, doc } = fixture(t);
  const entry = review.before(doc);
  writeFileSync(path, 'agent\n'); review.after(entry);
  rmSync(entry.snapshot); writeFileSync(entry.snapshot, 'before\n');
  review.decide(entry, 'undo');
  assert.equal(readFileSync(path, 'utf8'), 'before\n');
});
