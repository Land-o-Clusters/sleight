import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, realpathSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreapprovedApps, addPreapproved, cleanPreapproved, listPreapproved, preapprovedFile, removePreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { allowCommand } from '../plugins/sleight/lib/launch.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const home = t => trackTemp(registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-always-')))));
const now = new Date('2026-10-10T15:00:00Z');

test('Always allow creates a private list with the date, keeps hand entries, and raises but never lowers a level', t => {
  const h = home(t);
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

test('the list refuses a bad date or source, a shared file, and a bad level', t => {
  assert.throws(() => new PreapprovedApps({ version: 1, apps: [{ app: 'A', riskLevel: 'low', added: 'yesterday' }] }));
  assert.throws(() => new PreapprovedApps({ version: 1, apps: [{ app: 'A', riskLevel: 'low', source: 'claude' }] }));
  assert.throws(() => addPreapproved('A', 'extreme', { home: home(t), now }));
  const h = home(t);
  mkdirSync(join(h, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
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

// FA6 (owner, 2026-11-10): a 2.0 build records `launchTeam`. This version reads the list as if the field were absent.
const teamless = [{ app: 'com.apple.TextEdit', riskLevel: 'medium', source: 'always-allow', added: '2026-11-10' },
  { app: 'com.example.Tool', riskLevel: 'low' }, { app: 'com.example.Tool', riskLevel: 'high' }];
const teamed = teamless.map((entry, i) => ({ ...entry, launchTeam: ['apple', 'FIXTURE123', 'FIXTURE123'][i] }));
test('launchTeam entries grant exactly what the same entries grant without it', t => {
  const without = new PreapprovedApps({ version: 1, apps: teamless }), withTeam = new PreapprovedApps({ version: 1, apps: teamed });
  assert.deepEqual(withTeam.list(), without.list()); assert.equal(withTeam.size, without.size);
  assert.equal(withTeam.duplicates, without.duplicates);
  for (const app of ['com.apple.TextEdit', 'com.example.Tool', 'apple', 'FIXTURE123', 'Mail']) for (const risk of ['low', 'medium', 'high']) {
    assert.equal(withTeam.allows(app, risk), without.allows(app, risk), `${app} ${risk}`);
  }
  const [h, plain] = [home(t), home(t)];
  for (const [where, apps] of [[h, teamed], [plain, teamless]]) {
    mkdirSync(join(where, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
    writeFileSync(preapprovedFile(where), JSON.stringify({ version: 1, apps }), { mode: 0o600 });
  }
  assert.deepEqual(listPreapproved({ home: h }).map(({ launchTeam, ...entry }) => entry), listPreapproved({ home: plain }));
  assert.deepEqual(listPreapproved({ home: h }).map(a => [a.app, a.riskLevel, a.launchTeam]), [['com.apple.TextEdit', 'medium', 'apple'], ['com.example.Tool', 'low', 'FIXTURE123']]);
  // An edit keeps a team every copy agrees on and adds none.
  assert.equal(addPreapproved('Chess', 'low', { home: h, now }), true);
  assert.equal(addPreapproved('com.apple.TextEdit', 'high', { home: h, now }), true);
  assert.deepEqual(JSON.parse(readFileSync(preapprovedFile(h), 'utf8')).apps.map(a => [a.app, a.riskLevel, a.launchTeam]),
    [['com.apple.TextEdit', 'high', 'apple'], ['com.example.Tool', 'low', 'FIXTURE123'], ['Chess', 'low', undefined]]);
  assert.equal(removePreapproved('com.apple.TextEdit', { home: h }), true);
  assert.deepEqual(listPreapproved({ home: h }).map(a => a.app), ['com.example.Tool', 'Chess']);
});
test('duplicates that disagree on launchTeam rewrite without one', () => {
  for (const [second, kept] of [['FIXTURE123', 'FIXTURE123'], ['OTHERTEAM1', undefined], [undefined, undefined]]) {
    const apps = [{ app: 'A', riskLevel: 'high', launchTeam: 'FIXTURE123' }, { app: 'A', riskLevel: 'low', ...(second && { launchTeam: second }) }];
    assert.deepEqual(cleanPreapproved({ version: 1, apps }).apps.map(a => a.launchTeam), [kept]);
  }
});
test('a malformed launchTeam still rejects the whole list, like any unknown shape', () => {
  for (const launchTeam of [42, null, true, [], {}, '', 'adhoc', 'lowercase1', 'TOO-LONG-TEAM', 'APPLE', ' apple']) {
    assert.throws(() => new PreapprovedApps({ version: 1, apps: [...teamless, { app: 'B', riskLevel: 'low', launchTeam }] }), /invalid app entry/, String(launchTeam));
  }
  assert.throws(() => new PreapprovedApps({ version: 1, apps: [{ app: 'B', riskLevel: 'low', launchTeam: 'apple', signer: 'apple' }] }), /invalid app entry/);
});
