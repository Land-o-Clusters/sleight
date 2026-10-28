// The save receipt, the no-require note and SLEIGHT_OPEN_RULES=short (Fable study, 2026-10-17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createReadCompactor, fileReceipt, spotlightTypes, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { createRelay, usesRequire, requireOnly, openFileRules } from '../plugins/sleight/lib/relay.mjs';
import { skillRules } from '../plugins/sleight/lib/launch.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const text = text => ({ type: 'text', text });
const tick = () => new Promise(resolve => setImmediate(resolve));
const body = result => result.content.map(c => c.text ?? '').join('\n');
const skillPath = new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url);
const baseline = JSON.parse((await import('node:fs')).readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));

function tempDir(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-receipt-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the receipt names the size from stat and the kind from the type identifier, never the content', t => {
  const dir = tempDir(t), url = name => pathToFileURL(join(dir, name)).href;
  // The content says RTF; the identifier and extension decide.
  for (const name of ['a.txt', 'a.rtf', 'a.pdf', 'a.docx', 'a.json', 'noext']) writeFileSync(join(dir, name), '{\\rtf1 x}');
  mkdirSync(join(dir, 'a.rtfd'));
  const asked = [], types = map => path => { asked.push(path); return map[path.split('/').at(-1)]; };
  const spotlight = types({ 'a.txt': ['public.utf8-plain-text', 'public.plain-text', 'public.text'],
    'a.docx': ['org.openxmlformats.wordprocessingml.document', 'public.data'], 'a.rtfd': ['com.apple.rtfd', 'com.apple.package'] });
  assert.equal(fileReceipt(url('a.txt'), spotlight), 'on disk: 9 bytes, plain text');
  assert.equal(fileReceipt(url('a.docx'), spotlight), 'on disk: 9 bytes, document');
  assert.equal(fileReceipt(url('a.rtfd'), spotlight), 'on disk: a package folder, rich text with attachments');
  // Without a Spotlight identifier, the extension decides.
  assert.equal(fileReceipt(url('a.rtf'), spotlight), 'on disk: 9 bytes, rich text (RTF)');
  assert.equal(fileReceipt(url('a.pdf'), spotlight), 'on disk: 9 bytes, PDF');
  assert.equal(fileReceipt(url('a.json'), spotlight), 'on disk: 9 bytes, .json file');
  assert.equal(fileReceipt(url('noext'), spotlight), 'on disk: 9 bytes, unknown type');
  assert.equal(fileReceipt(url('missing.txt'), spotlight), undefined);
  assert.ok(asked.every(path => path.startsWith(dir)));
});

test('Spotlight gives a checked-in Markdown file its identifier and conformance', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const types = spotlightTypes(new URL('../README.md', import.meta.url).pathname);
  if (types === undefined) return; // an unindexed checkout falls back to the extension
  assert.ok(types.includes('public.plain-text'), JSON.stringify(types));
  assert.match(fileReceipt(new URL('../README.md', import.meta.url).href), /^on disk: \d+ bytes, plain text$/);
});

test('a confirmed save carries the receipt and an unconfirmed one does not', t => {
  const dir = tempDir(t), file = join(dir, 'a.txt');
  writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
  const url = pathToFileURL(file).href;
  const doc = `Window: "a.txt", App: TextEdit.\n0 standard window a.txt, URL: ${url}\n\t1 text entry area (settable) First Text View, Value: before`;
  const save = write => {
    const c = createReadCompactor(); c.process([text(doc)]);
    const action = c.beginAction('await app.pressKey("super+s")');
    if (write) { writeFileSync(file, 'after!'); utimesSync(file, 2000, 2000); } else utimesSync(file, 1000, 1000);
    return c.process([text(GUARD_MARK + doc + GUARD_END)], { action }).find(item => /^sleight: /.test(item.text))?.text;
  };
  assert.match(save(true), /saved: observed ".*a\.txt" \(its file on disk changed during this call\); on disk: 6 bytes, plain text\.$/);
  const unconfirmed = save(false);
  assert.match(unconfirmed, /saved: not confirmed/);
  assert.doesNotMatch(unconfirmed, /on disk:/);
});

test('require is found in code, not in strings or comments', () => {
  assert.ok(usesRequire('const fs = require("fs"); nodeRepl.write(fs.statSync("/tmp/a").size)'));
  assert.ok(usesRequire('nodeRepl.write(require ("fs").readFileSync(p, "utf8"))'));
  assert.ok(!usesRequire('await app.paste("require(\\"fs\\")")'));
  assert.ok(!usesRequire('// require("fs")\nawait app.getAXState()'));
  assert.ok(!usesRequire('await app.typeText(`x`); obj.require("fs")'));
  assert.ok(requireOnly('const fs = require("fs"); nodeRepl.write(fs.statSync("/tmp/a").size)'));
  assert.ok(!requireOnly('await app.pressKey("super+s"); const fs = require("fs")'));
  assert.ok(!requireOnly('const fs = require("fs"); let app = await cua.getApp("Editor")'));
});

function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false, ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  return { sent, received, send,
    call: (id, code) => send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }),
    reply: (id, content, isError = false) => serverOut.write(JSON.stringify({ id, result: { content, isError } }) + '\n'),
    result: id => received.find(m => m.id === id)?.result };
}

for (const prompt of [undefined, 'lean']) test(`a require-only call stops before the engine and names the receipt after a save: ${prompt}`, async t => {
  const h = harness(t, { prompt });
  h.call(1, 'const fs = require("fs"); nodeRepl.write(fs.statSync("/tmp/a.txt").size)'); await tick();
  assert.equal(h.sent.filter(m => m.id === 1).length, 0, 'never reaches the engine');
  const first = body(h.result(1));
  assert.equal(h.result(1).isError, true);
  assert.match(first, /`js` has no `require` (?:and no file system|or file) access\./);
  assert.doesNotMatch(first, /on disk/);
  h.call(2, 'await app.pressKey("super+s")'); await tick();
  h.reply(2, [text('sleight: saved: observed "file:///tmp/a.txt" (its file on disk changed during this call); on disk: 5 bytes, plain text.')]); await tick();
  h.call(3, 'nodeRepl.write(require("fs").readFileSync("/tmp/a.txt", "utf8"))'); await tick();
  assert.match(body(h.result(3)), /`on disk:` .*gives (?:the saved file's )?size and kind\./);
  if (prompt === 'lean') assert.ok(body(h.result(3)).length < 110, body(h.result(3)));
});

test('a call that also uses the engine runs, with the note after its result', async t => {
  const h = harness(t);
  h.call(1, 'await app.pressKey("super+s"); const fs = require("fs")'); await tick();
  assert.equal(h.sent.filter(m => m.id === 1).length, 1);
  h.reply(1, [text('ReferenceError: require is not defined')], true); await tick();
  const out = body(h.result(1));
  assert.match(out, /ReferenceError: require is not defined\nsleight: `js` has no `require` and no file system access\./);
  h.call(2, 'await app.paste("require(\\"fs\\")")'); await tick();
  h.reply(2, [text('pasted')]); await tick();
  assert.doesNotMatch(body(h.result(2)), /require/);
});

test('open rules keep every safety passage and drop what an open already did', () => {
  for (const env of [{}, { SLEIGHT_PROMPT: 'lean' }]) {
    const full = skillRules(skillPath, env).replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, '').trim();
    const short = openFileRules(full);
    for (const passage of baseline.skillSafety) assert.ok(short.includes(passage), passage);
    assert.ok(short.length < full.length * (env.SLEIGHT_PROMPT ? 0.9 : 0.8), `${short.length} of ${full.length}`);
    assert.doesNotMatch(short, /select_window|tap coordinates|coordinates by screenshot multiplier|--doctor|trigger hover|Selected text:|Rows, text selected|Reorder rows/);
    assert.doesNotMatch(short, /\n\n\n|## [^\n]*\n\n## /);
    if (!env.SLEIGHT_PROMPT) {
      assert.match(short, /`typeText\(text\)` and `pressKey\(key\)` take no element\. `click\(target\)` first\./);
      assert.doesNotMatch(short, /List exceeds visible rows/);
      assert.match(short, /End on the action\./);
      assert.match(short, /app\.paste\("text"\)/);
      assert.match(short, /Submit in that call only when the user asked/);
    }
  }
});

const docs = '## Computer Use\nNative API reference.';
const tree = 'Window: "note.txt", App: Example.\n0 standard window note.txt\n\t1 text area Value: draft';
const rules = '# Rules\n\nNever create or edit preapproved.json.\n\n## Calls\n\n- When the task specifies an app, acquire it.\n- End on the action.\n\n## sleight\'s other tools\n\n- `notifications` presses buttons.\n\nIf `js` fails to start, run doctor.';
for (const openRules of ['full', 'short']) test(`SLEIGHT_OPEN_RULES=${openRules} on an open_file result, then the first js result`, async t => {
  const h = harness(t, { openRules, firstCallRules: rules,
    localTools: { tools: [{ name: 'open_file' }], call: async () => ({ content: [text('Opened note.txt.')],
      _meta: { 'sleight/openedApp': 'org.example.editor' } }) } });
  h.send({ id: 1, method: 'tools/call', params: { name: 'open_file', arguments: { app: 'Example', path: '/tmp/note.txt' } } });
  await tick();
  h.reply(h.sent.at(-1).id, [text(docs), text(tree)]); await tick();
  const opened = body(h.result(1));
  assert.match(opened, /Never create or edit preapproved\.json\./);
  assert.match(opened, /End on the action\./);
  assert.equal(/When the task specifies an app|notifications|doctor/.test(opened), openRules === 'full');
  h.call(2, 'await app.click(1)'); await tick();
  h.reply(2, [text('clicked')]); await tick();
  const next = body(h.result(2));
  assert.match(next, /Native API reference/);
  assert.equal(next.includes(rules), openRules === 'short');
  h.call(3, 'await app.click(1)'); await tick();
  h.reply(3, [text('clicked')]); await tick();
  assert.doesNotMatch(body(h.result(3)), /Never create/);
});
