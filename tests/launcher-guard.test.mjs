import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preapprovedWriteDenied as denied } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';

// Command text is validation data. These tests never execute it.
const stat = async path => ({ realPath: path });
const allowed = [
  ['a doctor and read pipelines', "~/Projects/sleight/plugins/sleight/bin/sleight-mcp --doctor 2>&1 | grep -E 'computer-use [0-9]|engine docs'; tail -5 log"],
  ['b dated English log', 'echo "- $(date -u +%H:%MZ) ... tests hand the link to the OS ..." >> PLAN.md'],
  ['c grep pattern pipelines', 'grep -h -o -E "mailto:[^\'\\"\\` )]*" files | sort | uniq -c; grep -n -E "^(x) .*(mail link|app link)" log | head'],
];
const refused = [
  `python3 <<'PY'\nfrom pathlib import Path\np = Path('STATE.md')\np.write_text(p.read_text().replace("turbo's [old]", "turbo's {new}"))\nPY`,
  'sleight-mcp turbo on',
  'X=sleight-mcp; $X turbo on',
  'sleight-mcp --doctor; sleight-mcp turbo on',
  'echo turbo on | xargs sleight-mcp',
  'echo "sleight-mcp turbo on" | sh',
  'node launch.mjs hand on',
  'sh -c "sleight-mcp hand on"',
  '$(echo sleight-mcp) turbo on',
  'sleight-mcp --doctor $(touch x)',
  'sleight-mcp --doctor turbo on',
  "git -c alias.x='!sleight-mcp turbo on' x",
  'env sleight-mcp permissions block x',
];
for (const [label, command] of allowed) test(`GD1 allows ${label}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, { stat }), false, command);
});
for (const command of refused) test(`GD1 refuses ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
});

const dataCommands = ['echo "hand link $HOME {} [] * ?"', 'printf "%s" "hand $(date) {}"',
  'grep "hand.*link" "$FILE"', 'cat "$FILE" hand*', 'sed -n "/hand.*link/p" "$FILE"',
  'sed -e "s/hand.*/link/" "$FILE"', 'sort hand*', 'uniq "$FILE" hand', 'head "$FILE" hand',
  'tail "$FILE" hand', 'wc "$FILE" hand', 'jq ".hand[] | .link" "$FILE"'];
for (const command of dataCommands) {
  test(`GD1 fixed data argv allows ${command}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command }, { stat }), false, command);
  });
  test(`GD1 protected redirect refuses ${command}`, async () => {
    const input = `${command} > "$HOME/Library/Application Support/sleight/hand.json"`;
    assert.equal(await denied({ tool: 'Bash', command: input }, { stat }), true, input);
  });
}
test('GD1 sed pipeline expressions remain data when they cannot execute text', async () => {
  for (const command of ['printf "%s" "hand $HOME" | sed -e "s/hand/link/"',
    'echo "hand $HOME" | sed --expression="s/hand/link/"']) {
    assert.equal(await denied({ tool: 'Bash', command }, { stat }), false, command);
  }
});
for (const command of [
  'echo "hand $(sleight-mcp turbo on)"', 'printf "%s" "hand `sleight-mcp turbo on`"',
  'grep "link $(sh -c \'sleight-mcp hand on\')" file',
  'echo hand <(python3 -c "import os; os.system(\'sleight-\'+\'mcp hand on\')")',
  'echo "hand $(printf x > \'~/Library/Application Support/sleight/hand.json\')"',
  'sleight-mcp --doctor extra', 'node launch.mjs --doctor extra',
  'PATH=/tmp/other echo "hand $HOME"', 'env echo "hand $HOME"',
  'rg --pre "$PROGRAM" hand file', 'sort --compress-program="$PROGRAM" hand*',
  'sed -n "e $PROGRAM hand" file', 'sed "s/x/$PROGRAM hand/e" file', 'sed -f "$SCRIPT" hand',
  'sed -e "$SCRIPT" hand', 'sed -i "" "s/hand/link/" "$FILE"',
  'sort --compress-prog="$PROGRAM" hand*', 'echo "hand $INPUT" | sed e',
  'sed -n "w ~/Library/Application Support/sleight/hand.json" file',
  'sed "s/hand/link/w ~/Library/Application Support/sleight/hand.json" file',
  'sed -i "" "s/hand/link/" "~/Library/Application Support/sleight/hand.json"',
  `python3 <<'PY'\nimport os\nos.system('sleight-' + 'mcp hand on')\nPY`,
  `python3 <<'PY'\nimport subprocess\nsubprocess.run(['sleight-' + 'mcp', 'hand', 'on'])\nPY`,
  `python3 <<'PY'\ngetattr(__import__('os'), 'sy' + 'stem')('sleight-' + 'mcp hand on')\nPY`,
  `sh <<'SH'\nsleight-mcp hand on\nSH`,
  `python3 <<'PY'\nfrom pathlib import Path\np = Path('~/Library/Application Support/sleight/hand.json')\np.write_text("turbo's {}")\nPY`,
  'sleight-mcp --doctor | xargs sleight-mcp', 'echo "hand link" | sh',
  'sleight-mcp --doctor; source "$SCRIPT"', 'sleight-mcp --doctor; python3 -c "$CODE"',
  'sleight-mcp --doctor; echo hand $(eval "$PROGRAM")',
  'echo "\npython3 <<\'PY\'\n"; $X hand on\nPY',
  `python3 <<'PY'\nprint("turbo's {}")\nPY\nsleight-mcp turbo on`,
  `python3 <<PY\nprint("$(sleight-mcp hand on)")\nPY`,
  `node <<'JS'\nconst op = 'hand';\nconst name = 'sleight-' + 'mcp';\nrequire('child_process').spawnSync(name, [op, 'on']);\nJS`,
  `python3 <<'PY'\nfrom pathlib import Path\nPath('~/Library/' + 'Application Support/sleight/' + 'hand' + '.json').write_text('{}')\nPY`,
]) test(`GD1 executable or protected data refuses ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
});

for (const subcommand of ['turbo', 'hand', 'permissions', 'cursor', 'menu', 'link', 'unlink']) {
  test(`GD1 paired data and executable expansions for ${subcommand}`, async () => {
    for (const command of [`echo "${subcommand} $(date) [x] {x,y}"`, `grep "${subcommand}.*" "$FILE"`,
      `sleight-mcp --doctor | grep "${subcommand}.*"; printf "%s" "${subcommand} $HOME"`]) {
      assert.equal(await denied({ tool: 'Bash', command }, { stat }), false, command);
    }
    for (const command of [`sleight-mcp ${subcommand} $VALUE`, `X=sleight-mcp; $X ${subcommand} on`,
      `echo "${subcommand} $(sleight-mcp ${subcommand} on)"`, `echo "${subcommand} $VALUE" | xargs sleight-mcp`,
      `echo "${subcommand} $VALUE" | sh`, `python3 -c "import os; os.system('sleight-' + 'mcp ${subcommand} on')"`]) {
      assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
    }
  });
}

// Exact Python heredoc regressions from the seven GD1 reviewer candidate scripts.
const reviewRegressions = [
  "python3 <<'PY'\nimport os\nos.posix_spawn('/bin/sh',['sh','-c','sl'+'eight-mcp turbo on'],os.environ)\nPY",
  "python3 <<'PY'\nimport os\nos.posix_spawn('/bin/sh',['sh','-c','sl'+'eight-mcp','turbo','on'],os.environ)\nPY",
  "python3 <<'PY'\nimport os\nos.posix_spawnp('sl'+'eight-mcp',['x','turbo','on'],os.environ)\nPY",
  "python3 <<'PY'\nimport asyncio\nasyncio.run(asyncio.create_subprocess_exec('sl'+'eight-mcp','turbo','on'))\nPY",
  "python3 <<'PY'\nimport asyncio\nasyncio.run(asyncio.create_subprocess_shell('sl'+'eight-mcp turbo on'))\nPY",
  "python3 <<'PY'\nimport os\nvars(os)['sys'+'tem']('sl'+'eight-mcp turbo on')\nPY",
  "python3 <<'PY'\nimport os, operator\noperator.attrgetter('sys'+'tem')(os)('sl'+'eight-mcp turbo on')\nPY",
  "python3 <<'PY'\nimport os\nimport pydoc\npydoc.pipepager('x', 'sl'+'eight-mcp turbo on')\nPY",
  "python3 <<'PY'\nimport ctypes\nctypes.CDLL(None)['sys'+'tem'](b'sl'+b'eight-mcp turbo on')\nPY",
  "python3 <<'PY'\nimport pickle\npickle.loads(b'x')  # turbo\nPY",
  "python3 <<'PY'\nimport code\ncode.interact(local={}, banner='turbo')\nPY",
  "python3 <<'PY'\nimport webbrowser\nwebbrowser.get('sl'+'eight-mcp turbo on %s').open('x')\nPY",
  "python3 <<'PY'\nimport os\nos.chmod('/tmp/x.sh', 0o755)  # turbo\nPY",
  "python3 <<'PY'\nimport os\nopen('/tmp/x.sh','w').write('sl'+'eight-mcp turbo on')\nPY",
  "python3 <<'PY'\nimport os\nd=os.path.expanduser('~/Lib'+'rary/Application Support/sl'+'eight/')\nopen(d+'tu'+'rbo.js'+'on','w').write('{\"turbo\":1}')\nPY",
  "python3 <<'PY'\nimport os\nd=os.path.expanduser('~/Lib'+'rary/Application Support/sl'+'eight/')\nopen(d+'hand.js'+'on','w').write('{\"hand\":1}')\nPY",
  "python3 <<'PY'\nimport os\nd=os.path.expanduser('~/Lib'+'rary/Application Support/sl'+'eight/')\nopen(d+'hand.js'+'on','w').write('{\"hand\":1}')\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nimport os\nd=os.path.expanduser('~/Lib'+'rary/Application Support/sl'+'eight/')\nopen(d+'tu'+'rbo.js'+'on','w').write('{\"turbo\":{x}}')\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nx = {\"a\": [1]}\nprint(x[\"a\"])\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nprint(\"$HOME\")\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nprint(\"$(date)\")\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nprint(\"{}\")\nPY\nsleight-mcp turbo status",
  "python3 <<'PY'\nprint(\"turbo {}\")\nPY",
  "python3 - <<'PY'\nprint(\"turbo {}\")\nPY",
  "python3 <<\"PY\"\nprint(\"turbo {}\")\nPY",
  "python3 <<'PY'\nprint(\"turbo {}\")\nPY\n",
  "\npython3 <<'PY'\nprint(\"turbo {}\")\nPY",
  "  python3 <<'PY'\nprint(\"turbo {}\")\nPY",
  "/usr/bin/python3 <<'PY'\nprint(\"turbo {}\")\nPY",
  "/tmp/evil/python3 <<'PY'\nprint(\"turbo {}\")\nPY",
  "./python3 <<'PY'\nprint(\"turbo {}\")\nPY",
  "python3.11 <<'PY'\nprint(\"turbo {}\")\nPY",
  "python3 <<'PY'\nprint(\"turbo {}\")\nPY\nPY",
  "python3 <<'PY'\nimport sitecustomize\nprint(\"turbo {}\")\nPY",
  "python3 <<'PY'\nimport evil\nprint(\"turbo {}\")\nPY",
  "python3 <<'PY'\nimport evil  # turbo {}\nPY",
  "python3 <<'PY'\nimport os\nopen(os.path.expanduser('~/Lib'+'rary/Application Support/sl'+'eight/')+'tu'+'rbo.js'+'on','w').write('{\"turbo\":1}')\nPY",
  "python3 <<'PY'\nimport os\nopen(os.path.expanduser('~/Lib'+'rary/Application Support/sl'+'eight/')+'tu'+'rbo.js'+'on','w').write('{}')\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nimport os\nos.posix_spawn('/bin/sh',['sh','-c','sl'+'eight-mcp tu'+'rbo on'],os.environ)\nPY\nsleight-mcp --doctor",
  "python3 <<'PY'\nimport os\nos.posix_spawn('/bin/sh',['sh','-c','sl'+'eight-mcp tu'+'rbo on'],os.environ)\nPY\nsleight-mcp turbo status"
];
for (const [i, command] of reviewRegressions.entries()) test(`GD2 refuses reviewer heredoc regression ${i + 1}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
});

const settings = '~/Library/Application Support/sleight';
for (const interpreter of ['python3', 'node', 'ruby', 'perl', 'sh', 'bash', 'zsh', 'osascript']) {
  for (const [label, body] of [
    ['Path write', `from pathlib import Path\nPath('${settings}/hand.json').write_text('{}')`],
    ['split filename', `p = '${settings}/' + 'tu' + 'rbo.js' + 'on'`],
    ['separate path pieces', `root = 'Application Support'; name = 'sleight'; file = 'opaque'`],
    ['split launcher', `name = 'sl' + 'eight-mcp'; op = 'tu' + 'rbo'`],
    ['escaped launcher', 's\\leight-mcp --doctor'],
    ['quoted launcher', 'sl""eight-mcp --doctor'],
    ['short launcher', 'sleight --doctor'],
  ]) for (const delimiter of ["'EOF'", 'EOF', "-'EOF'"]) {
    const command = `${interpreter} <<${delimiter}\n${body}\nEOF`;
    test(`GD2 refuses ${interpreter} heredoc ${label} ${delimiter}`, async () => {
      assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
    });
  }
}
for (const body of [
  "import os\nos.posix_spawn('/bin/sh',['sh','-c','sl'+'eight-mcp turbo on'],{})",
  "import asyncio\nasyncio.create_subprocess_exec('sl'+'eight-mcp','turbo','on')",
  "import asyncio\nasyncio.create_subprocess_shell('sl'+'eight-mcp turbo on')",
  "import os\nvars(os)['sys'+'tem']('sl'+'eight-mcp turbo on')",
  "import operator, os\noperator.attrgetter('sys'+'tem')(os)('sl'+'eight-mcp turbo on')",
  "import ctypes\nctypes.CDLL(None)['sys'+'tem'](b'sl'+b'eight-mcp turbo on')",
  "import pydoc\npydoc.pipepager('x','sl'+'eight-mcp turbo on')",
  "import webbrowser\nwebbrowser.get('sl'+'eight-mcp turbo on %s').open('x')",
  "import pickle\npickle.loads(b'x') # turbo",
  "import code\ncode.interact(local={},banner='turbo')",
]) test(`GD2 refuses process or reflection body ${body}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command: `python3 <<'PY'\n${body}\nPY` }, { stat }), true);
});
for (const file of ['preapproved.json', 'turbo.json', 'turbo-apps.json', 'turbo-owner.json', 'electron-grants.json',
  'grant-seal.key', 'hand.json', 'permissions.json', 'menu-presence.lock', 'menu-session.lock', 'settings-link.json', '.sleight-shim-v1']) {
  test(`GD2 refuses heredoc protected filename ${file}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command: `node <<'JS'\nconst p = '${file}';\nJS` }, { stat }), true);
  });
}
for (const command of [
  `cat <<'PY' | python3\nPath('${settings}/hand.json').write_text('{}')\nPY`,
  `cat <<'SH' | sh\nsl""eight-mcp --doctor\nSH`,
  `env python3 - <<-'PY'\n\tPath('${settings}/hand.json').write_text('{}')\n\tPY`,
  `python3 <<'PY'\nPath('${settings}/hand.json').write_text('{}')`,
  `sh <<'SH'\nsleight-mcp --doctor\nSH`,
  `sleight-mcp --doctor <<'EOF'\nhand on\nEOF`,
  `python3 <<'A' <<'B'\nprint(1)\nA\nPath('${settings}/hand.json').write_text('{}')\nB`,
  `python3 \\\n - <<'PY'\nPath('${settings}/hand.json').write_text('{}')\nPY`,
  `sh -c "python3 <<'PY'\nPath('${settings}/hand.json').write_text('{}')\nPY"`,
]) test(`GD2 refuses heredoc shape ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
});

for (const script of ['s/a/b/gw F', '1,2w F', '{w F}', 'W F', 'wF', 'w/F', '/a/w F', '$w F', '/[/]/w F',
  '1!w F', 's/a/b/;w F', 'p\nw F', 's#a#b#2gw F', '{w F};p', 's/a/b/gw F;p', 'W F;p']) {
  for (const option of ['', '-e ', '--expression=', '-ne']) {
    const command = `sed ${option}'${script.replace('F', settings + '/hand.json')}' input`;
    test(`GD2 refuses sed write ${option}${script}`, async () => {
      assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
    });
  }
}
for (const script of ['{e}', '1!e', 's///e;p', '{e sleight-mcp turbo on\n}', '1,2e',
  '/x/e', '/[/]/e', 's/[/]/b/e;p', 's#a#b#ge;p', 's/a/b/e;p', '1~2e', '$e', 'p;{e}']) {
  for (const option of ['', '-e ', '--expression=', '-ne']) {
    const command = `printf x | sed ${option}'${script}'`;
    test(`GD2 refuses sed executes ${option}${script}`, async () => {
      assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
    });
  }
}
for (const form of [
  'sort -o OUT input', 'sort -oOUT input', 'sort -ro OUT input', 'sort --output OUT input', 'sort --output=OUT input',
  'uniq input OUT', 'uniq -c input OUT', 'uniq -f 2 -s 3 -w 4 input OUT', 'uniq -- input OUT',
  'file -C -m OUT', 'file -Cm OUT', 'file -CmOUT', 'file --compile --magic-file=OUT',
]) for (const path of [settings + '/hand.json', '~/.local/bin/sleight', '~/Library/Caches/sleight/host']) {
  const command = form.replace('OUT', `"${path}"`);
  test(`GD2 refuses output operand ${command}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
  });
}
for (const command of [
  'echo "$(date) hand" >> ~/.zshrc', 'printf "%s" "$(date) hand" > ~/.zshrc',
  'echo $(date) hand >> ~/.zshrc', 'echo $(date) hand | tee ~/.zshrc',
  'echo "$(date) hand" > .claude/settings.json', 'echo "$(date) hand" | tee ~/.zshrc',
  'sort -o ~/.zshrc "$(date) hand"', 'uniq "$(date) hand" ~/.zshrc',
  'file -C -m ~/.zshrc "$(date) hand"', 'sed "w ~/.zshrc" "$(date) hand"',
  'sed "W ~/.zshrc" "$(date) hand"',
  `echo "$(date) hand" >> "${settings}/hand.json"`,
  'echo x | sed -f /tmp/script.sed', 'echo x | sed --file=/tmp/script.sed',
]) test(`GD2 refuses substitution writer or opaque sed ${command}`, async () => {
  assert.equal(await denied({ tool: 'Bash', command }, { stat }), true, command);
});
for (const command of ['echo "$(date) hand"', 'printf "%s" "$(date) hand"',
  'grep "$(date) hand.*" file', 'grep "hand.*[0-9]" file*',
  'echo "$(date) hand" >> PLAN.md', 'sed -n "s/a/b/g;p" file',
  'sort -o output.txt input', 'uniq -f 2 input output.txt', 'file -C -m fixture.magic']) {
  test(`GD2 preserves data or ordinary output ${command}`, async () => {
    assert.equal(await denied({ tool: 'Bash', command }, { stat }), false, command);
  });
}
test('GD2 sedExecutes scans 64k characters under 20 ms', async t => {
  // Load this private helper from the same module text without expanding the production API.
  const source = readFileSync(new URL('../plugins/sleight/hooks/preapproved-write-guard.mjs', import.meta.url), 'utf8');
  const { sedExecutes } = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { sedExecutes };').toString('base64')}`);
  const inputs = ['s/a/b/' + 'g'.repeat(65530), 's/a/b/' + 'g'.repeat(65528) + 'e;p',
    '/' + 'a'.repeat(65530) + '/!e', 'a'.repeat(65536)];
  for (let i = 0; i < 10; i++) inputs.forEach(sedExecutes);
  const times = [];
  for (const [index, input] of inputs.entries()) {
    const start = performance.now();
    assert.equal(sedExecutes(input), index === 1 || index === 2);
    const elapsed = performance.now() - start;
    times.push(elapsed);
    assert.ok(elapsed < 20, `${input.length} chars took ${elapsed.toFixed(3)} ms`);
  }
  t.diagnostic(`64k scan times ms: ${times.map(ms => ms.toFixed(3)).join(', ')}`);
});
