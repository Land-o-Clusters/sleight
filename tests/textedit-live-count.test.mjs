import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function list(apps) {
  return { count: apps.length, objectAtIndex: i => apps[i] };
}
function app(overrides) {
  return { processIdentifier: 1, localizedName: 'TextEdit', isTerminated: false, isFinishedLaunching: true, ...overrides };
}
function load(rel) {
  const sandbox = { ObjC: { import() {}, unwrap: value => value } };
  runInNewContext(readFileSync(new URL(rel, import.meta.url), 'utf8'), sandbox);
  return sandbox.oneLiveTextEdit;
}

for (const file of ['../bench/small-fixes-textedit.js', '../bench/textedit-fixes-fixture.js']) {
  test(`${file} ignores a terminated TextEdit entry`, () => {
    const one = load(file);
    const live = app({ processIdentifier: 11 });
    assert.equal(one(list([app({ processIdentifier: 10, isTerminated: true }), live])), live);
  });
  test(`${file} accepts the one TextEdit still launching`, () => {
    const one = load(file);
    const launching = app({ processIdentifier: 13, isFinishedLaunching: false });
    assert.equal(one(list([launching])), launching);
  });
  test(`${file} names two live TextEdit processes`, () => {
    const one = load(file);
    assert.throws(() => one(list([
      app({ processIdentifier: 11, localizedName: 'TextEdit' }),
      app({ processIdentifier: 12, localizedName: 'TextEdit' }),
    ])), /Ambiguous TextEdit process: TextEdit pid 11, TextEdit pid 12/);
  });
}
