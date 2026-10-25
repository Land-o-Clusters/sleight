import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePdfHelper, extractPdf } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { type3Pdf } from './fixtures/pdf-type3.mjs';

const run = promisify(execFile);
async function build(root, name, source) {
  const sourceRoot = join(root, name);
  await mkdir(sourceRoot, { mode: 0o700 });
  await writeFile(join(sourceRoot, 'pdf-host.swift'), source, { mode: 0o600 });
  const result = await preparePdfHelper({ sourceRoot, cacheRoot: join(sourceRoot, 'cache'),
    inventory: { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
      files: [{ path: 'native/pdf-host.swift', sha256: createHash('sha256').update(source).digest('hex') }] } });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  return result;
}

test('sandboxed PDFKit extracts embedded subset TrueType, CJK CID and Type 3 fonts as the unconstrained baseline does', {
  skip: process.platform !== 'darwin', timeout: 900000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-pdf-fonts-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generator = await build(root, 'generator', await readFile(new URL('./fixtures/pdf-fonts.swift', import.meta.url)));
  const embedded = join(root, 'embedded.pdf');
  await run(join(generator.directory, 'pdf-host'), [embedded], { timeout: 10000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin' } });
  const bytes = await readFile(embedded), structure = bytes.toString('latin1');
  // These assertions prevent a fallback to unembedded standard fonts from passing.
  // CGPDFContext emits ordinary objects. Follow each font's own descriptor and
  // font stream so embedding Arial alone cannot stand in for embedding the CID font.
  const objects = new Map([...structure.matchAll(/(?:^|\n)(\d+) 0 obj\b([\s\S]*?)\nendobj/g)].map(match => [match[1], match[2]]));
  for (const [name, subtype, file] of [['ArialMT', 'TrueType', 'FontFile2'], ['HiraginoSans-W3', 'CIDFontType[02]', 'FontFile[23]']]) {
    const font = [...objects.values()].find(object => new RegExp(`/BaseFont\\s*/[A-Z]{6}\\+${name}\\b`).test(object)
      && new RegExp(`/Subtype\\s*/${subtype}\\b`).test(object));
    assert.ok(font, `subset ${name} uses ${subtype}`);
    const descriptor = objects.get(/\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(font)?.[1]);
    assert.ok(descriptor, `${name} has a font descriptor`);
    const fontStream = objects.get(new RegExp(`/${file}\\s+(\\d+)\\s+0\\s+R`).exec(descriptor)?.[1]);
    assert.match(fontStream ?? '', /\bstream\b/, `${name} embeds its own font program`);
  }
  assert.match(structure, /\/Subtype\s*\/Type0\b/);
  const type3 = join(root, 'type3.pdf'); await writeFile(type3, type3Pdf(), { mode: 0o600 });
  const source = await readFile(new URL('../plugins/sleight/lib/direct-browser/native/pdf-host.swift', import.meta.url), 'utf8');
  const sandboxed = await build(root, 'sandboxed', source);
  // Test-only comparison. Production always confines before document parsing.
  assert.equal(source.split('try confine(path)').length, 2);
  const baseline = await build(root, 'baseline', source.replace('try confine(path)', '// Baseline without confinement.'));
  for (const [path, expected] of [[embedded, ['Embedded TrueType invoice 731.42', '日本語の請求書 合計七百円']], [type3, ['ABC']]]) {
    const plain = await extractPdf(baseline.receipt, path), confined = await extractPdf(sandboxed.receipt, path);
    assert.equal(plain.pageCount, expected.length, JSON.stringify(plain));
    assert.deepEqual(plain.pages.map(row => row.text.trim()), expected, 'fixture text is extractable outside the sandbox');
    assert.deepEqual(confined, plain, 'sandbox preserves text and cursors for every font');
    t.diagnostic(JSON.stringify({ fixture: path === embedded ? 'embedded-subset-truetype-and-cid' : 'type3',
      pages: confined.pageCount, texts: confined.pages.map(row => row.text.trim()), sandboxMatchesBaseline: true }));
  }
});
