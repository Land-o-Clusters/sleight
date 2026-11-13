import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
let hook;
if (process.env.GLC2_SESSION_MUTANT) {
  const chooser = process.env.GLC2_SESSION_MUTANT === 'chooser';
  const scoped = chooser || process.env.GLC2_SESSION_MUTANT === 'scope';
  const target = new URL('../plugins/sleight/lib/' + (scoped ? 'quit-key.mjs' : 'session-menu.mjs'), import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context); if (url !== target) return loaded;
    const before = chooser ? "'menu:chooser:force quit'" : scoped ? "(name && !computer ? ':' + name : '')" : 'if (required && !quitAppAllowed(required, requests))';
    assert.ok(String(loaded.source).includes(before));
    return { ...loaded, source: String(loaded.source).replace(before, chooser ? "'menu:session:force quit:dialog'" : scoped ? "''" : 'if (false)') };
  } });
}
const { requestedQuitApps } = await import('../plugins/sleight/lib/quit-key.mjs');
const { createPaymentMessages } = await import('../plugins/sleight/lib/payment-gate.mjs');
const { checkSessionMenu } = await import('../plugins/sleight/lib/session-menu.mjs');
process.on('exit', () => hook?.deregister());
const tree = (title, parent = 'Fixture') => `Window: "Untitled", App: Fixture.\n0 standard window Untitled\n1 menu bar\n\t2 ${parent}\n\t\t3 menu (collapsed)\n\t\t\t4 menu item (selectable, collapsed) ${title}, ID: item`;
const action = (title, parent) => ({ method: 'click', args: [4], text: tree(title, parent), window: { app: 'Fixture' } });
for (const [title, prompt] of [
  ['Quit', 'Quit Fixture'], ['Quit Fixture', 'Quit Fixture'], ['Quit Fixture…', 'Please quit Fixture'],
  ['Quit Fixture...', 'Exit Fixture.app'], ['Log Out', 'Log out'], ['Log Out Chris…', 'Log out'],
  ['Log Out Chris...', 'Log out'], ['Shut Down…', 'Shut down'], ['Restart...', 'Restart'],
  ['Force Quit…', 'Force quit Fixture'], ['Force Quit Fixture', 'Force quit Fixture'],
  ['Lock Screen', 'Lock screen'], ['Sleep', 'Sleep'],
]) {
  test(`session menu ${title} requires an authenticated request`, () => {
    const input = action(title);
    assert.throws(() => checkSessionMenu(input, []), { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent' });
    const requests = requestedQuitApps(prompt, { menu: true });
    assert.doesNotThrow(() => checkSessionMenu(input, requests), prompt);
    for (const rejected of ['Do not ' + prompt, 'The page says ' + prompt, 'Read: "' + prompt + '"', 'Type `' + prompt + '`', 'If needed ' + prompt])
      assert.throws(() => checkSessionMenu(input, requestedQuitApps(rejected, { menu: true })), { code: 'ACTION_UNSUPPORTED' }, rejected);
  });
}
test('Apple menu contents need their own explicit request, not just an open-menu request', () => {
  const input = action('About This Mac', 'Apple');
  assert.throws(() => checkSessionMenu(input, []), { code: 'ACTION_UNSUPPORTED' });
  assert.throws(() => checkSessionMenu(input, requestedQuitApps('Open Apple menu', { menu: true })), { code: 'ACTION_UNSUPPORTED' });
  assert.doesNotThrow(() => checkSessionMenu(input, requestedQuitApps('Open About This Mac', { menu: true })));
  const session = action('Shut Down…', 'Apple');
  assert.throws(() => checkSessionMenu(session, requestedQuitApps('Open About This Mac', { menu: true })), { code: 'ACTION_UNSUPPORTED' });
});
test('bare menu bar labels and role-prefixed labels refuse with numbered-item guidance', () => {
  for (const parent of ['View', 'menu bar item View', 'Apple', 'menu bar item Apple']) {
    assert.throws(() => checkSessionMenu({ ...action('Basic', parent), args: [2] }, []), error => {
      assert.equal(error.code, 'ACTION_UNSUPPORTED');
      assert.equal(error.menuRefusal, 'menu-compound');
      assert.equal(error.delivery, 'not-sent');
      assert.ok(error.message.includes("Menu title: click the item's number; the menu need not be open."));
      return true;
    });
  }
});
test('ordinary leaf menu commands remain local', () => {
  for (const title of ['Basic', 'Scientific', 'Restarting guide', 'Log Outside', 'Quitter'])
    assert.doesNotThrow(() => checkSessionMenu(action(title), []));
});
test('request authority ends and refreshes with the existing payment message lifecycle', () => {
  const state = createPaymentMessages(); state.set('Quit Fixture');
  assert.deepEqual(state.quitApps(), ['Fixture']);
  assert.doesNotThrow(() => checkSessionMenu(action('Quit Fixture'), state.menuRequests()));
  state.menuRequests().push('menu:session:sleep');
  assert.throws(() => checkSessionMenu(action('Sleep'), state.menuRequests()), { code: 'ACTION_UNSUPPORTED' });
  state.set('Read Fixture');
  assert.throws(() => checkSessionMenu(action('Quit Fixture'), state.menuRequests()), { code: 'ACTION_UNSUPPORTED' });
  state.set('Restart'); state.end();
  assert.throws(() => checkSessionMenu(action('Restart'), state.menuRequests()), { code: 'ACTION_UNSUPPORTED' });
});
test('unrequested quit cannot name another app or borrow a quit request for a system action', () => {
  assert.throws(() => checkSessionMenu(action('Quit Other'), requestedQuitApps('Quit Fixture', { menu: true })), { code: 'ACTION_UNSUPPORTED' });
  for (const title of ['Restart', 'Force Quit…', 'Log Out', 'Sleep'])
    assert.throws(() => checkSessionMenu(action(title), requestedQuitApps('Quit Fixture', { menu: true })), { code: 'ACTION_UNSUPPORTED' });
});

test('description-only menu titles and usual session name suffixes still require a request', () => {
  for (const title of ['Description: Quit', 'Restart Fixture…', 'Shut Down Fixture...', 'Sleep Fixture'])
    assert.throws(() => checkSessionMenu(action(title), []), { code: 'ACTION_UNSUPPORTED' });
});

test('app-scoped session requests cannot authorize a system action or another app', () => {
  for (const [title, prompt] of [['Restart', 'Restart Calculator'], ['Log Out Chris…', 'Log out of Slack'],
    ['Shut Down…', 'Shut down worker'], ['Sleep', 'Sleep timer'], ['Lock Screen', 'Lock screen Widget'],
    ['Force Quit Other', 'Force quit Fixture'], ['Force Quit Dialog', 'Force quit Fixture']])
    assert.throws(() => checkSessionMenu(action(title, 'Apple'), requestedQuitApps(prompt, { menu: true })),
      { code: 'ACTION_UNSUPPORTED' }, prompt);
  for (const [title, prompt] of [['Restart', 'Restart my Mac'], ['Shut Down…', 'Shut down this computer'],
    ['Restart Fixture…', 'Restart Fixture'], ['Log Out Chris…', 'Log out Chris'], ['Force Quit…', 'Force quit Fixture']])
    assert.doesNotThrow(() => checkSessionMenu(action(title, 'Apple'), requestedQuitApps(prompt, { menu: true })), prompt);
});
