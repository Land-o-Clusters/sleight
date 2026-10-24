import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as guard from '../plugins/sleight/hooks/shell-guard.mjs';

const denied = command => guard.shellLaunchDenied({ tool: 'Bash', command });

test('shell guard denies app, URL and window launchers without executing them', () => {
  for (const command of [
    'open https://example.invalid', '/usr/bin/open -a AnyApp', 'open -g -j ./preview.html',
    'open -R ./document.pdf', 'o"pe"n https://example.invalid', 'o\\pen ./document.pdf',
    'osascript -e \'tell application "AnyApp" to activate\'', '/usr/bin/osascript script.scpt',
    'xdg-open https://example.invalid', 'gio open ./preview.html', 'sensible-browser https://example.invalid',
    '"/Applications/Any App.app/Contents/MacOS/Any App"',
    '"/Applications/Any App.app/Contents/MacOS/Any App" --headless',
    'chrome https://example.invalid', 'chromium --new-window', 'google-chrome-stable --app=https://example.invalid',
    'firefox -new-window https://example.invalid', 'helium https://example.invalid', 'safari https://example.invalid',
    '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" https://example.invalid',
  ]) assert.equal(denied(command), true, command);
});

test('headless exemption belongs to the browser command and an actual flag', () => {
  for (const command of [
    'chromium --headless', 'google-chrome --headless=new --dump-dom https://example.invalid',
    'firefox --headless --screenshot /tmp/fixture.png', 'chrome-headless-shell --headless',
    '"/Applications/Helium.app/Contents/MacOS/Helium" --headless=old',
    'chrome --version', 'chromium --help',
  ]) assert.equal(denied(command), false, command);
  for (const command of ['chrome --headless=false', 'chrome --headless --headless=false', 'chrome -- --headless', 'chrome "argument --headless"',
    'open -a AnyApp --args --headless', 'chrome https://example.invalid; echo --headless',
    'chrome --headless && open ./preview.html', 'safari --headless']) assert.equal(denied(command), true, command);
});

test('every shell segment is checked across lists, pipes, background jobs and newlines', () => {
  for (const separator of [';', '&&', '||', '|', '&', '|&', '\n']) {
    assert.equal(denied(`printf ok ${separator} open ./page.html`), true, separator);
    assert.equal(denied(`open ./page.html ${separator} printf ok`), true, separator);
    assert.equal(denied(`printf ok ${separator} chromium --headless`), false, separator);
  }
  for (const command of ['(open ./page.html)', '{ open ./page.html; }', 'if true; then open ./page.html; fi',
    'while false; do open ./page.html; done', 'open ./page.html 2>/tmp/log', '2>/tmp/log open ./page.html',
    'op\\\nen ./page.html']) assert.equal(denied(command), true, command);
});

test('assignments, ordinary wrappers and literal shell scripts cannot hide a launch', () => {
  for (const command of ['BROWSER=anything open ./page.html', 'env LANG=C open ./page.html',
    'env -u BROWSER -- open ./page.html', 'env -S "open ./page.html"', 'env --split-string="open ./page.html"',
    'command -- /usr/bin/open ./page.html', 'builtin open ./page.html', 'exec open ./page.html',
    'nohup open ./page.html &', 'sudo -u fixture open ./page.html', 'nice -n 10 open ./page.html',
    'time -p open ./page.html', 'printf x | xargs -I {} open {}',
    'sh -c "open ./page.html"', 'bash -lc \'echo ok && open ./page.html\'',
    'zsh -c \'chromium --headless; open ./page.html\'', 'eval "open ./page.html"',
    'find . -name page.html -exec open {} \\;', 'find . -execdir osascript {} +'])
    assert.equal(denied(command), true, command);
});

test('command substitutions execute inside double quotes but single-quoted examples are data', () => {
  for (const command of ['echo $(open ./page.html)', 'echo "$(open ./page.html)"',
    'echo `open ./page.html`', 'echo "`open ./page.html`"', 'echo $(printf "%s" "$(open ./page.html)")'])
    assert.equal(denied(command), true, command);
  for (const command of ["echo '$(open ./page.html)'", "echo '`open ./page.html`'", 'echo \\`open ./page.html\\`'])
    assert.equal(denied(command), false, command);
});

test('Python webbrowser module and source forms are denied', () => {
  for (const command of ['python -m webbrowser https://example.invalid', '/usr/bin/python3 -mwebbrowser https://example.invalid',
    'python3 -c \'import webbrowser; webbrowser.open("https://example.invalid")\'',
    'python3 -c\'from webbrowser import open as launch; launch("https://example.invalid")\'',
    'python3 -Imwebbrowser https://example.invalid', 'python3 -Ic \'import webbrowser; webbrowser.open("https://example.invalid")\'',
    'python3 - <<\'PY\'\nimport webbrowser\nwebbrowser.open("https://example.invalid")\nPY',
    'env python3 - <<\'PY\'\nimport webbrowser\nwebbrowser.open("https://example.invalid")\nPY',
    'printf \'import webbrowser; webbrowser.open("https://example.invalid")\' | python3'])
    assert.equal(denied(command), true, command);
});

test('ordinary shell work, quoted examples and Python file I/O remain allowed', () => {
  for (const command of ['printf "%s" "open https://example.invalid"', 'echo "one; open a && open b | open c & open d"',
    'echo open ./preview.html', 'rg "webbrowser.open" tests', 'cat open',
    'node --test tests/shell-guard.test.mjs', 'npm run lint:prose',
    'python3 -c \'open("fixture.txt", "w").write("hello")\'',
    'python3 -c \'print("one; two && three")\'', 'echo hi > /tmp/open',
    '# open ./preview.html\necho hi', 'printf ok # open ./preview.html',
    'env -u BROWSER chromium --headless', 'sh -c \'printf "%s" "open ./preview.html"\''])
    assert.equal(denied(command), false, command);
  for (const event of [{ tool: 'Read', command: 'open ./preview.html' }, { tool: 'Bash' },
    { tool: 'Bash', command: null }, {}]) assert.equal(guard.shellLaunchDenied(event), false);
});

test('installed PreToolUse returns the refusal before filesystem access and preserves the write guard', async () => {
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  let checked = 0;
  const exports = {};
  runInNewContext(js, { exports, require(name) {
    if (name === 'claude-code') return { atom: () => ({}) };
    if (name === './shell-guard.mjs') return guard;
    if (name === './preapproved-write-guard.mjs') return {
      loggingSwitchWriteDenied: () => false, preapprovedWriteDenied: async () => { checked++; return true; },
    };
    return {};
  } });
  const hooks = new Map();
  exports.register((name, handler) => { hooks.set(name, handler); return { catch() {} }; });
  const pre = hooks.get('classic.PreToolUse'); assert.equal(typeof pre, 'function');
  let passed = 0;
  const $ = { env: { get: async () => '/synthetic-home' }, fs: { stat: async () => { throw Error('unexpected stat'); } } };
  const next = event => { passed++; return event; };
  assert.equal((await pre($, { tool: 'Bash', command: 'open ./page.html' }, next)).deny, guard.shellGuardReason);
  assert.equal(checked, 0); assert.equal(passed, 0);
  assert.match((await pre($, { tool: 'Write', file_path: 'policy' }, next)).deny, /Only the user edits/);
  assert.equal(checked, 1);
  await pre($, { tool: 'Read' }, next); assert.equal(passed, 1);
});
