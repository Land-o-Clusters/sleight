import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
const ts = parserSkip ? undefined : (await import('typescript')).default;
import * as guard from '../plugins/sleight/hooks/shell-guard.mjs';

const denied = command => guard.shellLaunchDenied({ tool: 'Bash', command });

// FD4D fixtures remain strings. No shell, interpreter or launcher runs here.
for (const consumer of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
  'busybox sh', 'env sh', '/bin/sh -', 'env -S "sh"']) {
  for (const producer of ['echo "open ./page.html"', 'echo open ./page.html',
    'printf "%s\\n" "open ./page.html"', 'echo "open ./page.html" | cat',
    'printf "%s" "open ./page.html" | grep open | cat',
    "cat <<'EOF'\nopen ./page.html\nEOF"]) {
    // Put the pipe on the heredoc declaration, before its body.
    const command = producer.includes('\n')
      ? producer.replace('\n', ` | ${consumer}\n`) : `${producer} | ${consumer}`;
    test(`fd4d literal pipeline refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
  }
}

const interpreterPayloads = [
  ['python3 -c', 'import os; os.system("open ./page.html")'],
  ['python -Ic', 'import subprocess; subprocess.run(["open", "./page.html"])'],
  ['python3 -c', 'from os import popen; popen("open ./page.html")'],
  ['node -e', 'require("child_process").execSync("open ./page.html")'],
  ['node --eval', 'require("child_process").spawn("open", ["./page.html"])'],
  ['node -e', 'import("child_process").then(cp => cp.exec("xdg-open ./page.html"))'],
  ['perl -e', 'system("open ./page.html")'],
  ['perl -E', 'exec "osascript", "script.scpt"'],
  ['ruby -e', 'system("open ./page.html")'],
  ['ruby -e', 'exec("xdg-open", "./page.html")'],
  ['osascript -e', 'tell application "AnyApp" to activate'],
  ['swift -e', 'import AppKit; NSWorkspace.shared.open(URL(fileURLWithPath: "./page.html"))'],
  ['swift -e', 'LSOpenCFURLRef(url, nil)'],
  ['python3 -c', 'print("webbrowser")'],
];
for (const [prefix, payload] of interpreterPayloads) {
  const command = `${prefix} '${payload}'`;
  test(`fd4d interpreter payload refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
}
for (const [interpreter, payload] of [
  ['python', 'import os; os.system("open ./page.html")'],
  ['python3', 'import subprocess; subprocess.run(["open", "./page.html"])'],
  ['node', 'require("child_process").execSync("open ./page.html")'],
  ['perl', 'system("open ./page.html")'], ['ruby', 'system("open ./page.html")'],
  ['osascript', 'tell application "AnyApp" to activate'],
  ['swift', 'import AppKit; NSWorkspace.shared.open(URL(fileURLWithPath: "./page.html"))'],
]) {
  for (const input of [
    `${interpreter} - <<'EOF'\n${payload}\nEOF`,
    `${interpreter} <<'EOF'\n${payload}\nEOF`,
    `printf '%s' '${payload}' | ${interpreter}`,
  ]) test(`fd4d interpreter stdin refuses: ${JSON.stringify(input)}`, () => assert.equal(denied(input), true));
}

for (const command of [
  'source <(echo open ./page.html)', '. <(printf "%s" "open ./page.html")',
  "source /dev/stdin <<'EOF'\nopen ./page.html\nEOF", ". /dev/stdin <<'EOF'\nopen ./page.html\nEOF",
  'source /dev/stdin <<< "open ./page.html"',
  'launchctl submit -l fixture -- open ./page.html', 'launchctl load fixture.plist',
  'launchctl bootstrap gui/501 fixture.plist', 'launchctl kickstart gui/501/fixture',
  '$(which open) ./page.html', '$(command -v open) ./page.html',
  '`which open` ./page.html', '`command -v open` ./page.html',
  'env $(which open) ./page.html', '"$(command -v /usr/bin/open)" ./page.html',
]) test(`fd4d consumer or wrapper refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));

for (const command of [
  'echo "open ./page.html" | sh | cat', 'printf harmless | echo "open ./page.html" | sh',
  'echo "open ./page.html" |& env sh', 'echo "open ./page.html" | env sh -c "cat | sh"',
  'echo "open ./page.html" |\nsh', 'echo "open ./page.html" | # next stage\ncat |\nenv sh',
  'node -e\'require("child_process").execSync("open ./page.html")\'',
  'node --eval=\'require("child_process").spawn("open")\'',
  'perl -we\'system("open ./page.html")\'', 'ruby -e\'system("open ./page.html")\'',
  'python3 -c \'os.system("/usr/bin/open ./page.html")\'',
  'node -e "require(\'child_process\').execSync(\'open ./page.html\')"',
  'ruby -e \'puts "hello"\' -e \'system("open ./page.html")\'',
  'ruby -e \'NSWorkspace.sharedWorkspace\'',
]) test(`fd4d literal spelling refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));

// Catch file API names or data strings being mistaken for process launchers.
const quotePayload = payload => "'" + payload.replaceAll("'", "'\\''") + "'";
for (const [interpreter, flag, payload] of [
  ['python3', '-c', "open('f')"],
  ['python3', '-c', 'open("fixture.txt", "w").write("hello")'],
  ['python3', '-c', "with open('f') as f:\n    print(f.read())"],
  ['python3', '-c', "import json; json.load(open('f'))"],
  ['python3', '-c', "import io; io.open('f')"],
  ['python3', '-c', "import codecs; codecs.open('f')"],
  ['python3', '-c', "import os; os.open('f', os.O_RDONLY)"],
  ['python3', '-c', "import gzip; gzip.open('f')"],
  ['python3', '-c', "import tarfile; tarfile.open('f')"],
  ['python3', '-c', "from pathlib import Path; Path('f').open()"],
  ['python3', '-c', 'Path.open()'],
  ['python3', '-c', "print('open the file')"],
  ['python3', '-c', 'print("open")'],
  ['python3', '-c', 'print("xdg-open")'],
  ['python3', '-c', 'print("x-www-browser")'],
  ['python3', '-c', 'print("/usr/bin/open")'],
  ['python3', '-c', 'import os; os.system("echo open")'],
  ['python3', '-c', 'import subprocess; subprocess.run(["opener", "f"])'],
  ['ruby', '-e', 'File.open("f", "w") { |f| f.write("hello") }'],
  ['ruby', '-e', 'puts "open"'],
  ['ruby', '-e', 'system("echo open")'],
  ['perl', '-e', 'open(my $fh, "<", "f") or die $!;'],
  ['perl', '-e', 'print "open the file";'],
  ['node', '-e', 'const fs = require("fs"); fs.open("f", "r", () => {})'],
  ['node', '-e', 'const fs = require("fs"); fs.promises.open("f", "r")'],
  ['node', '-e', "ws.on('open', () => {})"],
  ['node', '-e', 'open(url)'],
  ['node', '-e', 'console.log("open the file")'],
  ['node', '-e', 'require("child_process").execSync("echo /usr/bin/open")'],
]) {
  for (const command of [
    `${interpreter} ${flag} ${quotePayload(payload)}`,
    `${interpreter} <<'EOF'\n${payload}\nEOF`,
    `${interpreter} <<EOF\n${payload}\nEOF`,
    `printf '%s' ${quotePayload(payload)} | ${interpreter}`,
    `cat <<'EOF' | ${interpreter}\n${payload}\nEOF`,
  ]) test(`fd4e file IO and data pass: ${JSON.stringify(command)}`, () => assert.equal(denied(command), false));
}

test('fd4e interpreter file IO survives wrappers and stream redirects', () => {
  for (const consumer of ['python3', 'env python3', 'env -S "python3"',
    'env --split-string=python3', 'timeout 5 python3', '/usr/bin/python3 -']) {
    for (const command of [
      `${consumer} <<'EOF'\nopen("f")\nEOF`,
      `${consumer} <<< 'open("f")'`,
      `${consumer} < <(printf '%s' 'open("f")')`,
    ]) assert.equal(denied(command), false, command);
  }
});

test('fd4e interpreter heredoc exemptions preserve expansions and later shell launches', () => {
  const body = 'print("$(open x)")';
  assert.equal(denied(`python3 <<EOF\n${body}\nEOF`), true, 'unquoted heredoc expands shell input');
  assert.equal(denied(`python3 <<'EOF'\n${body}\nEOF`), false, 'quoted heredoc keeps dollar substitution literal');
  assert.equal(denied('python3 <<EOF\nprint("`open x`")\nEOF'), true, 'unquoted backticks expand too');
  for (const command of [
    'python3 <<\'EOF\'\nopen("f")\nEOF\nopen x',
    'python3 <<\'EOF\'\nopen("f")\nEOF\nsh <<\'SH\'\nopen x\nSH',
    'python3 <<< \'print("hello")\'; open x',
    'python3 < <(open x)',
  ]) assert.equal(denied(command), true, command);
});

for (const payload of [
  'os.system("open ./page.html")', 'os.system("/usr/bin/open ./page.html")',
  'subprocess.run(["open", "./page.html"])', 'subprocess.call("xdg-open ./page.html", shell=True)',
  'subprocess.Popen(["/usr/bin/x-www-browser", "https://example.invalid"])',
  'popen("osascript script.scpt")', 'exec("/usr/bin/xdg-open", "./page.html")',
  'spawn("x-www-browser", ["https://example.invalid"])', 'execSync("/usr/bin/osascript -e script")',
  'system "open ./page.html"', 'exec "osascript", "script.scpt"',
  '`open ./page.html`', '`/usr/bin/xdg-open ./page.html`', '`x-www-browser https://example.invalid`',
  'NSAppleScript.alloc.initWithSource(script)', 'print("osascript -e script")',
]) {
  for (const command of [
    `ruby -e ${quotePayload(payload)}`,
    `ruby <<'EOF'\n${payload}\nEOF`,
    `printf '%s' ${quotePayload(payload)} | ruby`,
  ]) test(`fd4e launcher payload refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
}

for (const sink of ['cat', 'cat 2>log', 'tee', 'pbcopy', 'grep open', 'wc -l', 'cat | grep open | wc -l']) {
  const command = `${sink} <<'EOF'\nopen the door\nSafari\nIt's (an example).\nEOF`;
  test(`fd4d heredoc output stays data: ${sink}`, () => {
    assert.equal(denied(command), false);
    assert.equal(denied(command + '\nopen ./page.html'), true, 'later commands still checked');
    assert.equal(denied(command.replace("<<'EOF'", "<<'EOF' | sh")), true, 'downstream shell consumes the body');
  });
}

test('fd4d data and headless controls do not become executable payloads', () => {
  for (const command of [
    'echo "open ./page.html" | cat', 'printf "%s" "open ./page.html" | grep open | wc',
    'printf "%s" "chromium --headless" | /bin/sh -', 'echo "printf hello" | env sh',
    'echo "open x"; printf hello | sh', // A separate pipeline has no launcher input.
    'which open', 'command -v open', 'echo "$(which open)"', 'printf "%s" "`command -v open`"',
    'python3 -c \'print("hello")\'', 'node -e \'console.log("hello")\'',
    'perl -E \'say "hello"\'', 'ruby -e \'puts "hello"\'', 'swift -e \'print("hello")\'',
    'python3 script.py open', 'node script.js open', 'ruby script.rb open', 'perl script.pl open', 'swift script.swift open',
    'printf "%s" \'console.log("hello")\' | node',
    "ruby <<'EOF'\nputs 'hello'\nEOF", "swift - <<'EOF'\nprint(\"hello\")\nEOF",
    'cat <<EOF\n<(open x)\nEOF', "cat <<'EOF'\n$(open x)\nEOF",
  ]) assert.equal(denied(command), false, command);
  assert.equal(denied('cat <<EOF\n$(open x)\nEOF'), true, 'unquoted data still expands commands');
});

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

test('ordinary shell work and quoted examples remain allowed', () => {
  for (const command of ['printf "%s" "open https://example.invalid"', 'echo "one; open a && open b | open c & open d"',
    'echo open ./preview.html', 'rg "webbrowser.open" tests', 'cat open',
    'echo safari', 'printf "%s" Safari', 'rg Safari tests', 'cat safari',
    'arch -arm64 chromium --headless', 'timeout 10 firefox --headless',
    'caffeinate -t 5 msedge --headless', 'setsid opera --headless',
    'stdbuf -oL chromium --headless', 'script -q /dev/null firefox --headless',
    'launchctl asuser 501 msedge --headless', 'exec -a harmless opera --headless',
    'node --test tests/shell-guard.test.mjs', 'npm run lint:prose',
    'python3 -c \'print("one; two && three")\'', 'echo hi > /tmp/open',
    '# open ./preview.html\necho hi', 'printf ok # open ./preview.html',
    'env -u BROWSER chromium --headless', 'sh -c \'printf "%s" "open ./preview.html"\''])
    assert.equal(denied(command), false, command);
  for (const event of [{ tool: 'Read', command: 'open ./preview.html' }, { tool: 'Bash' },
    { tool: 'Bash', command: null }, {}]) assert.equal(guard.shellLaunchDenied(event), false);
});

test('heredoc data is skipped through its exact terminator and later commands still run', () => {
  for (const opener of ['<<EOF', "<<'EOF'", '<<"EOF"', '<<-EOF']) {
    const command = `git commit -F - ${opener}\nopen the door\nSafari\nEOF\nprintf ok`;
    assert.equal(denied(command), false, command);
    assert.equal(denied(command + '\nopen ./page.html'), true, command);
  }
  for (const command of [
    "cat >message <<'ONE' <<\"TWO\"\nopen the door\nONE\nSafari\nTWO",
    'cat >message <<-EOF\n\topen the door\n\tEOF\nprintf ok',
    'cat >message <<EOF\nopen the door\nEOFsuffix\nSafari\nEOF',
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
  assert.equal(denied("sh <<'OUTER'\ncat <<'INNER'\nopen the door\nINNER\nOUTER"), true);
});

test('unquoted heredocs check expanding substitutions without interpreting ordinary data', () => {
  for (const body of ['$(open ./page.html)', '`open ./page.html`', "'$(open ./page.html)'", '"$(open ./page.html)"']) {
    assert.equal(denied(`cat >message <<EOF\n${body}\nEOF`), true, body);
    assert.equal(denied(`cat >message <<'EOF'\n${body}\nEOF`), false, body);
  }
  assert.equal(denied('cat >message <<EOF # ordinary data follows\nopen the door\nEOF\nprintf ok'), false);
  assert.equal(denied('cat >message <<EOF # ordinary data follows\nopen the door\nEOF\nopen ./page.html'), true);
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
    if (name === './narration.mjs') return { createNarrationCache: () => ({ take() {}, configure() {}, observe() {}, reset() {} }) };
    if (name === './preapproved-write-guard.mjs') return {
      loggingSwitchWriteDenied: () => false, preapprovedWriteTarget: async () => { checked++; return refuseWrite ? "sleight's settings files" : undefined; },
      preapprovedWriteReason: label => `Only the user changes ${label}. Ask them to make this change.`,
    };
    return {};
  } });
  const hooks = new Map();
  exports.register((name, filter, handler) => {
    hooks.set(handler ? `${name}:${filter.tool ?? filter.command}` : name, handler ?? filter);
    return { catch() {} };
  });
  const pre = hooks.get('classic.PreToolUse'); assert.equal(typeof pre, 'function');
  const shell = hooks.get('tool.call:Bash'); assert.equal(typeof shell, 'function');
  let passed = 0;
  const $ = { env: { get: async key => key === 'SLEIGHT_SHELL_GUARD' ? (disabled ? '0' : undefined) : '/synthetic-home' },
    fs: { stat: async () => { throw Error('unexpected stat'); } },
    plugin: { root: '/synthetic-plugin' }, process: { run: async () => ({ exitCode: 0, stdout: '{"enabled":true}' }) },
    mcp: { connect: async () => ({ isConnected: true, server: 'computer' }), call: async (_server, _tool, args) => {
      if (args.sleight_turbo?.event === 'bootstrap') return { content: [{ type: 'text', text: JSON.stringify({ sleightTurbo: {
        version: 1, session: 'fixture', nonce: 'a'.repeat(64) } }) }] };
      if (args.hook_event_name) ended++;
      // Since RA1 the relay answers a begin frame with whether it bound a turbo turn.
      if (args.sleight_turbo?.event === 'begin') return { content: [{ type: 'text', text: JSON.stringify({ sleightRemote: { turboBound: true } }) }] };
      return { content: [] };
    } }, ui: { status() {}, log() {}, toast() {}, panes: async () => [] } };
  const next = event => { passed++; return event; };
  return { $, hooks, pre: event => event.tool === 'Bash' ? shell($, event, e => pre($, e, next)) : pre($, event, next), checked: () => checked, passed: () => passed, ended: () => ended,
    use: (tool = 'js', next = event => event, extra = {}) => hooks.get(`tool.call:mcp__plugin_sleight_computer__${tool}`)($, { tool_use_id: 'call', ...extra }, next),
    complete: (event, next = event => event) => hooks.get('turn.complete')($, event ?? {}, next),
    stop: () => hooks.get('command.run:sleight')($, { args: 'stop' }) };
}

test('installed tool.call shell fence refuses before PreToolUse filesystem access and preserves the write guard', { skip: parserSkip }, async () => {
  const h = installedGuard({ refuseWrite: true });
  await h.use();
  const pre = h.pre;
  assert.equal((await pre({ tool: 'Bash', command: 'open ./page.html' })).deny, guard.shellGuardReason);
  assert.equal(h.checked(), 0); assert.equal(h.passed(), 0);
  assert.match((await pre({ tool: 'Write', file_path: 'policy' })).deny, /Only the user changes sleight's settings files/);
  assert.equal(h.checked(), 1);
  await pre({ tool: 'Read' }); assert.equal(h.passed(), 1);
});

test('shell guard covers only sleight turns, resets on completion or stop, and supports opt-out', { skip: parserSkip }, async () => {
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
  assert.match((await off.pre(event)).deny, /Only the user changes sleight's settings files/, 'opt-out retains the approval write guard');
  const allow = installedGuard({ disabled: true }); await allow.use();
  assert.equal((await allow.pre(event)).deny, undefined);
  assert.match(guard.shellGuardReason, /sleight.*guard.*this turn/i);
  assert.match(guard.shellGuardReason, /SLEIGHT_SHELL_GUARD=0/);
});

test('turbo prompt setup alone leaves ordinary shell work untouched and still ends its binding', { skip: parserSkip }, async () => {
  const h = installedGuard(), event = { tool: 'Bash', command: 'open report.pdf' };
  await h.hooks.get('prompt.submit')(h.$, { origin: { kind: 'composer' }, text: 'ordinary work' }, event => event);
  assert.equal((await h.pre(event)).deny, undefined);
  await h.complete();
  assert.equal(h.ended(), 1);
  assert.equal((await h.pre(event)).deny, undefined);
});

// Each review reproducer is an independent assertion so a first failure cannot
// hide the other baseline bypasses. These strings are never executed.
for (const command of [
  '(( x = 1 << 2 ))\nopen ./p.html',
  'let x=1<<2\nopen ./p.html',
  'echo $[1<<2]\nopen ./p.html',
  'echo $((1<<2))\nopen ./p.html',
  '[[ 1 << 2 ]]\nopen ./p.html',
  'cat <<~EOF\n~EOF\nopen x\nEOF',
  'cat <<EOF | sh\nopen x\nEOF',
  'cat <<EOF | env sh\nopen x\nEOF',
  'cat <<EOF | xargs open\nopen x\nEOF',
  'sh <<< "open x"',
  'bash <(echo open x)',
  ...['fish -c', 'csh -c', 'tcsh -c', 'su -c', 'parallel', 'watch',
    'busybox sh -c'].map(prefix => `${prefix} 'open x'`),
  ...['doas', 'chroot /fixture', 'sandbox-exec -p "(allow default)"', 'xcrun',
    'ionice -c 3'].map(prefix => `${prefix} open x`),
  'shortcuts run "Open Safari"',
]) test(`fd4b review bypass refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));

test('availability checks do not launch an app, while execution forms still refuse', () => {
  for (const command of ['command -v open', 'command -V open', 'which open', 'type open', 'type -a open'])
    assert.equal(denied(command), false, command);
  for (const command of ['command -p open x', 'command -pv open x', 'exec open x', 'which open; open x'])
    assert.equal(denied(command), true, command);
});

test('uncertain heredocs and shell consumers keep command scans, while interpreter launchers refuse', () => {
  for (const command of [
    "unknown <<'EOF'\nopen x\nEOF",
    "cat >message <<'EOF'\nopen x", // No exact terminator.
    "cat >message <<'EOF'\nopen x\n EOF", // Spaces are not stripped.
    "cat >message <<-'EOF'\nopen x\n EOF",
    "git commit -F - <<'A' <<'B'\nplain\nA\nopen x", // All docs must match.
    'git commit -F - <<EOF\nEO\\\nF\nopen x\nEOF', // Expanded delimiter continuation.
    "cat >message <<$'EOF'\nEOF\nopen x", // Unsupported delimiter quoting.
    "cat >message <<'EOF'\nplain\nEOF\n(( x = 1 << 2 ))\nopen x",
    'python3 - <<\'EOF\'\nos.system("open x")\nEOF',
    'node - <<\'EOF\'\nrequire("child_process").execSync("open x")\nEOF',
    ...['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox sh', 'env sh',
      'xargs', 'xargs sh -c', 'doas sh', 'ionice -c 3 sh'].map(consumer =>
      `cat <<'EOF' | cat | ${consumer}\nopen x\nEOF`),
    "sh | cat <<'EOF' >message\nopen x\nEOF",
    "git commit -F - <<'EOF' | sh\nopen x\nEOF",
    "sh <<'OUTER'\ncat >message <<'INNER'\nopen x\nINNER\nOUTER",
    'cat <<< "open x" | env sh',
    'cat <(echo open x) | sh',
    'cat <<< "open x" | xargs',
  ]) assert.equal(denied(command), true, command);
});

test('file data sinks, captured cat output and scanned interpreter input still pass', () => {
  for (const command of [
    "cat >message <<'EOF'\nIt's (open) `open x`\nopen the door\nEOF",
    "tee message <<'EOF'\nopen the door\nEOF",
    "cat <<'ONE' <<\"TWO\" >message\nopen the door\nONE\nSafari\nTWO",
    "message=$(cat <<'EOF'\nIt's (open) `open x`\nopen the door\nEOF\n)",
    "gh issue create --body-file - <<'EOF'\nopen the door\nEOF",
    "gh pr comment 1 --body-file=- <<'EOF'\nopen the door\nEOF",
    'cat >message <<EOF\nordinary data\nEOF',
    "cat >message <<-'EOF'\n\topen the door\n\tEOF",
    "git commit -F - <<'EOF'\nEOFsuffix\nopen the door\nEOF",
    "cat >message <<\"E\\q\"\nopen the door\nE\\q",
    'cat >message <<EOF\n<(open x)\nEOF',
    "python3 - <<'PY'\nprint('hello')\nPY",
    "node - <<'JS'\nconsole.log('hello')\nJS",
  ]) assert.equal(denied(command), false, command);
});

test('proven commit data keeps apostrophes, parentheses, backticks and opener words literal', () => {
  const body = "It's a fix (reviewed). Let's keep (( examples, $[1<<2] and [[ examples.\n`open x`\n$(open x)\nopen the door\nSafari";
  for (const delimiter of ["'EOF'", '"EOF"', "E'OF'", '\\EOF']) {
    const command = `git commit -F - <<${delimiter}\n${body}\nEOF`;
    assert.equal(denied(command), false, command);
    assert.equal(denied(command + '\nopen x'), true, command);
  }
});

test('top-level completion clears the shell guard even when downstream completion throws', async () => {
  const h = installedGuard(), event = { tool: 'Bash', command: 'open report.pdf' };
  await h.use();
  await assert.rejects(h.complete({}, async () => { throw Error('completion failed'); }), /completion failed/);
  assert.equal((await h.pre(event)).deny, undefined);
  assert.equal(h.ended(), 1);
  await h.use();
  await assert.rejects(h.complete({ agentId: 'child' }, async () => { throw Error('child failed'); }), /child failed/);
  assert.equal((await h.pre(event)).deny, guard.shellGuardReason);
});

test('consumer checks follow quoted split strings, attached shell options and unknown pipes', () => {
  for (const command of [
    `env -S "s'h'" <<< 'open x'`,
    `cat >message <<'EOF' | env -S "s'h'"\nopen x\nEOF`,
    "tee message <<'EOF' | unknown\nopen x\nEOF",
    "sh -c'open x'", "fish --command='open x'", "busybox sh -c'open x'",
    "su fixture -lc'open x'", "su --command='open x' fixture",
    "echo $(cat >message <<'EOF' | sh\nopen x\nEOF\n)",
    'cat >message <<EO\\\nF\n$(open x)\nEOF',
    'git commit -F - <<E\u00a0F\nE\u00a0F\nopen x\nE',
    "unknown <<'EOF'\nIt's data to an unknown consumer.\nop\\\nen x\nEOF",
  ]) assert.equal(denied(command), true, command);
});

test('added wrappers preserve ordinary and headless commands with option operands', () => {
  for (const command of [
    'doas -u fixture chromium --headless', 'ionice -c3 -n7 chromium --headless',
    'chroot --userspec fixture /fixture chromium --headless',
    'parallel -j 2 chromium --headless', 'watch -n 2 chromium --headless',
    'busybox sh -c "chromium --headless"',
    'sandbox-exec -p "(allow default)" chromium --headless',
    'xcrun --sdk macosx --toolchain default chromium --headless',
    'su -c "printf ok"', 'shortcuts list',
  ]) assert.equal(denied(command), false, command);
});

test('every shell and xargs consumer scans each supported input form through pipelines', () => {
  for (const consumer of ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox sh',
    'env sh', 'env -S "s\'h\'"', 'xargs', 'xargs sh -c', 'doas sh', 'ionice -c 3 sh']) {
    for (const command of [
      `${consumer} <<'EOF'\nopen x\nEOF`,
      `${consumer} <<< 'open x'`,
      `${consumer} <(echo open x)`,
      `cat <<'EOF' | cat | ${consumer}\nopen x\nEOF`,
      `cat <<< 'open x' | cat | ${consumer}`,
      `cat <(printf '%s' 'open x') | cat | ${consumer}`,
    ]) assert.equal(denied(command), true, command);
  }
});

test('captured heredoc data cannot swallow a command after its exact closing boundary', () => {
  for (const body of ["It's open", 'open (', 'open )', '`open x`', '`', '$(open x)', 'Safari']) {
    for (const command of [
      `message=$(cat <<'EOF'\n${body}\nEOF\n)`,
      `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`,
    ]) {
      assert.equal(denied(command), false, command);
      assert.equal(denied(command + '\nopen x'), true, command);
    }
  }
});

// FD4F: only the guard sees these strings. No fixture program runs.
const fd4fPayloads = [
  ['python3', 'import subprocess as sp; sp.run(["open", "f"])'],
  ['python3', 'from subprocess import run; run(["open", "f"])'],
  ['python3', 'from subprocess import run as launch; launch(args=["open", "f"])'],
  ['python3', 'import subprocess; subprocess.run(args=["/usr/bin/open", "f"])'],
  ['python3', 'import subprocess; argv = ["open", "f"]; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ("open", "f"); subprocess.run(args=argv)'],
  ['python3', 'import subprocess; argv = "cat", "open"; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["sh", "-c", "open f"]; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["cat", "open"]; subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["open", "f"]; saved = argv; argv = ["cat", "f"]; subprocess.run(saved)'],
  ['python3', 'import subprocess; argv = ["open", "f"]; argv = argv; subprocess.run(argv)'],
  ['python3', 'import subprocess; subprocess.run(["cat", "open"])'],
  ['python3', 'import subprocess; subprocess.run(["env", "osascript", "script.scpt"])'],
  ['python3', 'import os as platform; platform.system("open f")'],
  ['python3', 'from os import popen as launch; launch("open f")'],
  ['python3', 'import asyncio; asyncio.create_subprocess_exec("open", "f")'],
  ['python3', 'import asyncio as aio; aio.create_subprocess_shell("cd /tmp && open f")'],
  ['python3', 'from asyncio import create_subprocess_exec as launch; launch("open", "f")'],
  ...['execv', 'execve', 'execvp', 'execvpe', 'execl', 'execle', 'execlp', 'execlpe',
    'spawnv', 'spawnve', 'spawnvp', 'spawnvpe', 'spawnl', 'spawnle', 'spawnlp', 'spawnlpe'].map(method =>
    ['python3', `import os; os.${method}(os.P_NOWAIT, "/usr/bin/open", ["open", "f"])`]),
  ...['run', 'call', 'check_call', 'check_output', 'Popen', 'getoutput', 'getstatusoutput'].map(method =>
    ['python3', `import subprocess; subprocess.${method}(args=["open", "f"])`]),
  ...['f', 'r', 'b', 'u', 'fr', 'rf', 'br', 'rb', 'F', 'R', 'B', 'U'].map(prefix =>
    ['python3', `import os; os.system(${prefix}"open f")`]),
  ['python3', 'import os; os.system("""cd /tmp && open f""")'],
  ['python3', "import subprocess; subprocess.run(args=(r'''/usr/bin/open''', 'f'))"],
  ...['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].flatMap(method => [
    ['node', `require("child_process").${method}("open", ["f"])`],
    ['node', `require("node:child_process")["${method}"]("open", ["f"])`],
    ['node', `const { ${method}: launch } = require("node:child_process"); launch("open", ["f"])`],
    ['node', `const { ${method} } = require("child_process"); ${method}("open", ["f"])`],
  ]),
  ['node', 'const cp = require("child_process"); cp["execFile"]("/usr/bin/open", ["f"])'],
  ['node', 'const { "spawn": launch } = require("child_process"); launch("open", ["f"])'],
  ['node', 'const { ["spawn"]: launch } = require("child_process"); launch("open", ["f"])'],
  ['node', 'import { spawn as launch } from "node:child_process"; launch("open", ["f"])'],
  ['node', 'import * as cp from "node:child_process"; cp.spawn("open", ["f"])'],
  ['node', 'const cp = require("child_process"); cp.execSync(`cd /tmp && open f`)'],
  ['node', 'const cp = require("child_process"); const argv = ["open"]; cp.spawn("env", argv)'],
  ['node', 'require("child_process").spawn("node", ["open"])'],
  ['node', 'require("open")("f")'], ['node', 'const launch = require("open"); launch("f")'],
  ['node', 'const text = `open the door`; require("child_process").spawn("open", ["f"])'],
  ['ruby', 'Open3.capture2("open", "f")'], ['ruby', 'Open3.capture3 "cd /tmp && open f"'],
  ['ruby', 'Open3.popen3("sh", "-c", "open f")'],
  ['ruby', '%x(open f)'], ['ruby', '%x(cd /tmp && open f)'],
  ['ruby', '`cd /tmp && /usr/bin/open f`'], ['perl', '`cd /tmp && open f`'],
  ['perl', 'qx(open f)'], ['perl', 'qx(cd /tmp && osascript script.scpt)'],
  ['perl', 'qx/open f/'], ['perl', 'qx{cd /tmp && open f}'], ['perl', 'qx"open f"'],
  ['perl', 'open(my $fh, "open f |")'], ['perl', 'open(my $fh, "| open f")'],
  ['perl', 'open(my $fh, "-|", "open", "f")'],
  ['perl', 'open my $fh, "|-", "/usr/bin/open", "f";'],
  ['swift', 'import Foundation; let p = Process(); p.launchPath = "/usr/bin/open"; p.launch()'],
  ['swift', 'import Foundation; let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); try p.run()'],
  ...[';', '&&', '||', '|'].map(op => ['python3', `import os; os.system("cd /tmp ${op} open f")`]),
  ...['sh -c open f', "sh -c 'open f'", 'bash -lc "open f"', 'env open f',
    'env LANG=C /usr/bin/open f', 'env -u BROWSER osascript script.scpt'].map(command =>
    ['python3', `import os; os.system(${JSON.stringify(command)})`]),
];
for (const [interpreter, payload] of fd4fPayloads) {
  const flag = interpreter === 'python3' ? '-c' : '-e';
  for (const command of [
    `${interpreter} ${flag} ${quotePayload(payload)}`,
    `${interpreter} <<'FD4F'\n${payload}\nFD4F`,
    `printf '%s' ${quotePayload(payload)} | ${interpreter}`,
  ]) test(`fd4f process argument refuses: ${JSON.stringify(command)}`, () => assert.equal(denied(command), true));
}

for (const [interpreter, payload] of [
  ['node', 'const text = `open the door`'],
  ['node', 'console.log(`open the file`)'],
  ['node', 'const text = `cd /tmp && open f`'],
  ['node', 'console.log(`open f (not a call)`)'],
  ['node', 'require("fs").open(`open the file`, "r", () => {})'],
  ['node', 'const cp = require("child_process"); cp.execSync("echo open")'],
  ['node', 'const spawn = "open the file"; console.log(spawn)'],
  ['node', 'const options = { exec: "open", spawn: "open" }; console.log(options)'],
  ['python3', 'import subprocess; method = subprocess.run; print("open")'],
  ['python3', 'import os; method = os.system; print("open")'],
  ['python3', 'import subprocess; argv = ["open", "f"]; argv = make_args(); subprocess.run(argv)'],
  ['python3', 'import subprocess; argv = ["open", "f"]; print(argv)'],
  ['python3', 'import subprocess; subprocess.run(["cat", "opener"])'],
  ['python3', 'import subprocess; subprocess.run(["cat", "f"]); print("open")'],
  ['python3', 'import subprocess; subprocess.run(["cat", "f"]); open("open", "w")'],
  ['python3', 'import subprocess; argv = ["open", "f"]; argv = ["cat", "f"]; subprocess.run(argv)'],
  ['python3', 'print("subprocess.run(open)")'],
  ['python3', 'qx("open")'],
  ['python3', 'open(r"open", "w"); Path("f").open()'],
  ['ruby', 'File.open("open", "w") { |f| f.write("open") }'],
  ['perl', 'open(my $fh, "<", "open")'],
  ['perl', 'open my $fh, "<", "open";'],
]) {
  for (const command of [
    `${interpreter} ${interpreter === 'python3' ? '-c' : '-e'} ${quotePayload(payload)}`,
    `${interpreter} <<'FD4F'\n${payload}\nFD4F`,
    `printf '%s' ${quotePayload(payload)} | ${interpreter}`,
    `${interpreter} <<< ${quotePayload(payload)}`,
    `${interpreter} < <(printf '%s' ${quotePayload(payload)})`,
  ]) test(`fd4f file IO and template data pass: ${JSON.stringify(command)}`, () => assert.equal(denied(command), false));
}

test('fd4f repeated literal references stay bounded without expanding the program data', () => {
  const source = 'import subprocess; argv = ["cat"]; ' + 'argv = [argv, argv]; '.repeat(19) + 'subprocess.run(argv)';
  assert.equal(denied(`python3 -c ${quotePayload(source)}`), false);
});
