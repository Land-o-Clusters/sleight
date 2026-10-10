import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreapprovedApps, addPreapproved, listPreapproved, preapprovedFile, removePreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { allowCommand } from '../plugins/sleight/lib/launch.mjs';

const home = () => mkdtempSync(join(tmpdir(), 'sleight-always-'));
const now = new Date('2026-10-10T15:00:00Z');

test('Always allow creates a private list with the date, keeps hand entries, and raises but never lowers a level', () => {
  const h = home();
  assert.equal(addPreapproved('com.apple.TextEdit', 'medium', { home: h, now }), true);
  const file = preapprovedFile(h);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).apps, [{ app: 'com.apple.TextEdit', riskLevel: 'medium', added: '2026-10-10', source: 'always-allow' }]);
  assert.equal(addPreapproved('com.apple.TextEdit', 'low', { home: h, now }), false);
  assert.equal(addPreapproved('com.apple.TextEdit', 'high', { home: h, now }), true);
  assert.equal(listPreapproved({ home: h })[0].riskLevel, 'high');
  writeFileSync(file, JSON.stringify({ version: 1, apps: [{ app: 'Calculator', riskLevel: 'high' }] }), { mode: 0o600 });
  addPreapproved('Chess', 'low', { home: h, now });
  assert.deepEqual(listPreapproved({ home: h }).map(a => a.app), ['Calculator', 'Chess']);
  assert.equal(removePreapproved('Calculator', { home: h }), true);
  assert.equal(removePreapproved('Calculator', { home: h }), false);
  assert.deepEqual(listPreapproved({ home: h }).map(a => a.app), ['Chess']);
});

test('the list refuses a bad date or source, a shared file, and a bad level', () => {
  assert.throws(() => new PreapprovedApps({ version: 1, apps: [{ app: 'A', riskLevel: 'low', added: 'yesterday' }] }));
  assert.throws(() => new PreapprovedApps({ version: 1, apps: [{ app: 'A', riskLevel: 'low', source: 'claude' }] }));
  assert.throws(() => addPreapproved('A', 'extreme', { home: home(), now }));
  const h = home();
  mkdirSync(join(h, 'Library/Application Support/sleight'), { recursive: true });
  writeFileSync(preapprovedFile(h), JSON.stringify({ version: 1, apps: [] }), { mode: 0o666 });
  chmodSync(preapprovedFile(h), 0o666);
  assert.throws(() => addPreapproved('A', 'low', { home: h, now }), /writable/);
});

test('sleight-mcp allow lists and removes', () => {
  const out = [];
  const apps = [{ app: 'Calculator', riskLevel: 'high' }, { app: 'com.apple.TextEdit', riskLevel: 'medium', added: '2026-10-10', source: 'always-allow' }];
  assert.equal(allowCommand(['allow', 'list'], { list: () => apps, out: t => out.push(t) }), 0);
  assert.match(out[0], /Calculator {2}high\ncom\.apple\.TextEdit {2}medium {2}added 2026-10-10 by Always allow/);
  assert.equal(allowCommand(['allow', 'remove', 'Calculator'], { remove: () => true, out: t => out.push(t) }), 0);
  assert.match(out[1], /Removed Calculator/);
  assert.equal(allowCommand(['allow'], { out: t => out.push(t) }), 2);
});
