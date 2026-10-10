// The privacy page must match the code: every ~/Library path docs/privacy.md
// names has to appear in the plugin's own source, so the page can't drift from
// what sleight actually writes. Renaming a path in the doc fails this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function pluginSource() {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests' && entry.name !== 'node_modules') visit(full);
      } else if (/\.(mjs|js|tsx|ts)$/.test(entry.name)) files.push(readFileSync(full, 'utf8'));
    }
  };
  visit(join(root, 'plugins', 'sleight'));
  return files.join('\n');
}

// Path pieces are built with join('Library', 'Logs', ...) in some files and
// 'Library/Logs' in others; quote and comma glue is replaced with slashes so
// both spellings match the doc's one. Overmatching is fine: the contract this
// test enforces is that a renamed doc path stops appearing, not the reverse.
const normalize = text => text
  .replace(/['"`]/g, '')
  .replace(/\)\s*,\s*/g, '/')
  .replace(/,\s*/g, '/')
  .replace(/\s+/g, ' ');

const namedPaths = doc => [...doc.matchAll(/`(~\/Library\/[^`]+)`/g)]
  .map(match => match[1].replace(/^~\//, ''));
// A trailing slash marks a directory, but both files and directories need the
// same boundary: the match must not run on into a longer name (`receipt` can't
// match `receipts`) or a suffix (`receipt` can't match `receipt.json`). A
// following `/` is a real match in both cases.
const concretePrefix = path => {
  const concrete = path.replace(/<.*$/, '').replace(/\/+$/, '');
  const escaped = concrete.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![\\w.-])`);
};

test('every ~/Library path in docs/privacy.md appears in the plugin source', () => {
  const doc = readFileSync(join(root, 'docs', 'privacy.md'), 'utf8');
  const paths = [...new Set(namedPaths(doc))];
  assert.ok(paths.length >= 12, `privacy page names ${paths.length} ~/Library paths; expected the full set`);
  const source = normalize(pluginSource());
  const missing = paths.filter(path => !concretePrefix(path).test(source));
  assert.deepEqual(missing, [],
    `paths named in docs/privacy.md but absent from plugins/sleight code: ${missing.join(', ')}`);
});
