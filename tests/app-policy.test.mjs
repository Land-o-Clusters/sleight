import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAppPolicy } from '../plugins/sleight/lib/app-policy.mjs';

// Supply trusted facts explicitly; malformed-input tests call the export directly.
const facts = { executableName: 'Editor', processAncestry: [{ kind: 'non-app' }], windowTitle: 'Draft', operation: 'read',
  secureInput: false, focusedSecureField: false };
const policy = (target, settings) => evaluateAppPolicy({ ...facts, ...target }, settings);
const invalid = result => {
  assert.equal(result.allow, false);
  assert.equal(result.code, 'APP_POLICY_INVALID_METADATA');
  assert.equal(typeof result.cause, 'string');
  assert.ok(result.cause.length > 0);
  assert.equal(result.overridden, false);
};

const cases = [
  ['password-managers', 'com.apple.Passwords', /passwords and other secrets/],
  ['terminals', 'com.apple.Terminal', /type and run commands/],
  ['authentication-agents', 'com.apple.SecurityAgent', /approve authentication/],
  ['protected-system-surfaces', 'com.apple.dock', /control the desktop and session/],
  ['agent-hosts', 'com.anthropic.claudefordesktop', /approve another agent/],
  ['settings-windows', 'com.openai.codex', /change approval or safety settings/],
  ['secure-input', 'test.editor', /secure input/],
  ['secure-field', 'test.editor', /secure field/],
];
const request = (category, bundleId) => ({ bundleId, windowTitle: category === 'settings-windows' ? 'Settings' : 'Draft',
  operation: category === 'secure-field' ? 'setValue' : 'typeText',
  secureInput: category === 'secure-input', focusedSecureField: category === 'secure-field' });

for (const [category, bundleId, risk] of cases) {
  test(`${category} refuses with its sentence and category`, () => {
    const result = policy(request(category, bundleId));
    assert.equal(result.allow, false);
    assert.equal(result.category, category);
    assert.equal(typeof result.sentence, 'string');
    assert.match(result.sentence, /sleight refuses/);
    assert.ok(result.sentence.endsWith('.'));
    assert.equal(result.code, category === 'secure-field' ? 'SECURE_FIELD' : category === 'secure-input' ? 'SECURE_INPUT_ACTIVE' : 'FORBIDDEN_TARGET');
  });
  test(`${category} supplies the card's concrete risk wording`, () => {
    assert.match(policy(request(category, bundleId)).cardRisk, risk);
  });
}

test('the trusted relay ancestry identifies its otherwise ordinary app host', () => {
  const result = policy({ bundleId: 'test.editor', processAncestry: [
    { kind: 'non-app' }, { pid: 80, bundleId: 'test.editor' }, { kind: 'non-app' },
  ] });
  assert.equal(result.allow, false);
  assert.equal(result.category, 'agent-hosts');
  assert.match(result.cardRisk, /approve another agent/);
  assert.equal(policy({ bundleId: 'test.other', processAncestry: [{ bundleId: 'test.editor' }] }).allow, true);
});

test('OpenAI apps remain refused until the user-only setting is supplied by the caller', () => {
  for (const bundleId of ['com.openai.chat', 'com.openai.codex', 'com.openai.atlas', 'com.openai.chat.beta', 'com.openai.atlas.beta']) {
    assert.equal(policy({ bundleId }).allow, false, bundleId);
    const result = policy({ bundleId }, { allowForbiddenTargets: true });
    assert.equal(result.allow, true, bundleId);
    assert.equal(result.category, 'agent-hosts');
    assert.match(result.cardRisk, /approve another agent/);
  }
  for (const value of [false, 'true', 1, null]) assert.equal(policy({ bundleId: 'com.openai.codex' }, { allowForbiddenTargets: value }).allow, false);
  assert.equal(policy({ bundleId: 'com.openai.codex', allowForbiddenTargets: true }).allow, false);
});

test('the existing title matcher protects restricted apps even with the setting enabled', () => {
  for (const windowTitle of ['Settings', ' Preferences... ', 'Réglages', 'Einstellungen', 'Impostazioni', 'Configuración',
    'Ajustes', 'Preferencias', '設定', '设置', '偏好设置']) {
    const result = policy({ bundleId: 'com.openai.codex', windowTitle }, { allowForbiddenTargets: true });
    assert.equal(result.allow, false, windowTitle);
    assert.equal(result.category, 'settings-windows');
  }
  for (const windowTitle of ['General', 'Profiles', 'Window Groups', 'Encodings', 'Advanced']) {
    assert.equal(policy({ bundleId: 'com.apple.Terminal', windowTitle }, { allowForbiddenTargets: true }).category, 'settings-windows');
  }
  assert.equal(policy({ bundleId: 'test.editor', windowTitle: 'Settings' }).allow, true);
  assert.equal(policy({ bundleId: 'com.openai.codex', windowTitle: 'Settings for a story' }, { allowForbiddenTargets: true }).allow, false);
});

test('the setting lifts terminals with a risk card but preserves other restrictions', () => {
  assert.equal(policy({ bundleId: 'com.mitchellh.ghostty' }).category, 'terminals');
  assert.match(policy({ bundleId: 'com.googlecode.iterm2' }, { allowForbiddenTargets: true }).cardRisk, /run commands/);
  assert.equal(policy({ bundleId: 'com.apple.Terminal' }, { allowForbiddenTargets: true }).allow, true);
  for (const bundleId of ['com.apple.Passwords', 'com.apple.SecurityAgent', 'com.apple.dock', 'com.anthropic.claudefordesktop']) {
    assert.equal(policy({ bundleId }, { allowForbiddenTargets: true }).allow, false, bundleId);
  }
  assert.equal(policy({ bundleId: 'test.editor', processAncestry: [{ bundleId: 'test.editor' }] }, { allowForbiddenTargets: true }).allow, false);
});

test('secure input refuses key methods only while held and survives an app override', () => {
  for (const operation of ['typeText', 'pressKey', 'paste', 'modifiers']) {
    const target = { bundleId: 'test.editor', operation };
    assert.equal(policy({ ...target, secureInput: true }).category, 'secure-input', operation);
    assert.equal(policy({ ...target, secureInput: false }).allow, true, operation);
  }
  for (const operation of ['read', 'getAXState', 'getScreenshot', 'click', 'scroll']) {
    assert.equal(policy({ bundleId: 'test.editor', operation, secureInput: true }).allow, true, operation);
  }
  assert.equal(policy({ bundleId: 'com.apple.Terminal', operation: 'pressKey', secureInput: true }, { allowForbiddenTargets: true }).category, 'secure-input');
});

test('a focused secure field refuses semantic writes, including actions targeting other elements', () => {
  for (const operation of ['setValue', 'selectText', 'performSecondaryAction']) {
    const result = policy({ bundleId: 'test.editor', operation, focusedSecureField: true });
    assert.equal(result.code, 'SECURE_FIELD', operation);
    assert.equal(result.allow, false);
  }
  for (const operation of ['getAXState', 'getScreenshot', 'click', 'scroll']) {
    assert.equal(policy({ bundleId: 'test.editor', operation, focusedSecureField: true }).allow, true, operation);
  }
  assert.equal(policy({ bundleId: 'test.editor', operation: 'setValue', focusedSecureField: false }).allow, true);
});

test('bundle matching normalizes case without treating utilities as forbidden', () => {
  assert.equal(policy({ bundleId: ' COM.APPLE.TERMINAL ' }).category, 'terminals');
  for (const bundleId of ['com.openaiish.chat', 'test.utilities']) {
    assert.equal(policy({ bundleId, launchServicesCategory: 'public.app-category.utilities' }).allow, true, bundleId);
  }
});

test('incomplete identity metadata cannot produce an allow decision', () => {
  for (const bundleId of [undefined, '', ' ', null, 7]) invalid(policy({ bundleId }));
  invalid(policy({ bundleId: 'test.editor', processAncestry: 'test.editor' }));
});

test('system and authentication identities are refused independently of display names', () => {
  for (const bundleId of ['com.apple.dock', 'com.apple.controlcenter', 'com.apple.notificationcenterui',
    'com.apple.UserNotificationCenter', 'com.apple.WindowManager', 'com.apple.AccessibilityUIServer',
    'com.apple.loginwindow', 'com.apple.LockScreen']) {
    assert.equal(policy({ bundleId, windowTitle: 'Draft' }).category, 'protected-system-surfaces', bundleId);
  }
  assert.equal(policy({ bundleId: 'com.apple.LocalAuthentication.UIAgent' }).category, 'authentication-agents');
});

// Each case reaches the exported policy; expectations are independent fixtures.
for (const [bundleId, category] of [
  ['com.apple.keychainaccess', 'password-managers'],
  ['com.apple.systempreferences', 'settings-windows'],
  ['com.apple.systemuiserver', 'protected-system-surfaces'],
  ['com.apple.coreservices.uiagent', 'protected-system-surfaces'],
  ['com.apple.UniversalAccessControl', 'protected-system-surfaces'],
  ['com.anthropic.claudefordesktop.helper', 'agent-hosts'],
  ['com.anthropic.claudefordesktop.helper.renderer', 'agent-hosts'],
  ['com.todesktop.230313mzl4w4u92', 'agent-hosts'],
  ['com.google.antigravity', 'agent-hosts'],
  ['ai.opencode.desktop', 'agent-hosts'],
]) test(`verified identity ${bundleId} refuses despite a user override`, () => {
  const result = policy({ bundleId, windowTitle: 'Untitled' }, { allowForbiddenTargets: true });
  assert.equal(result.allow, false);
  assert.equal(result.category, category);
});

for (const shape of ['password', 'keychain', '1password', 'bitwarden', 'dashlane', 'lastpass', 'keepassxc',
  'enpass', 'protonpass', 'terminal', 'iterm', 'ghostty', 'warp', 'wezterm', 'alacritty', 'tabby',
  'chatgpt', 'windsurf', 'antigravity', 'opencode']) {
  const category = ['password', 'keychain', '1password', 'bitwarden', 'dashlane', 'lastpass', 'keepassxc',
    'enpass', 'protonpass'].includes(shape) ? 'password-managers' :
    ['terminal', 'iterm', 'ghostty', 'warp', 'wezterm', 'alacritty', 'tabby'].includes(shape)
      ? 'terminals' : 'agent-hosts';
  test(`unknown bundle component and renamed executable ${shape} are refused`, () => {
    for (const target of [{ bundleId: `test.${shape}.helper` },
      { bundleId: 'test.repackaged', executableName: `/Fixtures/${shape.toUpperCase()}.app/Contents/MacOS/${shape}` }]) {
      const result = policy(target);
      assert.equal(result.allow, false);
      assert.equal(result.category, category);
    }
  });
}

test('conservative identity matching survives suffixes, separators and conflicting identities', () => {
  for (const target of [{ bundleId: 'test.passwordmanager' }, { bundleId: 'com.apple.Terminal.evil' },
    { bundleId: 'test.custom', executableName: '1Password Helper (Renderer)' },
    { bundleId: 'test.proton-pass' }, { bundleId: 'com.apple.Terminal', executableName: 'Bitwarden' }]) {
    assert.equal(policy(target).allow, false);
    assert.equal(policy(target, { allowForbiddenTargets: true }).allow,
      target.bundleId === 'com.apple.Terminal.evil');
  }
});

test('missing or malformed secureInput cannot permit keys or semantic writes', () => {
  for (const secureInput of [undefined, null, 1, 0, 'true', 'false', {}, []]) {
    for (const operation of ['typeText', 'pressKey', 'paste', 'modifiers', 'setValue', 'selectText',
      'performSecondaryAction', 'press_key', 'futureInput']) {
      assert.equal(evaluateAppPolicy({ ...facts, bundleId: 'test.editor', operation, secureInput }).allow, false,
        `${operation} with ${String(secureInput)}`);
    }
  }
  assert.equal(evaluateAppPolicy({ bundleId: 'test.editor', executableName: 'Editor', processAncestry: [{ kind: 'non-app' }], windowTitle: 'Draft',
    operation: 'typeText', focusedSecureField: false }).allow, false);
});

test('missing or empty executable identity cannot skip the repackaged-app check', () => {
  for (const executableName of [undefined, null, '', ' ', '/', '/Fixtures/', 7, {}, []]) {
    invalid(policy({ bundleId: 'test.repackaged', executableName }));
  }
  const { executableName, ...withoutExecutable } = facts;
  invalid(evaluateAppPolicy({ ...withoutExecutable, bundleId: 'test.repackaged' }));
  assert.equal(policy({ bundleId: 'test.repackaged', executableName: 'kitty' }).category, 'terminals');
  assert.equal(policy({ bundleId: 'test.repackaged', executableName: 'Editor' }).allow, true);
});

test('missing ancestry and malformed ancestry cannot establish a safe target', () => {
  for (const processAncestry of [undefined, null, 'test.editor', {}, [7], ['test.editor'], [{}],
    [null], [undefined], [{ bundleId: null }], [{ bundleId: 7 }], [{ bundleId: '' }],
    [{ kind: 'non-app', bundleId: 'test.editor' }], [{ kind: 'lookup-error' }]]) {
    invalid(evaluateAppPolicy({ ...facts, bundleId: 'test.editor', processAncestry }));
  }
  invalid(evaluateAppPolicy({ bundleId: 'test.editor', executableName: 'Editor', windowTitle: 'Draft', secureInput: false }));
  const result = policy({ bundleId: 'test.editor', processAncestry: [{ kind: 'non-app' },
    { bundleId: ' TEST.EDITOR ' }] }, { allowForbiddenTargets: true });
  assert.equal(result.allow, false);
  assert.equal(result.category, 'agent-hosts');
});

test('non-string or missing titles refuse even ordinary apps and overridden targets', () => {
  for (const bundleId of ['test.editor', 'com.openai.codex', 'com.apple.Terminal']) {
    for (const windowTitle of [undefined, null, 1, {}, []]) {
      invalid(policy({ bundleId, windowTitle }, { allowForbiddenTargets: true }));
    }
  }
});

test('unknown operations receive secure-input and secure-field enforcement', () => {
  for (const operation of ['press_key', 'futureKey', '', undefined]) {
    assert.equal(policy({ bundleId: 'test.editor', operation, secureInput: true }).allow, false);
    assert.equal(policy({ bundleId: 'test.editor', operation, focusedSecureField: true }).allow, false);
  }
  for (const operation of [null, 1, {}, []]) {
    invalid(policy({ bundleId: 'test.editor', operation }));
  }
});

test('a focused secure field also refuses keys and malformed focus metadata', () => {
  for (const focusedSecureField of [true, undefined, null, 1, 'false']) {
    for (const operation of ['typeText', 'pressKey', 'paste', 'modifiers', 'setValue']) {
      const result = policy({ bundleId: 'test.editor', focusedSecureField, operation });
      assert.equal(result.allow, false);
      assert.equal(result.category, 'secure-field');
    }
  }
});

test('only enumerated reads and pointer operations remain eligible during secure input', () => {
  for (const operation of ['read', 'ping', 'health', 'getState', 'listApps', 'listWindows', 'resolveApp',
    'getApp', 'getAXState', 'verifyWindowIdentity', 'resolveElement', 'getScreenshot', 'getAXStateAndScreenshot',
    'click', 'doubleClick', 'rightClick', 'scroll', 'drag']) {
    assert.equal(policy({ bundleId: 'test.editor', operation, secureInput: true, focusedSecureField: true }).allow, true, operation);
  }
});

test('settings identity refuses any owning app regardless of title and override', () => {
  for (const identity of [{ windowSubrole: 'AXSettingsWindow' }, { windowSubrole: 'AXPreferencesWindow' },
    { windowIdentifier: 'com.example.preferences.window' }, { windowIdentifier: 'settings-window' },
    { windowIdentifier: 'com.example.settingsWindow' }, { windowIdentifier: 'NSPreferencesWindow' },
    { windowIdentifier: 'com.example.settingsWindow.accounts' }]) {
    for (const bundleId of ['test.editor', 'com.openai.codex', 'com.apple.Terminal']) {
      const result = policy({ bundleId, windowTitle: 'Untitled', ...identity }, { allowForbiddenTargets: true });
      assert.equal(result.allow, false);
      assert.equal(result.category, 'settings-windows');
    }
  }
  assert.equal(policy({ bundleId: 'test.editor', windowIdentifier: 'document.notes' }).allow, true);
  for (const identity of [{ windowSubrole: null }, { windowIdentifier: 7 }]) {
    invalid(policy({ bundleId: 'test.editor', ...identity }));
  }
});

for (const windowTitle of ['Ѕettings', 'Ｓettings', 'Settings\u200b', 'Sеttings', 'Sеttіngѕ',
  'Pre\u2060ferences', 'ChatGPT Settings', 'Settings for a story', '設定', '设置', '設置', '偏好设置',
  '설정', 'Configurações', 'Instellingen', 'Настройки', 'Einstellungen', 'Réglages', 'Préférences',
  'Configuración', 'Preferencias', 'Impostazioni', 'ChatGPT: Настройки', 'Ρreferences',
  'ChatGPT\u200bSettings', 'Settings\uFE0F']) test(`settings title ${JSON.stringify(windowTitle)} refuses under override`, () => {
    const result = policy({ bundleId: 'com.openai.codex', windowTitle }, { allowForbiddenTargets: true });
    assert.equal(result.allow, false);
    assert.equal(result.category, 'settings-windows');
  });

test('refusal recovery names the setting only when that exact refusal can be lifted', () => {
  for (const bundleId of ['com.openai.codex', 'com.apple.Terminal']) {
    assert.match(policy({ bundleId }).sentence, /Only the user may lift this restriction with ComputerUseAllowForbiddenTargets/);
    assert.equal(policy({ bundleId }, { allowForbiddenTargets: true }).overridden, true);
  }
  for (const target of [{ bundleId: 'com.anthropic.claudefordesktop' },
    { bundleId: 'com.openai.codex', processAncestry: [{ bundleId: 'COM.OPENAI.CODEX' }] },
    { bundleId: 'test.editor', processAncestry: [{ bundleId: 'test.editor' }] }]) {
    const result = policy(target);
    assert.equal(result.allow, false);
    assert.doesNotMatch(result.sentence, /ComputerUseAllowForbiddenTargets/);
    assert.equal(result.overridden, false);
  }
  const result = policy({ bundleId: 'com.apple.systempreferences' });
  assert.match(result.sentence, /ask the user/i);
  assert.doesNotMatch(result.sentence, /close/i);
  assert.equal(policy({ bundleId: 'test.editor' }).overridden, false);
});

for (const windowTitle of ['Setti\u0301ngs', 'Settíngs', 'Šettings', 'Set tings', 'Set-tings',
  'Set\u0000tings', 'Settıngs', 'sᴇttings', 'Settinɢs', 'sɛttings']) {
  test(`settings confusable ${JSON.stringify(windowTitle)} refuses under override`, () => {
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      const result = policy({ bundleId, windowTitle }, { allowForbiddenTargets: true });
      assert.equal(result.allow, false, bundleId);
      assert.equal(result.category, 'settings-windows', bundleId);
    }
  });
}

for (const [locale, windowTitle] of [
  ['Turkish', 'Ayarlar'], ['Polish', 'Ustawienia'], ['Swedish', 'Inställningar'],
  ['Arabic', 'إعدادات'], ['Czech', 'Nastavení'], ['Finnish', 'Asetukset'],
  ['Norwegian', 'Innstillinger'], ['Danish', 'Indstillinger'], ['Greek', 'Ρυθμίσεις'],
  ['Thai', 'การตั้งค่า'], ['Indonesian', 'Pengaturan'], ['Vietnamese', 'Cài đặt'], ['Hebrew', 'הגדרות'],
]) {
  test(`${locale} settings title refuses under override`, () => {
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      const result = policy({ bundleId, windowTitle }, { allowForbiddenTargets: true });
      assert.equal(result.allow, false, bundleId);
      assert.equal(result.category, 'settings-windows', bundleId);
    }
  });
}

for (const target of [
  { bundleId: 'com.atlassian.confluence', executableName: 'Confluence' },
  { bundleId: 'test.mongodb.atlas', executableName: 'MongoDB Atlas' },
  { bundleId: 'test.atlasti', executableName: 'Atlas.ti' },
  { bundleId: 'test.cursor-tool', executableName: 'Cursor Tools' },
  { bundleId: 'test.claude-monet', executableName: 'Claude Monet' },
  { bundleId: 'test.claude-monet-viewer', executableName: 'Claude Monet Viewer' },
  { bundleId: 'test.codex-book', executableName: 'Codex Book' },
  { bundleId: 'test.hyperdock', executableName: 'HyperDock' },
  { bundleId: 'test.hellokitty', executableName: 'Hello Kitty' },
]) {
  test(`unrelated identity ${target.executableName} remains eligible`, () => {
    assert.equal(policy(target).allow, true);
    assert.equal(policy(target, { allowForbiddenTargets: true }).allow, true);
  });
}

test('source-backed Cursor and Claude identities remain refused with ordinary executable names', () => {
  for (const bundleId of ['com.todesktop.230313mzl4w4u92', 'com.anthropic.claudefordesktop']) {
    const result = policy({ bundleId, executableName: 'Editor' }, { allowForbiddenTargets: true });
    assert.equal(result.allow, false, bundleId);
    assert.equal(result.category, 'agent-hosts', bundleId);
  }
});

test('OpenAI identities remain refused after removing broad Codex and Atlas shapes', () => {
  for (const bundleId of ['com.openai.codex', 'com.openai.atlas']) {
    assert.equal(policy({ bundleId, executableName: 'Editor' }).allow, false, bundleId);
  }
});

test('ordinary titles containing separate letters remain eligible under override', () => {
  for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
    for (const windowTitle of ['Set the timings', 'Setting the sails', 'A set of timings', 'Preset timing chart']) {
      assert.equal(policy({ bundleId, windowTitle }, { allowForbiddenTargets: true }).allow, true, windowTitle);
    }
  }
});

test('compacting a restricted title can conservatively match across word boundaries', () => {
  assert.equal(policy({ bundleId: 'com.apple.Terminal', windowTitle: 'Setting sail' },
    { allowForbiddenTargets: true }).category, 'settings-windows');
});

for (const [bundleId, executableName] of [['co.zeit.hyper', 'Hyper'], ['net.kovidgoyal.kitty', 'kitty']]) {
  test(`exact terminal identity ${bundleId} refuses by id and executable`, () => {
    for (const target of [{ bundleId }, { bundleId: 'test.repackaged', executableName },
      { bundleId: 'test.repackaged', executableName: `/Fixtures/${executableName.toUpperCase()}` }]) {
      assert.equal(policy(target).category, 'terminals');
      assert.equal(policy(target).allow, false);
      assert.equal(policy(target, { allowForbiddenTargets: true }).overridden, true);
    }
    assert.equal(policy({ bundleId: `${bundleId}.other`, executableName: 'Editor' }).allow, true);
  });
}

for (const executableName of ['Atlas', 'Cursor', 'Claude', 'Codex']) {
  test(`exact agent executable ${executableName} refuses without broad substrings`, () => {
    for (const name of [executableName, executableName.toUpperCase(), `/Fixtures/${executableName}`]) {
      const result = policy({ bundleId: 'test.repackaged', executableName: name }, { allowForbiddenTargets: true });
      assert.equal(result.category, 'agent-hosts');
      assert.equal(result.allow, false);
    }
    assert.equal(policy({ bundleId: 'test.repackaged', executableName: `${executableName} Tools` }).allow, true);
  });
}

test('malformed top-level metadata and settings return refusals with causes', () => {
  for (const metadata of [null, false, 1, '', 'test.editor', [], undefined]) invalid(evaluateAppPolicy(metadata));
  for (const settings of [null, false, 1, '', [], 'true']) invalid(policy({ bundleId: 'test.editor' }, settings));
  const result = policy({ bundleId: 'test.editor' }, null);
  assert.equal(result.cause, 'settings');
});

test('only the explicit non-app sentinel establishes a known non-app ancestor', () => {
  assert.equal(policy({ bundleId: 'test.editor', processAncestry: [{ kind: 'non-app' }] }).allow, true);
  const ancestry = Object.defineProperty({}, 'bundleId', { get() { throw Error('lookup failed'); } });
  const result = policy({ bundleId: 'test.editor', processAncestry: [ancestry] });
  invalid(result);
  assert.equal(result.cause, 'metadata-read');
});

for (const target of [
  { bundleId: 'com.todesktop.230313mzl4w4u92.helper', executableName: 'Cursor Helper (Renderer)' },
  { bundleId: 'com.todesktop.230313mzl4w4u92.helper.renderer', executableName: 'Editor' },
  { bundleId: 'com.github.Electron.helper', executableName: 'Cursor Helper (GPU)' },
  { bundleId: 'test.repackaged', executableName: 'Claude Helper (Renderer)' },
  { bundleId: 'test.repackaged', executableName: 'Atlas Helper' },
  { bundleId: 'test.repackaged', executableName: '2.1.5', executablePath: '/Fixtures/claude/versions/2.1.5' },
  ...['codex-aarch64-apple-darwin', 'codex-x86_64-apple-darwin', 'cursor-agent', 'claude-code',
    'codex-tui', 'codex-custom', 'claude-custom', '/Fixtures/CODEX-AARCH64-APPLE-DARWIN',
    '/Fixtures/claude/versions/2.1.5', '/Fixtures/Claude/Versions/2.1.6']
    .map(executableName => ({ bundleId: 'test.repackaged', executableName })),
]) test(`agent process ${JSON.stringify(target)} stays refused under override`, () => {
  for (const allowForbiddenTargets of [false, true]) {
    const result = policy(target, { allowForbiddenTargets });
    assert.equal(result.allow, false);
    assert.equal(result.category, 'agent-hosts');
    assert.equal(result.overridden, false);
  }
});

test('an optional executable path is validated and cannot mask a versioned executable name', () => {
  for (const executablePath of [null, false, 7, {}, [], '', ' ']) {
    const result = policy({ bundleId: 'test.editor', executablePath });
    invalid(result);
    assert.equal(result.cause, 'executablePath');
  }
  assert.equal(policy({ bundleId: 'test.editor', executableName: '2.1.5',
    executablePath: '/Fixtures/Editor/2.1.5' }).allow, true);
  assert.equal(policy({ bundleId: 'test.editor', executableName: '/Fixtures/claude/versions/2.1.5',
    executablePath: '/Fixtures/Editor/2.1.5' }).allow, false);
});

for (const executableName of ['2.1.5', '2.1', '12.34.567.8', ' 2.1.5 ', 'v2.1.5', 'V2.1.5',
  'claude/versions/2.1.5', 'versions/2.1.5', './2.1.5', 'claude\\versions\\2.1.5']) {
  test(`bare version ${JSON.stringify(executableName)} needs a trusted executable path`, () => {
    for (const allowForbiddenTargets of [false, true]) {
      const result = policy({ bundleId: 'test.editor', executableName }, { allowForbiddenTargets });
      invalid(result);
      assert.equal(result.cause, 'executablePath');
      assert.equal(policy({ bundleId: 'test.editor', executableName,
        executablePath: '/Fixtures/Editor/2.1.5' }, { allowForbiddenTargets }).allow, true);
      assert.equal(policy({ bundleId: 'test.editor', executableName,
        executablePath: '/Fixtures/claude/versions/2.1.5' }, { allowForbiddenTargets }).category, 'agent-hosts');
    }
  });
}

for (const [bundleId, executableName] of [
  ['co.zeit.hyper.helper', 'Hyper Helper (Renderer)'],
  ['net.kovidgoyal.kitty.helper', 'kitty Helper'],
]) test(`terminal helper ${bundleId} keeps the terminal refusal and override rules`, () => {
  for (const target of [{ bundleId, executableName: 'Editor' }, { bundleId: `${bundleId}.renderer` },
    { bundleId: 'test.repackaged', executableName }]) {
    assert.equal(policy(target).allow, false);
    assert.equal(policy(target).category, 'terminals');
    assert.equal(policy(target, { allowForbiddenTargets: true }).overridden, true);
    assert.equal(policy({ ...target, windowTitle: 'Settings' }, { allowForbiddenTargets: true }).allow, false);
  }
});

test('agent and helper prefixes require whole tokens and exact path components', () => {
  for (const executableName of ['CodexBook', 'Codex Helperish', 'Cursor Helperish', 'Claude Helperish',
    'Atlas Helperish', 'HyperDock', 'Hello Kitty', '/Fixtures/notclaude/versions/2.1.5',
    '/Fixtures/claude/other/2.1.5', '/Fixtures/claude/versions-old/2.1.5']) {
    assert.equal(policy({ bundleId: 'test.editor', executableName }).allow, true, executableName);
  }
  for (const bundleId of ['co.zeit.hyper.beta', 'net.kovidgoyal.kitty.beta',
    'co.zeit.hyper.helperish', 'net.kovidgoyal.kitty.helperish', 'com.todesktop.230313mzl4w4u92ish']) {
    assert.equal(policy({ bundleId }).allow, true, bundleId);
  }
});

for (const windowTitle of ['Setŧings', 'Settinǥs', 'Settłngs', 'Sեttings', 'Sɘttings', 'Seʈtings',
  'SeȾtings', 'Sɇttings', 'Settƚngs', 'SettƗngs', 'Settɨngs', 'Settƛngs', 'SettınǤs',
  'Preferenceտ', 'PrefeɌences', 'PreferenȻes', 'Prefereոces',
  'Inđstillinger', 'Indstiƚƚinger', 'Ρυθμίσεις', 'Ɇinstellungen', 'Ⱥyarlar', 'Ʉstawienia',
  'Réǥłages', 'Sէttings']) {
  test(`additional stroked or Armenian title ${JSON.stringify(windowTitle)} refuses under override`, () => {
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      const result = policy({ bundleId, windowTitle }, { allowForbiddenTargets: true });
      assert.equal(result.allow, false, bundleId);
      assert.equal(result.category, 'settings-windows', bundleId);
    }
  });
}

for (const character of ['ł', 'ƚ', 'ƛ', 'ɫ', 'ɬ', 'ɭ', 'Ł', 'Ƚ']) {
  test(`stroked l ${character} matches i or l only in settings titles`, () => {
    for (const windowTitle of [`Sett${character}ngs`, `Rég${character}ages`, `Indsti${character}${character}inger`]) {
      const result = policy({ bundleId: 'com.apple.Terminal', windowTitle }, { allowForbiddenTargets: true });
      assert.equal(result.allow, false, windowTitle);
      assert.equal(result.category, 'settings-windows', windowTitle);
    }
  });
}

for (const windowTitle of ['RégIages', 'InsteIIingen', 'InnstiIIinger', 'IndstiIIinger',
  'InstäIIningar', 'ayarIar', 'Settʟngs', 'Settⅼngs', 'SettⅬngs',
  'Instełłłngen', 'Instäłłnłngar', 'InsteIlingen', 'InstelIingen',
  'InnstiIlinger', 'InnstilIinger', 'IndstiIlinger', 'IndstilIinger', 'InstäIlningar', 'InstälIningar']) {
  test(`ambiguous l title ${JSON.stringify(windowTitle)} refuses under override`, () => {
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      const result = policy({ bundleId, windowTitle }, { allowForbiddenTargets: true });
      assert.equal(result.allow, false, bundleId);
      assert.equal(result.category, 'settings-windows', bundleId);
    }
  });
}

for (const windowTitle of ['Medical data', 'Local data', '~/local/data', 'Physical data.csv',
  'Historical Data', 'Technical data', 'Medical Data - Notes',
  'Lịch làm việc', 'Tài liệu', 'Bài tập', 'Cài phần mềm', 'Cài driver', 'Cal dat']) {
  test(`ordinary Terminal title ${JSON.stringify(windowTitle)} stays eligible under override`, () => {
    const result = policy({ bundleId: 'com.apple.Terminal', windowTitle }, { allowForbiddenTargets: true });
    assert.equal(result.allow, true);
    assert.equal(result.overridden, true);
  });
}

for (const windowTitle of ['Settlngs', 'elnstellungen', 'innstilllnger',
  'lnnstllllnger', 'lndstllllnger', 'lnsteIIlngen', 'régiages']) {
  test(`long settings word variant ${JSON.stringify(windowTitle)} refuses under override`, () => {
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      assert.equal(policy({ bundleId, windowTitle }, { allowForbiddenTargets: true }).category, 'settings-windows');
    }
  });
}

test('short Vietnamese word keeps its plain-l gap under override', () => {
  for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
    for (const windowTitle of ['càl đặt', 'cal dat', 'Cal dat']) {
      assert.equal(policy({ bundleId, windowTitle }, { allowForbiddenTargets: true }).allow, true, windowTitle);
    }
  }
});

test('short Vietnamese word with stroked l still refuses under override', () => {
  for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
    const result = policy({ bundleId, windowTitle: 'càł đặt' }, { allowForbiddenTargets: true });
    assert.equal(result.allow, false, bundleId);
    assert.equal(result.category, 'settings-windows', bundleId);
  }
});

for (const glyph of ['ℓ', 'ĺ', 'ľ', 'ḷ', 'ｌ', 'ŀ', 'ļ', 'ḽ', 'ḻ', 'l\u0336', 'l\u0338']) {
  test(`short Vietnamese word with ${glyph} keeps the accepted plain-l gap under override`, () => {
    const windowTitle = `cà${glyph} đặt`;
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      const result = policy({ bundleId, windowTitle }, { allowForbiddenTargets: true });
      assert.equal(result.allow, true, bundleId);
      assert.equal(result.overridden, true, bundleId);
      for (const identity of [{ windowSubrole: 'AXSettingsWindow' }, { windowSubrole: 'AXPreferencesWindow' },
        { windowIdentifier: 'settings' }, { windowIdentifier: 'preferences' }, { windowIdentifier: 'prefs' }]) {
        const guarded = policy({ bundleId, windowTitle, ...identity }, { allowForbiddenTargets: true });
        assert.equal(guarded.allow, false, JSON.stringify(identity));
        assert.equal(guarded.category, 'settings-windows', JSON.stringify(identity));
      }
    }
  });
}

test('lowercase Vietnamese settings still refuses on an overridden Terminal', () => {
  const result = policy({ bundleId: 'com.apple.Terminal', windowTitle: 'cài đặt' }, { allowForbiddenTargets: true });
  assert.equal(result.allow, false);
  assert.equal(result.category, 'settings-windows');
});

for (const windowTitle of ['Ｓｅｔｔｉｎｇｓ', '𝐒𝐞𝐭𝐭𝐢𝐧𝐠𝐬', 'Ⓢⓔⓣⓣⓘⓝⓖⓢ',
  'Set\u200Dtings', 'Set\u200Ftings', 'Set\u202Etings', 'Set\u00ADtings', 'Set\u3164tings',
  'Set\u2800tings', 'Set\uFE0Ftings', 'Set\u{E0001}tings', 'Set\u0338tings', 'Set\u00A0tings',
  'Sеttіngѕ', 'Sεttings']) {
  test(`reviewed settings normalization ${JSON.stringify(windowTitle)} stays refused`, () => {
    for (const bundleId of ['com.apple.Terminal', 'com.openai.chat']) {
      assert.equal(policy({ bundleId, windowTitle }, { allowForbiddenTargets: true }).category, 'settings-windows');
    }
  });
}
