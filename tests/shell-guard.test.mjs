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
    'firefox -new-window https://example.invalid', 'helium https://example.invalid', 'safari https://example.invalid', 'Safari',
    '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" https://example.invalid',
  ]) assert.equal(denied(command), true, command);
});

test('headless exemption belongs to the browser command and an actual flag', () => {
  for (const command of [
    'chromium --headless', 'google-chrome --headless=new --dump-dom https://example.invalid',
    'firefox --headless --screenshot /tmp/fixture.png', 'chrome-headless-shell --headless',
    'chromium --headless=new', 'msedge --headless', 'opera --headless',
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
    'arch -arm64 open ./page.html', 'arch -arm64e open ./page.html', 'arch -arch arm64 open ./page.html',
    'arch -d BROWSER -e LANG=C open ./page.html',
    'timeout 10 open ./page.html', 'timeout -s TERM -k 2 10 open ./page.html',
    'timeout --signal TERM --kill-after 2 10 open ./page.html',
    'caffeinate -dimsu -t 10 -w 123 open ./page.html', 'setsid -f open ./page.html',
    'caffeinate -dt 10 open ./page.html',
    'stdbuf -o L -e0 open ./page.html', 'stdbuf --output L --error=0 open ./page.html',
    'script -q /dev/null open ./page.html', 'script -q -c "open ./page.html" /dev/null',
    'script --command="open ./page.html" /dev/null',
    'script -qc "open ./page.html" /dev/null', 'script -c"open ./page.html" /dev/null',
    'script -F -q /dev/null open ./page.html',
    'launchctl asuser 501 open ./page.html', 'exec -a harmless open ./page.html',
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
    'echo safari', 'printf "%s" Safari', 'rg Safari tests', 'cat safari',
    'arch -arm64 chromium --headless', 'timeout 10 firefox --headless',
    'caffeinate -t 5 msedge --headless', 'setsid opera --headless',
    'stdbuf -oL chromium --headless', 'script -q /dev/null firefox --headless',
    'launchctl asuser 501 msedge --headless', 'exec -a harmless opera --headless',
    'node --test tests/shell-guard.test.mjs', 'npm run lint:prose',
    'python3 -c \'open("fixture.txt", "w").write("hello")\'',
    'python3 -c \'print("one; two && three")\'', 'echo hi > /tmp/open',
    '# open ./preview.html\necho hi', 'printf ok # open ./preview.html',
    'env -u BROWSER chromium --headless', 'sh -c \'printf "%s" "open ./preview.html"\''])
    assert.equal(denied(command), false, command);
  for (const event of [{ tool: 'Read', command: 'open ./preview.html' }, { tool: 'Bash' },
    { tool: 'Bash', command: null }, {}]) assert.equal(guard.shellLaunchDenied(event), false);
});

test('heredoc data is skipped through its exact terminator and later commands still run', () => {
  for (const opener of ['<<EOF', "<<'EOF'", '<<"EOF"', '<<-EOF', '<<~EOF']) {
    const command = `git commit -F - ${opener}\nopen the door\nSafari\nEOF\nprintf ok`;
    assert.equal(denied(command), false, command);
    assert.equal(denied(command + '\nopen ./page.html'), true, command);
  }
  for (const command of [
    "cat <<'ONE' <<\"TWO\"\nopen the door\nONE\nSafari\nTWO",
    'cat <<-EOF\n\topen the door\n\tEOF\nprintf ok',
    'cat <<~EOF\n  open the door\n  EOF\nprintf ok',
    'cat <<EOF\nopen the door\nEOFsuffix\nSafari\nEOF',
    'printf "%s" "<<EOF"\nprintf ok',
  ]) assert.equal(denied(command), false, command);
  assert.equal(denied('cat <<EOF; open ./page.html\nplain data\nEOF'), true);
});

test('shell heredocs are scanned as commands, while ordinary shell input stays allowed', () => {
  for (const launcher of ['sh', 'bash -s', 'zsh', 'env bash', 'timeout 5 sh', 'exec -a harmless zsh',
    'env -S sh', 'env --split-string=sh', 'bash -c sh', 'eval sh', 'script -q -c sh /dev/null']) {
    const command = `${launcher} <<'EOF'\nopen ./page.html\nEOF`;
    assert.equal(denied(command), true, command);
    assert.equal(denied(`${launcher} <<EOF\nprintf '%s' 'open the door'\nEOF`), false, launcher);
  }
  assert.equal(denied("sh <<'OUTER'\ncat <<'INNER'\nopen the door\nINNER\nOUTER"), false);
});

test('unquoted heredocs check expanding substitutions without interpreting ordinary data', () => {
  for (const body of ['$(open ./page.html)', '`open ./page.html`', "'$(open ./page.html)'", '"$(open ./page.html)"']) {
    assert.equal(denied(`cat <<EOF\n${body}\nEOF`), true, body);
    assert.equal(denied(`cat <<'EOF'\n${body}\nEOF`), false, body);
  }
  assert.equal(denied('cat <<EOF # ordinary data follows\nopen the door\nEOF\nprintf ok'), false);
  assert.equal(denied('cat <<EOF # ordinary data follows\nopen the door\nEOF\nopen ./page.html'), true);
});

function installedGuard({ disabled = false, refuseWrite = false } = {}) {
  const source = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  let checked = 0, ended = 0;
  const exports = {};
  runInNewContext(js, { exports, require(name) {
    if (name === 'claude-code') return { atom: (_key, value) => ({ value }),
      read: async (_$, atom) => atom.value, update: async (_$, atom, fn) => { atom.value = fn(atom.value); } };
    if (name === './shell-guard.mjs') return guard;
    if (name === './preapproved-write-guard.mjs') return {
      loggingSwitchWriteDenied: () => false, preapprovedWriteDenied: async () => { checked++; return refuseWrite; },
    };
    return {};
  } });
  const hooks = new Map();
  exports.register((name, filter, handler) => {
    hooks.set(handler ? `${name}:${filter.tool ?? filter.command}` : name, handler ?? filter);
    return { catch() {} };
  });
  const pre = hooks.get('classic.PreToolUse'); assert.equal(typeof pre, 'function');
  let passed = 0;
  const $ = { env: { get: async key => key === 'SLEIGHT_SHELL_GUARD' ? (disabled ? '0' : undefined) : '/synthetic-home' },
    fs: { stat: async () => { throw Error('unexpected stat'); } },
    plugin: { root: '/synthetic-plugin' }, process: { run: async () => ({ exitCode: 0, stdout: '{"enabled":true}' }) },
    mcp: { connect: async () => ({ isConnected: true, server: 'computer' }), call: async (_server, _tool, args) => {
      if (args.sleight_turbo?.event === 'bootstrap') return { content: [{ type: 'text', text: JSON.stringify({ sleightTurbo: {
        version: 1, session: 'fixture', nonce: 'a'.repeat(64) } }) }] };
      if (args.hook_event_name) ended++;
      return { content: [] };
    } }, ui: { status() {}, log() {}, toast() {}, panes: async () => [] } };
  const next = event => { passed++; return event; };
  return { $, hooks, pre: event => pre($, event, next), checked: () => checked, passed: () => passed, ended: () => ended,
    use: (tool = 'js', next = event => event) => hooks.get(`tool.call:mcp__plugin_sleight_computer__${tool}`)($, { tool_use_id: 'call' }, next),
    complete: event => hooks.get('turn.complete')($, event ?? {}, event => event),
    stop: () => hooks.get('command.run:sleight')($, { args: 'stop' }) };
}

test('installed PreToolUse returns the refusal before filesystem access and preserves the write guard', async () => {
  const h = installedGuard({ refuseWrite: true });
  await h.use();
  const pre = h.pre;
  assert.equal((await pre({ tool: 'Bash', command: 'open ./page.html' })).deny, guard.shellGuardReason);
  assert.equal(h.checked(), 0); assert.equal(h.passed(), 0);
  assert.match((await pre({ tool: 'Write', file_path: 'policy' })).deny, /Only the user edits/);
  assert.equal(h.checked(), 1);
  await pre({ tool: 'Read' }); assert.equal(h.passed(), 1);
});

test('shell guard covers only sleight turns, resets on completion or stop, and supports opt-out', async () => {
  const event = { tool: 'Bash', command: 'open report.pdf' };
  for (const tool of ['js', 'replay', 'browser_open', 'browser_read', 'browser_act', 'browser_fill']) {
    const h = installedGuard();
    assert.equal((await h.pre(event)).deny, undefined, tool);
    await h.use(tool, async e => {
      assert.equal((await h.pre(event)).deny, guard.shellGuardReason, 'guard active when the first call runs');
      return e;
    });
    await h.complete({ agentId: 'child' });
    assert.equal((await h.pre(event)).deny, guard.shellGuardReason);
    await h.complete();
    assert.equal((await h.pre(event)).deny, undefined, 'ordinary next turn');
    await h.use(tool); await h.complete({ isAborted: true });
    assert.equal((await h.pre(event)).deny, undefined, 'aborted turn');
    await h.use(tool); await h.stop();
    assert.equal((await h.pre(event)).deny, undefined, 'explicit stop');
    assert.match((await h.use(tool)).deny, /user stopped/);
    assert.equal((await h.pre(event)).deny, undefined, 'refused tool cannot reactivate');
  }
  const off = installedGuard({ disabled: true, refuseWrite: true });
  await off.use();
  assert.match((await off.pre(event)).deny, /Only the user edits/, 'opt-out retains the approval write guard');
  const allow = installedGuard({ disabled: true }); await allow.use();
  assert.equal((await allow.pre(event)).deny, undefined);
  assert.match(guard.shellGuardReason, /sleight.*guard.*this turn/i);
  assert.match(guard.shellGuardReason, /SLEIGHT_SHELL_GUARD=0/);
});

test('turbo prompt setup alone leaves ordinary shell work untouched and still ends its binding', async () => {
  const h = installedGuard(), event = { tool: 'Bash', command: 'open report.pdf' };
  await h.hooks.get('prompt.submit')(h.$, { origin: { kind: 'composer' }, text: 'ordinary work' }, event => event);
  assert.equal((await h.pre(event)).deny, undefined);
  await h.complete();
  assert.equal(h.ended(), 1);
  assert.equal((await h.pre(event)).deny, undefined);
});
