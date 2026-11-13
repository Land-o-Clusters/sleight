import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import kit from '../bench/windows/kit-probe.cjs';
import { createManifest, verifyKit } from '../bench/windows/guest-integrity.mjs';

function fixture() {
  const root = trackTemp(fs.mkdtempSync(join(tmpdir(), 'windows-kit-probe-')));
  fs.writeFileSync(join(root, 'payload'), Buffer.alloc(3 * kit.CHUNK_BYTES + 7, 19));
  const manifest = createManifest(root, 'a'.repeat(40));
  const bytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(join(root, 'guest-manifest.json'), bytes);
  return { root, manifest, hash: createHash('sha256').update(bytes).digest('hex') };
}

test('both verifiers hash payloads incrementally with at most 64 KiB per read', () => {
  const f = fixture(), originalRead = fs.readSync, originalWhole = fs.readFileSync;
  let reads = 0, largest = 0;
  fs.readSync = function(fd, buffer, offset, length, position) {
    largest = Math.max(largest, length); reads++;
    assert.ok(length <= kit.CHUNK_BYTES);
    return originalRead(fd, buffer, offset, length, position);
  };
  fs.readFileSync = function(file, ...args) {
    assert.notEqual(file, join(f.root, 'payload'), 'whole payload read');
    return originalWhole(file, ...args);
  };
  try {
    const receipt = kit.probe(f.root, f.manifest.commit, f.hash);
    assert.equal(receipt.files, 1); assert.equal(receipt.hashChunkBytes, 65536);
    assert.equal(kit.probe(f.root).files, 1);
    assert.equal(verifyKit(f.root, { expectedCommit: f.manifest.commit, expectedManifestSha256: f.hash }).files.length, 1);
    assert.ok(reads > 8); assert.equal(largest, 65536);
  } finally { fs.readSync = originalRead; fs.readFileSync = originalWhole; }
});

test('inventory without a commit pin refuses payload size or hash drift and extra files', async t => {
  for (const [name, change, reason] of [
    ['size', f => fs.appendFileSync(join(f.root, 'payload'), 'x'), /KIT_FILE_CHANGED/],
    ['hash', f => fs.writeFileSync(join(f.root, 'payload'), Buffer.alloc(f.manifest.files[0].bytes)), /KIT_FILE_CHANGED/],
    ['extra file', f => fs.writeFileSync(join(f.root, 'extra'), ''), /KIT_EXTRA_FILES/],
  ]) await t.test(name, () => {
    const f = fixture();
    assert.equal(kit.probe(f.root).commit, f.manifest.commit);
    change(f);
    assert.throws(() => kit.probe(f.root), reason);
  });
});

test('size, hash, manifest pin, commit pin, extra files, links and manifest cap all refuse', () => {
  const changes = [
    f => fs.appendFileSync(join(f.root, 'payload'), 'x'),
    f => fs.writeFileSync(join(f.root, 'payload'), Buffer.alloc(f.manifest.files[0].bytes)),
    f => fs.writeFileSync(join(f.root, 'extra'), ''),
    f => { fs.renameSync(join(f.root, 'payload'), join(f.root, 'other')); fs.symlinkSync('other', join(f.root, 'payload')); },
    f => fs.writeFileSync(join(f.root, 'guest-manifest.json'), Buffer.alloc(kit.MANIFEST_LIMIT + 1)),
    f => { f.hash = 'f'.repeat(64); }, f => { f.manifest.commit = 'b'.repeat(40); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.throws(() => kit.probe(f.root, f.manifest.commit, f.hash));
  }
});
