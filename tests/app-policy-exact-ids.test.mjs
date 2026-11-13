import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { evaluateAppPolicy } from '../plugins/sleight/lib/app-policy.mjs';

// Public vendor build metadata, Apple lookup records and Homebrew casks.
// Keep literals independent of the production table. LastPass is the Mac Safari app.
const apps = [
  ['1Password', 'com.1password.1password', 'password-managers'],
  ['Bitwarden', 'com.bitwarden.desktop', 'password-managers'],
  ['Dashlane', 'com.dashlane.dashlanephonefinal', 'password-managers'],
  ['LastPass for Safari', 'com.lastpass.lastpassforsafari', 'password-managers'],
  ['KeePassXC', 'org.keepassxc.keepassxc', 'password-managers'],
  ['Enpass', 'in.sinew.Enpass-Desktop', 'password-managers'],
  ['Proton Pass', 'me.proton.pass.electron', 'password-managers'],
  ['Warp', 'dev.warp.Warp-Stable', 'terminals'],
  ['WezTerm', 'com.github.wez.wezterm', 'terminals'],
  ['kitty', 'net.kovidgoyal.kitty', 'terminals'],
  ['Alacritty', 'org.alacritty', 'terminals'],
  ['Hyper', 'co.zeit.hyper', 'terminals'],
  ['Tabby', 'org.tabby', 'terminals'],
];
const facts = { executableName: 'Editor', processAncestry: [{ kind: 'non-app' }], windowTitle: 'Draft', operation: 'read',
  secureInput: false, focusedSecureField: false };
const policy = (bundleId, extra = {}, settings = {}) =>
  evaluateAppPolicy({ ...facts, bundleId, ...extra }, settings);
const override = { allowForbiddenTargets: true };

for (const [app, bundleId, category] of apps) {
  test(`${app} public bundle ID refuses independently of its executable name`, () => {
    for (const id of [bundleId, ` ${bundleId.toUpperCase()} `]) {
      const refused = policy(id);
      assert.equal(refused.allow, false);
      assert.equal(refused.category, category);
      assert.equal(refused.code, 'FORBIDDEN_TARGET');
      assert.equal(refused.overridden, false);
      const lifted = policy(id, {}, override);
      assert.equal(lifted.allow, category === 'terminals');
      assert.equal(lifted.category, category);
      assert.equal(lifted.overridden, category === 'terminals');
    }
    assert.equal(policy(bundleId, { windowTitle: 'Settings' }, override).category, 'settings-windows');
    assert.equal(policy(bundleId, { operation: 'typeText', secureInput: true }, override).category, 'secure-input');
    assert.equal(policy(bundleId, { operation: 'setValue', focusedSecureField: true }, override).category, 'secure-field');
  });

  test(`${app} keeps its executable-name fallback with an unrelated bundle ID`, () => {
    const result = policy('test.repackaged', { executableName: app });
    assert.equal(result.allow, false);
    assert.equal(result.category, category);
  });
}

test('public exact IDs still refuse when identity heuristics are unavailable', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-policy-exact-')));
  mkdirSync(join(root, 'app-policy'));
  const read = path => readFileSync(new URL(`../plugins/sleight/lib/${path}`, import.meta.url), 'utf8');
  writeFileSync(join(root, 'app-policy.mjs'), read('app-policy.mjs'));
  for (const file of ['bundles', 'categories', 'rules']) {
    const data = JSON.parse(read(`app-policy/${file}.json`));
    // Disable the two alternative identity routes, retaining every policy guard.
    // A table omission must fail even if its bundle ID contains a known app name.
    if (file === 'rules') { data.identityShapes = {}; data.exactIdentities = {}; }
    writeFileSync(join(root, 'app-policy', `${file}.json`), JSON.stringify(data));
  }
  const isolated = (await import(pathToFileURL(join(root, 'app-policy.mjs')).href)).evaluateAppPolicy;
  assert.equal(isolated({ ...facts, bundleId: 'test.editor' }).allow, true);
  for (const [app, bundleId, category] of apps) {
    await t.test(app, () => {
      const result = isolated({ ...facts, bundleId });
      assert.equal(result.allow, false);
      assert.equal(result.category, category);
      assert.equal(result.code, 'FORBIDDEN_TARGET');
      // With heuristics disabled, suffixes and lookalikes cannot hit an exact row.
      for (const id of [`${bundleId}.unlisted`, `${bundleId}x`, `test.${bundleId}`]) {
        assert.equal(isolated({ ...facts, bundleId: id }).allow, true, id);
      }
    });
  }
});

test('earlier bundle-shape, helper and ambiguous LastPass refusals remain', () => {
  const previous = [
    ['test.password.vault', 'password-managers'],
    ['test.keychain.utility', 'password-managers'],
    ['test.bitwarden.beta', 'password-managers'],
    ['test.dashlane.legacy', 'password-managers'],
    ['com.lastpass.LastPass', 'password-managers'],
    ['com.lastpass.lastpassmacdesktop', 'password-managers'],
    ['test.keepass.beta', 'password-managers'],
    ['test.enpass.beta', 'password-managers'],
    ['test.protonpass.beta', 'password-managers'],
    ['test.terminal.beta', 'terminals'],
    ['test.iterm.beta', 'terminals'],
    ['test.ghostty.beta', 'terminals'],
    ['test.warp.beta', 'terminals'],
    ['test.wezterm.beta', 'terminals'],
    ['test.alacritty.beta', 'terminals'],
    ['test.tabby.beta', 'terminals'],
    ['co.zeit.hyper.helper.Renderer', 'terminals'],
    ['net.kovidgoyal.kitty.helper', 'terminals'],
  ];
  for (const [bundleId, category] of previous) {
    assert.equal(policy(bundleId).allow, false, bundleId);
    assert.equal(policy(bundleId).category, category, bundleId);
  }
});
