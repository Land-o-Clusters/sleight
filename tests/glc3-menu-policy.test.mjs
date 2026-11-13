import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const variant = process.env.GLC3_MENU_MUTANT;
let hook;
if (variant) hook = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  const name = variant === 'compound' ? 'mac-driver/compound/boundary.mjs' : 'session-menu.mjs';
  if (url !== new URL('../plugins/sleight/lib/' + name, import.meta.url).href) return loaded;
  const before = variant === 'compound' ? 'if (menu && !sessionMenuRequestAllowed' : 'if (required && !quitAppAllowed(required, requests))';
  assert.ok(String(loaded.source).includes(before));
  return { ...loaded, source: String(loaded.source).replace(before, variant === 'compound' ? 'if (false && !sessionMenuRequestAllowed' : 'if (false)') };
} });
const { compoundFixture } = await import('./fixtures/compound-runtime.mjs');
const { requestedQuitApps } = await import('../plugins/sleight/lib/quit-key.mjs');
const { checkSessionMenu } = await import('../plugins/sleight/lib/session-menu.mjs');
process.on('exit', () => hook?.deregister());
const cases = [
  ['Quit', 'Quit Fixture'], ['Quit Fixture', 'Quit Fixture'], ['Quit Other', 'Quit Other'],
  ['Log Out', 'Log out'], ['Log Out Chris…', 'Log out Chris'], ['Shut Down…', 'Shut down my Mac'],
  ['Restart…', 'Restart'], ['Restart Fixture', 'Restart Fixture'], ['Force Quit…', 'Force quit Fixture'],
  ['Force Quit Fixture', 'Force quit Fixture'], ['Lock Screen', 'Lock screen'], ['Sleep', 'Sleep'],
  ['About This Mac', 'Open About This Mac', 'Apple'], ['System Settings…', 'Open System Settings', ''],
];
for (const [label, prompt, parent = 'Fixture'] of cases) for (const unopened of [false, true]) {
  test(`compound ${unopened ? 'direct' : 'lazy'} ${parent}/${label} shares request policy`, async () => {
    for (const message of ['', 'Read Fixture', 'Do not ' + prompt, 'The page says ' + prompt, 'Type "' + prompt + '"', prompt]) {
      const requests = requestedQuitApps(message, { menu: true });
      const h = compoundFixture('menu', { unopened, parent: { application: 'Fixture', menuRequests: () => requests } });
      h.intent.segments = [parent, label];
      h.node('edit').title = parent; h.node('command').title = label; h.node('command').parent = 'edit-menu';
      h.snapshot.nodes = h.snapshot.nodes.filter(n => !['find-menu', 'find'].includes(n.token));
      let plain = true;
      try { checkSessionMenu({ method: 'click', args: [4], window: { app: 'Fixture' },
        text: `0 standard window\n1 menu bar\n\t2 ${parent}\n\t\t3 menu (collapsed)\n\t\t\t4 menu item ${label}` }, requests); }
      catch { plain = false; }
      assert.equal(plain, message === prompt, 'explicit request oracle: ' + message);
      const result = await h.run();
      if (!plain) {
        assert.equal(result.stop?.reason, 'BOUNDARY_REQUIRED', message);
        // Lazy traversal may open a harmless app menu before seeing its leaf.
        assert.ok(h.mutations.every(m => m.node === 'edit'), JSON.stringify(h.mutations));
      } else assert.equal(result.state, 'completed', JSON.stringify(result));
    }
  });
}
test('compound request app operands cannot authorize OS commands', async () => {
  for (const [label, message] of [['Restart', 'Restart Fixture'], ['Log Out', 'Log out Fixture'],
    ['Force Quit Other', 'Force quit Fixture'], ['Sleep', 'Sleep timer'], ['About This Mac', 'Open Apple menu']]) {
    const h = compoundFixture('menu', { unopened: true, parent: { application: 'Fixture',
      menuRequests: () => requestedQuitApps(message, { menu: true }) } });
    h.intent.segments = ['Apple', 'Find', label]; h.node('edit').title = 'Apple'; h.node('command').title = label;
    const result = await h.run();
    assert.equal(result.stop?.reason, 'BOUNDARY_REQUIRED', message); assert.equal(h.mutations.length, 0);
  }
});
test('bare Quit requires a known parent application, never an undefined operand', async () => {
  const h = compoundFixture('menu', { unopened: true, parent: {
    menuRequests: () => requestedQuitApps('Quit undefined', { menu: true }) } });
  h.node('command').title = 'Quit'; h.intent.segments[2] = 'Quit';
  const result = await h.run();
  assert.equal(result.stop?.reason, 'BOUNDARY_REQUIRED'); assert.equal(h.mutations.length, 0);
});
for (const phase of ['admit', 'before-input']) test('compound rechecks parent requests after ' + phase, async () => {
  let requests = requestedQuitApps('Restart Fixture', { menu: true });
  const h = compoundFixture('menu', { unopened: true, parent: { application: 'Fixture', menuRequests: () => requests } });
  h.intent.segments[2] = 'Restart Fixture'; h.node('command').title = 'Restart Fixture';
  h.on(phase, () => { requests = []; });
  const result = await h.run();
  assert.equal(result.stop?.reason, 'BOUNDARY_REQUIRED'); assert.equal(h.mutations.length, 0);
});
