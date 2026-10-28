import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getWorldTasks } from '../bench/world/tasks.mjs';
import { getTasks } from '../bench/tasks.mjs';
import { ccHeldOutTasks } from '../bench/world/cc-held-out.mjs';
import { executeRealTask } from '../bench/real-run.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const instructions = {
  'finder-rename': 'Rename alpha.txt to renamed.txt.',
  'finder-create-folder': 'Create an empty folder named Created and keep alpha.txt unchanged.',
};
const worldTasks = open => getWorldTasks({ defaults: getTasks('default'), real: getTasks('real'), open });

for (const id of ['finder-rename', 'finder-create-folder', 'cc-list-native']) {
  test(`${id} uses a unique parent and preserves its prompt and exact grader`, async t => {
    const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-unique-')));
    t.after(() => removeTemp(root));
    const ctx = { dir: root, nonce: 'fixed' }, requests = [];
    const open = async (_ctx, request) => { requests.push(request); return {}; };
    const task = (id === 'cc-list-native' ? ccHeldOutTasks(open) : worldTasks(open)).find(task => task.id === id);
    await task.setup(ctx);
    assert.equal(dirname(ctx.folder), root);
    assert.match(basename(ctx.folder), id === 'cc-list-native' ? /^Collections-fixed-[0-9a-f]{16}$/ : /^Files-fixed-[0-9a-f]{16}$/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].target, ctx.folder);
    assert.equal(requests[0].token, basename(ctx.folder));
    if (id === 'cc-list-native') {
      assert.equal(task.prompt(ctx), `In Finder, use only ${ctx.folder}. Show the folder as a list sorted by Name ascending. Select ${ctx.cc.target.file} and rename it to Chosen.txt. Preserve every other file and all file contents. Leave the fixture window open.`);
    } else {
      assert.equal(task.prompt(ctx), `In Finder, work only in ${ctx.folder}. ${instructions[id]} Leave the fixture window open.`);
    }
    assert.notEqual(await task.check(ctx), true);
    if (id === 'finder-create-folder') mkdirSync(join(ctx.folder, 'Created'));
    else renameSync(join(ctx.folder, id === 'cc-list-native' ? ctx.cc.target.file : 'alpha.txt'),
      join(ctx.folder, id === 'cc-list-native' ? 'Chosen.txt' : 'renamed.txt'));
    assert.equal(await task.check(ctx), true);
    writeFileSync(join(ctx.folder, 'unexpected.txt'), 'extra');
    assert.notEqual(await task.check(ctx), true);
    const first = ctx.folder;
    await task.prepare(ctx);
    assert.notEqual(ctx.folder, first, 'the same task nonce must still get a fresh crypto suffix');
    assert.ok(existsSync(first), 'preparation cannot remove a previous fixture');
  });

  test(`${id} cleanup removes only its created task folder inside the fixture root`, async t => {
    const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-cleanup-')));
    t.after(() => removeTemp(bank));
    const dir = join(bank, 'owned-run'), sibling = join(bank, 'other-run');
    mkdirSync(sibling);
    let folder, otherFolder;
    const open = async (ctx, request) => {
      folder = request.target;
      assert.equal(dirname(folder), dir);
      otherFolder = join(sibling, basename(folder));
      mkdirSync(otherFolder);
      writeFileSync(join(otherFolder, 'preserve.txt'), 'untouched');
      return {};
    };
    const task = (id === 'cc-list-native' ? ccHeldOutTasks(open) : worldTasks(open)).find(task => task.id === id);
    const result = await executeRealTask(task, { dir, fixtureRoot: bank, nonce: 'fixed' },
      { setupOnly: true, lockHeld: true });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(dir), false);
    assert.equal(readFileSync(join(otherFolder, 'preserve.txt'), 'utf8'), 'untouched');
    assert.ok(existsSync(bank));
  });
}
