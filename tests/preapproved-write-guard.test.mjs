// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const guard = async (...args) => {
  const { preapprovedWriteDenied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  return preapprovedWriteDenied(...args);
};
const stat = async path => ({ realPath: path });
for (const filename of ['preapproved.json', 'turbo.json', 'turbo-apps.json', 'turbo-owner.json', 'electron-grants.json', 'grant-seal.key', 'hand.json', 'permissions.json']) {
const policy = `${MAC_USERS}fixture/Library/Application Support/sleight/` + filename;

test(filename + ': each file mutation denies the policy path and case and tilde spellings', async () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    for (const path of [policy, policy.toUpperCase(), '~/Library/Application Support/sleight/' + filename]) {
      assert.equal(await guard({ tool, file_path: path, notebook_path: path }, { stat }), true);
    }
    assert.equal(await guard({ tool, file_path: '/project/' + filename, notebook_path: '/project/' + filename }, { stat }), false);
  }
  assert.equal(await guard({ tool: 'MultiEdit', edits: [{ file_path: policy }] }, { stat }), true);
});

test(filename + ': named Bash mutation forms deny while reads and quoted operators pass', async () => {
  const p = JSON.stringify(policy);
  for (const command of [`printf '{}' > ${p}`, `echo '{}' >> ${p}`, `tee ${p}`, `cp source ${p}`,
    `mv ${p} backup`, `rm ${p}`, `sed -i '' 's/a/b/' ${p}`, `python3 -c "open('${policy}', 'w').write('{}')"`,
    `node -e "require('fs').writeFileSync('${policy}', '{}')"`, `defaults write ${p} enabled true`,
    `echo '{}' > ~/Library/Application\\ Support/sleight/${filename}`,
    `tee "$HOME/Library/Application Support/sleight/${filename}"`,
    `tee "\${HOME}/Library/Application Support/sleight/${filename}"`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
  for (const command of [`cat ${p}`, `sed -n '1p' ${p}`, `printf '%s' '>' ${p}`, `echo 'cp ${policy}'`, 'cp a /project/' + filename]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
  assert.equal(await guard({ tool: 'Read', file_path: policy }, { stat }), false);
});

test(filename + ': resolved file and parent symlinks protect existing and absent policy files', async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-policy-guard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'Library/Application Support/sleight'); mkdirSync(directory, { recursive: true });
  const target = join(directory, filename); writeFileSync(target, '{}');
  const alias = join(root, 'alias'); symlinkSync(target, alias);
  const parent = join(root, 'parent'); symlinkSync(directory, parent);
  const resolve = async path => ({ realPath: realpathSync(path) });
  for (const path of [alias, join(parent, filename)]) {
    assert.equal(await guard({ tool: 'Write', file_path: path }, { stat: resolve }), true);
    assert.equal(await guard({ tool: 'Bash', command: `tee '${path}'` }, { stat: resolve }), true);
  }
  rmSync(target);
  assert.equal(await guard({ tool: 'Write', file_path: join(parent, filename) }, { stat: resolve }), true);
});

test(filename + ': shell continuations and attached eval options cannot hide writes', async () => {
  for (const command of [`tee "${policy.replace('.json', '.\\\njson')}"`,
    `node -e"require('fs').writeFileSync('${policy}', '{}')"`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
});

test(filename + ': copying or redirecting a policy read to another file remains allowed', async () => {
  const p = JSON.stringify(policy);
  for (const command of [`cat ${p} > /tmp/policy-copy.json`, `cp ${p} /tmp/policy-copy.json`,
    `cat ${p}; cp a b`, `cat ${p}\ncp a b`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
});

test(filename + ': symlink traversal precedes dot-dot normalization and HOME is only an expansion hint', async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-policy-traversal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'Library/Application Support/sleight'); mkdirSync(join(directory, 'child'), { recursive: true });
  const alias = join(root, 'alias'); symlinkSync(join(directory, 'child'), alias);
  const resolve = async path => ({ realPath: realpathSync(path) });
  const path = `${alias}/../${filename}`;
  assert.equal(await guard({ tool: 'Write', file_path: path }, { stat: resolve }), true);
  assert.equal(await guard({ tool: 'Write', file_path: '~/alias/../' + filename }, { stat: resolve, home: root }), true);
  assert.equal(await guard({ tool: 'Write', file_path: policy }, { stat, home: '/unrelated' }), true);
});

test(filename + ': inline reads and script arguments remain allowed without statting source strings', async () => {
  let stats = 0;
  const counted = async path => { stats++; return stat(path); };
  for (const command of [
    `python3 -c "print(open('${policy}').read())"`,
    `node -e "console.log(require('fs').readFileSync('${policy}'))"`,
    `python3 script.py ${JSON.stringify(policy)}`,
    `python3 -c "${'x = 1; '.repeat(500)}print(open('${policy}').read())"`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, { stat: counted }), false, command.slice(0, 80));
  assert.equal(stats, 0, 'source strings and read operands need no filesystem probes');
});

test(filename + ': additional literal shell writers, nested shells and prefixes deny the policy', async () => {
  const p = JSON.stringify(policy), directory = JSON.stringify(policy.slice(0, -('/' + filename).length));
  for (const command of [
    `ln -sf source ${p}`, `perl -pi -e 's/a/b/' ${p}`, `perl -i.bak -e 's/a/b/' ${p}`,
    `plutil -replace key -string value ${p}`, `plutil -insert key -string value ${p}`,
    `plutil -remove key ${p}`, `plutil -convert json ${p}`, `truncate -s 0 ${p}`, `dd if=source of=${p}`,
    `install source ${p}`, `rsync source ${p}`, `ruby -e "File.write('${policy}', '{}')"`,
    `printf '{}' >| ${p}`, `printf '{}' >& ${p}`,
    `bash -c 'tee "${policy}"'`, `sh -c 'rm "${policy}"'`, `xargs rm ${p}`,
    `printf '%s\\n' ${p} | xargs rm`, `time rm ${p}`, `nohup rm ${p}`, `env -i rm ${p}`,
    `cd ${directory} && tee ${filename}`, `cd ${directory}; rm ${filename}`,
    `cp source ${directory}`, `mv source ${directory}`, `rm -rf ${directory}`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, { stat, home: `${MAC_USERS}fixture` }), true, command);
});

test(filename + ': inline write forms deny without probing code or long path-like strings', async () => {
  let stats = 0;
  const counted = async path => { stats++; return stat(path); };
  for (const command of [
    `python3 -c "p='${policy}'; open(p, mode='a').write('{}')"`,
    `node -e "const p='${policy}'; require('fs').appendFileSync(p, '{}')"`,
    `ruby -e "File.open('${policy}', 'w') { |f| f.write('{}') }"`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, { stat: counted }), true, command);
  assert.equal(stats, 0);
  assert.equal(await guard({ tool: 'Bash', command: `rm ${'/x'.repeat(500)}` }, { stat: counted }), false);
  assert.equal(stats, 0, 'path operands longer than 511 characters are not probed');
});
}

test('turbo on and off are the user\'s commands: no spelling of a model shell runs them, status and other commands pass', async () => {
  for (const command of ['sleight-mcp turbo on', 'sleight-mcp turbo off', '/x/plugins/sleight/bin/sleight-mcp turbo on --browser helium',
    'node /x/plugins/sleight/lib/launch.mjs turbo off', 'cd /tmp && sleight-mcp turbo on', 'bash -c "sleight-mcp turbo off"', 'env A=1 sleight-mcp turbo on',
    'env sleight-mcp turbo off', 'nohup sleight-mcp turbo off', 'timeout 5 sleight-mcp turbo on', 'nice -n 5 sleight-mcp turbo on', 'caffeinate sleight-mcp turbo on',
    'exec sleight-mcp turbo off', 'command sleight-mcp turbo on', '/usr/bin/env node /x/lib/launch.mjs turbo on', 'node --no-warnings /x/lib/launch.mjs turbo on',
    'node --no-warnings --max-old-space-size=64 launch.mjs turbo off', 'sh -c "sleight-mcp turbo off"', 'zsh -lc "cd /x && sleight-mcp turbo on"',
    '/bin/bash -lc \'node /x/lib/launch.mjs turbo off\'', 'sh -c "true; sleight-mcp turbo on"', 'true; sleight-mcp turbo off', 'true && sleight-mcp turbo on',
    'false || sleight-mcp turbo on --browser chrome', 'echo hi | sleight-mcp turbo on', 'sleight-mcp turbo', 'sleight-mcp "turbo" "on"']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
  for (const command of ['sleight-mcp turbo status', 'env sleight-mcp turbo status', 'node --no-warnings /x/lib/launch.mjs turbo status', 'sh -c "sleight-mcp turbo status"',
    'sleight-mcp turbo-state', 'sleight-mcp --doctor', 'sleight-mcp allow list', 'turbo on', 'echo turbo off']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
  assert.equal(await guard({ tool: 'Read', file_path: `${MAC_USERS}fixture/Library/Application Support/sleight/turbo.json` }, { stat }), false);
  assert.equal(await guard({ tool: 'Write', file_path: `${MAC_USERS}fixture/Library/Application Support/sleight/turbo.json` }, { stat }), true);
});

test('hand on, off and capture are the user\'s commands the same way: every spelling but status denies', async () => {
  for (const command of ['sleight-mcp hand on', 'sleight-mcp hand off', 'sleight-mcp hand capture visible', '/x/plugins/sleight/bin/sleight-mcp hand off',
    'node /x/plugins/sleight/lib/launch.mjs hand off', 'cd /tmp && sleight-mcp hand on', 'bash -c "sleight-mcp hand off"', 'env A=1 sleight-mcp hand on',
    'nohup sleight-mcp hand off', 'timeout 5 sleight-mcp hand capture hidden', 'sh -c "true; sleight-mcp hand on"', 'true && sleight-mcp hand off',
    'zsh -lc "cd /x && sleight-mcp hand capture visible"', '/bin/bash -lc \'node /x/lib/launch.mjs hand off\'', 'echo hi | sleight-mcp hand on',
    'sleight-mcp hand', 'sleight-mcp "hand" "off"', 'node --no-warnings /x/lib/launch.mjs hand on']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
  for (const command of ['sleight-mcp hand status', 'env sleight-mcp hand status', 'sh -c "sleight-mcp hand status"', 'node /x/lib/launch.mjs hand status',
    'sleight-mcp handy', 'sleight-mcp --doctor', 'hand off', 'echo hand on', 'sleight-mcp turbo status']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
});
test('cursor import and remove use the hand shell guard while list and check stay open', async () => {
  for (const command of ['sleight-mcp cursor import /tmp/cat --yes', 'sleight-mcp cursor remove cat',
    'node /x/lib/launch.mjs cursor import /tmp/cat', 'env A=1 sleight-mcp cursor remove cat',
    'sh -c "sleight-mcp cursor remove cat"', 'zsh -lc "cd /x && sleight-mcp cursor import /tmp/cat --yes"',
    'timeout 5 sleight-mcp cursor remove cat', 'sleight-mcp "cursor" "remove" cat',
    'true && sleight-mcp cursor remove cat', 'echo hi | sleight-mcp cursor import /tmp/cat --yes',
    "printf 'remove x' | xargs sleight-mcp cursor", 'OP=remove; node launch.mjs cursor $OP x', 'sleight-mcp cursor "$OP" x',
    'sleight-mcp cursor ${OP:-remove} x', 'sleight-mcp cursor $(echo remove) x', 'sh -c "sleight-mcp cursor $(echo remove) x"',
    "printf 'remove' | xargs -I{} sleight-mcp cursor {} x", 'sleight-mcp cursor style sprite', 'sleight-mcp cursor']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
  for (const command of ['sleight-mcp cursor status', 'node /x/lib/launch.mjs cursor status', 'sh -c "sleight-mcp cursor status"', 'sleight-mcp cursor list', 'sleight-mcp cursor check cat', 'env sleight-mcp cursor list',
    'node /x/lib/launch.mjs cursor check cat', 'sh -c "sleight-mcp cursor list"', 'echo cursor remove cat']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
});
test('a launcher command word beside a subcommand word passes only as a plain direct read-only form, for every launcher command', async () => {
  const refused = { turbo: ['turbo on', 'turbo off'], hand: ['hand on', 'hand capture visible'], permissions: ['permissions unblock x.y', 'permissions revoke all'],
    cursor: ['cursor style ring', 'cursor remove cat'] };
  const reads = { turbo: ['turbo status'], hand: ['hand status'], permissions: ['permissions', 'permissions list'], cursor: ['cursor status', 'cursor list', 'cursor check cat'] };
  for (const [command, writes] of Object.entries(refused)) {
    const read = reads[command][0];
    for (const write of writes) {
      const [word, ...rest] = write.split(' '), tail = rest.join(' ');
      for (const spelling of [
        // Substitutions and expansions in the arguments, after or around the launcher.
        `sleight-mcp ${read} \`sleight-mcp ${write}\``, `echo \`sleight-mcp ${write}\``, `sleight-mcp ${read} "\`sleight-mcp ${write}\`"`,
        `sleight-mcp \`echo ${word}\` ${tail}`, `sleight-mcp $(echo ${word}) ${tail}`, `sleight-mcp $'${word}' ${tail}`,
        `zsh -lc "sleight-mcp ${read} \\\`sleight-mcp ${write}\\\`"`, `sleight-mcp ${read}; echo \`date\``, `sleight-mcp ${write.replace(/[a-z]$/, '?')}`,
        `sleight-mcp ${word} ${tail}*`, `sleight-mcp {${word},x} ${tail}`, `sleight-mcp [${word[0]}]${word.slice(1)} ${tail}`, `sleight-mcp ${read} ~`,
        `sleight-mcp ${read} <(true)`, `sleight-mcp ${read} 2>&1`, `(sleight-mcp ${write})`,
        // The command word is a variable, a substitution or a glob (before the launcher, or with no launcher text).
        `B=sleight-mcp; $B ${write}`, `$B ${write}`, `\${B:-sleight-mcp} ${write}`, `$(echo sleight-mcp) ${write}`, `\`echo sleight-mcp\` ${write}`,
        `/x/bin/sleight-mc? ${write}`, `/x/bin/sleight-{mcp,x} ${write}`, `env $B ${write}`, `nohup "$B" ${write}`, `X=1 $B ${write}`,
        `echo ${tail} | $B ${word}`, `sh -c '$B ${write}'`, `eval "sleight-mcp ${write}"`, `eval $B ${write}`,
        // xargs, its options and variants, other producers, redirections and heredocs.
        `echo "${write}" | xargs sleight-mcp`, `printf '${write}' | xargs sleight-mcp`, `echo "${write}" | xargs node /x/lib/launch.mjs`,
        `echo ${write} | timeout 5 xargs sleight-mcp`, `zsh -lc "echo ${write} | xargs sleight-mcp"`, `nice sh -c "echo ${write} | xargs sleight-mcp"`,
        `cat cmds | xargs sleight-mcp`, 'xargs sleight-mcp < cmds', 'xargs -a cmds sleight-mcp', `echo "${read}" | xargs -n 2 sleight-mcp`,
        `echo "'${word}' ${tail}" | xargs sleight-mcp`, `echo "${read}" | xargs sleight-mcp`, `printf '${read}' | xargs node /x/lib/launch.mjs`,
        `xargs sleight-mcp <<< "${write}"`, `xargs sleight-mcp <<EOF\n${write}\nEOF`, 'xargs sleight-mcp 0< cmds', 'xargs sleight-mcp <& 3', 'xargs sleight-mcp <> cmds',
        `sleight-mcp ${word} < cmds`, `echo ${write} | xargs --no-run-if-empty sleight-mcp`, `echo ${write} | xargs --max-args=2 sleight-mcp`,
        `echo ${write} | gxargs sleight-mcp`, `echo ${write} | /usr/bin/xargs sleight-mcp`, `echo ${write} | zargs sleight-mcp`,
        `parallel sleight-mcp ::: "${write}"`, `echo "${write}" | parallel sleight-mcp`, `printf '%s' ${word} | xargs -I{} sleight-mcp {} ${tail}`,
        // The launcher is named but isn't the command word.
        `find . -exec sleight-mcp ${write} \\;`, `caffeinate sleight-mcp ${write}`, `bash /x/run.sh sleight-mcp ${read}`,
        `sleight"-"mcp ${write}`, `sleight-m\\cp ${write}`,
        // Prefix options the guard doesn't know, and env's split string, hide the command word.
        `env -S "sleight-mcp ${write}"`, `env -S"sleight-mcp ${write}"`, `env --split-string="sleight-mcp ${write}"`, `env -S "sleight-mcp ${read}"`,
        `env -iS "sleight-mcp ${write}"`, `timeout --weird 5 sleight-mcp ${write}`, `timeout sleight-mcp ${write}`, `nice --foo sleight-mcp ${read}`,
        `sudo -s sleight-mcp ${write}`, `command -x sleight-mcp ${write}`, `env -S "\$B ${write}"`, `nohup -- -S sleight-mcp ${write}`,
        // A subcommand word without the launcher's name: no expansion or joined quoting, and no interpreter that isn't
        // running the launcher's read form literally.
        `python3 -c "import os; os.system('sleight'+'-mcp ${write}')"`, `node -e "require('child_process').execSync('sleight-'+'mcp ${write}')"`,
        `perl -e 'system("sleight-"."mcp ${write}")'`, `ruby -e 'system("sl" + "eight-mcp ${write}")'`, `swift run.swift ${write}`,
        `osascript -e 'do shell script "sleight-" & "mcp ${write}"'`, `bash -c 'sleight'"-mcp ${write}"`, `zsh -c "cd /x && sleight-mcp ${read}"`,
        `sh -c "sleight-mcp ${read}" extra`, `bash script.sh ${write}`, `echo ${word}"" ${tail}`, `echo ${write.replace(/[a-z]$/, '?')}`,
        `echo {${word},x} ${tail}`, `node /x/lib/launch.mjs ${write}`,
        // A read tool doesn't save a command that can also run something.
        `grep x f | xargs sleight-mcp ${word}`, `grep -l ${word} plugins/sleight/lib/launch.mjs | xargs cat`, `cat plugins/sleight/lib/launch.mjs | bash`,
        `rg --pre sleight-mcp ${word} .`, `git grep -O sleight-mcp ${word}`, `PATH=/tmp/x grep ${word} plugins/sleight/lib/launch.mjs`,
        `grep ${word} plugins/sleight/lib/launch.mjs > /tmp/x`, `find . -name launch.mjs -exec grep ${word} {} \\;`, `grep ${word} $(echo launch.mjs)`,
        `grep ${word} plugins/sleight/lib/launch.mjs; sleight-mcp ${write}`, `(grep ${word} plugins/sleight/lib/launch.mjs)`]) {
        assert.equal(await guard({ tool: 'Bash', command: spelling }, { stat }), true, spelling);
      }
    }
    for (const form of reads[command]) {
      for (const spelling of [`sleight-mcp ${form}`, `env sleight-mcp ${form}`, `sh -c "sleight-mcp ${form}"`, `node /x/lib/launch.mjs ${form}`,
        `node --no-warnings /x/lib/launch.mjs ${form}`, `/x/plugins/sleight/bin/sleight-mcp ${form}`, `zsh -lc "sleight-mcp ${form}"`,
        `sleight-mcp ${form} | head`, `sleight-mcp ${form}; echo done`, `FOO=1 sleight-mcp ${form}`, `sleight-mcp "${form.split(' ')[0]}" ${form.split(' ').slice(1).join(' ')}`,
        `timeout 5 sleight-mcp ${form}`, `timeout -s KILL 5s sleight-mcp ${form}`, `nice -n 5 sleight-mcp ${form}`, `env -u X sleight-mcp ${form}`,
        `stdbuf -oL sleight-mcp ${form}`, `nohup sleight-mcp ${form}`, `bash -c 'node /x/lib/launch.mjs ${form}'`]) {
        assert.equal(await guard({ tool: 'Bash', command: spelling }, { stat }), false, spelling);
      }
    }
  }
  // No subcommand word, or no launcher: the plain rule doesn't apply.
  for (const spelling of ['echo `date`', 'grep -n launch.mjs README.md', 'echo $HOME | xargs ls', 'sleight-mcp --doctor', 'sleight-mcp --doctor 2>&1',
    'sleight-mcp allow list', 'sleight-mcp turbo-state', 'echo hand on', 'ls tests/*cursor*', 'node --test tests/cursor-events.test.mjs 2>&1 | tail -5']) {
    assert.equal(await guard({ tool: 'Bash', command: spelling }, { stat }), false, spelling);
  }
  // Read-only tools may name the launcher beside any subcommand word when nothing in the command can run it.
  for (const spelling of ['grep -n hand plugins/sleight/lib/launch.mjs', "rg 'turbo|cursor' plugins/sleight/lib/launch.mjs",
    'cat plugins/sleight/lib/launch.mjs | grep -n permissions', 'head -50 plugins/sleight/lib/launch.mjs', 'tail -n 5 plugins/sleight/lib/launch.mjs',
    'wc -l plugins/sleight/lib/launch.mjs', 'ls -la plugins/sleight/bin/sleight-mcp && echo cursor', 'file plugins/sleight/bin/sleight-mcp hand',
    'stat plugins/sleight/lib/launch.mjs | grep turbo', 'diff a/launch.mjs b/launch.mjs | grep hand', 'grep -n "cursor(" plugins/sleight/lib/launch.mjs',
    "grep -rn 'hand.*status' plugins/sleight/lib/launch.mjs", 'grep -c "\\$hand" plugins/sleight/lib/launch.mjs', 'grep -n "sleight-mcp hand on" docs/settings.md',
    'git log --oneline -- plugins/sleight/lib/launch.mjs | grep hand', 'git show HEAD:plugins/sleight/lib/launch.mjs | grep -n cursor',
    "git grep -n 'cursor style' -- plugins/sleight/lib/launch.mjs", 'git --no-pager diff -- plugins/sleight/lib/launch.mjs', 'git blame plugins/sleight/lib/launch.mjs | grep turbo',
    'git status --short plugins/sleight/lib/launch.mjs', 'timeout 5 grep hand plugins/sleight/lib/launch.mjs', 'env grep -n permissions plugins/sleight/lib/launch.mjs',
    'echo hand on', 'echo "hand on"']) {
    assert.equal(await guard({ tool: 'Bash', command: spelling }, { stat }), false, spelling);
  }
  for (const spelling of ['git log --format=%s | sh', 'git log --format=%s | bash -s', 'cat notes | python3', 'cat notes | node -',
    'cat f > "$HOME/Library/Application Support/sleight/hand.json"', "cat f > ~/Library/Application\\ Support/sleight/hand.json"]) {
    assert.equal(await guard({ tool: 'Bash', command: spelling }, { stat }), true, spelling);
  }
});
test('the action log and outcome switches are the user\'s: Claude\'s file and shell tools can\'t set them where sleight reads its environment', async () => {
  const { loggingSwitchWriteDenied: denied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  const env = '{ "env": { "SLEIGHT_ACTION_LOG": "actions.jsonl" } }';
  for (const file of ['/project/.claude/settings.json', '/project/.claude/settings.local.json', '~/.claude/settings.json', `${MAC_USERS}fixture/.claude.json`,
    '/project/.mcp.json', '/Library/Application Support/ClaudeCode/managed-settings.json', '~/.zshrc', `${MAC_USERS}fixture/.bash_profile`, '/project/.envrc']) {
    assert.equal(denied({ tool: 'Write', file_path: file, content: env }), true, file);
    assert.equal(denied({ tool: 'Edit', file_path: file, old_string: '{}', new_string: 'export SLEIGHT_OUTCOMES=1' }), true, file);
    assert.equal(denied({ tool: 'Write', file_path: file, content: '{ "env": { "OTHER": "1" } }' }), false, file);
  }
  assert.equal(denied({ tool: 'MultiEdit', file_path: '/project/.claude/settings.json', edits: [{ old_string: 'a', new_string: '"SLEIGHT_OUTCOMES": "1"' }] }), true);
  assert.equal(denied({ tool: 'Write', file_path: '/project/notes.md', content: 'Set SLEIGHT_ACTION_LOG to try the log.' }), false);
  for (const command of ['echo \'{"env":{"SLEIGHT_OUTCOMES":"1"}}\' > .claude/settings.json', 'tee -a ~/.zshrc <<< "export SLEIGHT_ACTION_LOG=a.jsonl"',
    'jq \'.env.SLEIGHT_OUTCOMES="1"\' .claude/settings.json > /tmp/s && mv /tmp/s .claude/settings.json',
    'python3 -c "import json; p=\'.mcp.json\'; d=json.load(open(p)); d[\'env\']={\'SLEIGHT_ACTION_LOG\':\'x\'}; json.dump(d, open(p, \'w\'))"',
    'claude mcp add sleight -e SLEIGHT_ACTION_LOG=a.jsonl -- sleight-mcp', 'launchctl setenv SLEIGHT_OUTCOMES 1',
    "sed -i '' 's/{}/{\"SLEIGHT_OUTCOMES\":\"1\"}/' .claude/settings.local.json"]) {
    assert.equal(denied({ tool: 'Bash', command }), true, command);
  }
  for (const command of ['grep SLEIGHT_ACTION_LOG .claude/settings.json', 'echo $SLEIGHT_OUTCOMES', 'SLEIGHT_OUTCOMES=1 node --test tests/action-outcomes.test.mjs',
    'cat ~/.zshrc']) {
    assert.equal(denied({ tool: 'Bash', command }), false, command);
  }
});

test('the switch hook also catches partial names, escaped and split names, the plugin\'s own config and launcher, and osascript or awk writes', async () => {
  const { loggingSwitchWriteDenied: denied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  // Partial names: the switch's stem is enough in a config file.
  assert.equal(denied({ tool: 'Edit', file_path: '/project/.claude/settings.json', old_string: 'OUTCOMES": "0"', new_string: 'OUTCOMES": "1"' }), true);
  // JSON \u escapes are decoded before matching.
  assert.equal(denied({ tool: 'Write', file_path: '~/.claude/settings.json', content: '{"env":{"SLEIGHT_\\u004fUTC\\u004fMES":"1"}}' }), true);
  // The plugin's own manifest (its MCP server env) and launcher, LaunchAgents and fish.
  for (const file of [`${MAC_USERS}fixture/.claude/plugins/cache/sleight/sleight/1.3.0/.claude-plugin/plugin.json`, '/repo/plugins/sleight/.claude-plugin/plugin.json',
    '/repo/plugins/sleight/bin/sleight-mcp', '~/Library/LaunchAgents/com.example.env.plist', '~/.config/fish/config.fish']) {
    assert.equal(denied({ tool: 'Write', file_path: file, content: 'SLEIGHT_ACTION_LOG=a.jsonl' }), true, file);
    assert.equal(denied({ tool: 'Write', file_path: file, content: 'no switch here' }), false, file);
  }
  for (const command of [
    "sed -i '' 's/OUTCOMES\": \"0\"/OUTCOMES\": \"1\"/' .claude/settings.json",
    "echo 'export SLEIGHT_OUT''COMES=1' >> ~/.zshrc",
    'echo export SLEIGHT_OUT\\COMES=1 >> ~/.zshrc',
    'osascript -e \'do shell script "echo export SLEIGHT_OUTCOMES=1 >> ~/.zshrc"\'',
    `awk \'BEGIN { print "export SLEIGHT_ACTION_LOG=a" >> "${MAC_USERS}fixture/.zshrc" }\'`,
    'perl -pi -e \'s/x/SLEIGHT_ACTION_LOG/\' plugins/sleight/bin/sleight-mcp',
  ]) assert.equal(denied({ tool: 'Bash', command }), true, command);
  for (const command of ['grep OUTCOMES .claude/settings.json', "awk '/ACTION_LOG/' ~/.claude/settings.json", 'git log --grep OUTCOMES',
    'SLEIGHT_OUTCOMES=1 node --test tests/action-outcomes.test.mjs']) {
    assert.equal(denied({ tool: 'Bash', command }), false, command);
  }
  assert.equal(denied({ tool: 'Edit', file_path: '/repo/plugins/sleight/lib/relay.mjs', old_string: 'a', new_string: 'outcomes = OUTCOMES' }), false);
});

test('permissions block, unblock, revoke and sites are the user\'s commands: every spelling but the listing denies', async () => {
  for (const command of ['sleight-mcp permissions block com.example.app', 'sleight-mcp permissions unblock https://example.com',
    'sleight-mcp permissions revoke all', 'sleight-mcp permissions revoke Calculator', 'sleight-mcp permissions sites only https://example.com',
    'sleight-mcp permissions sites all', '/x/plugins/sleight/bin/sleight-mcp permissions unblock com.example.app',
    'node /x/plugins/sleight/lib/launch.mjs permissions unblock com.example.app', 'cd /tmp && sleight-mcp permissions unblock x.y',
    'bash -c "sleight-mcp permissions unblock x.y"', 'env A=1 sleight-mcp permissions revoke all', 'nohup sleight-mcp permissions block x.y',
    'sh -c "true; sleight-mcp permissions unblock x.y"', 'true && sleight-mcp permissions unblock x.y', 'echo hi | sleight-mcp permissions unblock x.y',
    'zsh -lc "cd /x && sleight-mcp permissions unblock x.y"', 'sleight-mcp "permissions" "unblock" x.y',
    'node --no-warnings /x/lib/launch.mjs permissions revoke all', 'sleight-mcp permissions list unblock', 'sleight-mcp permissions repair', 'sleight-mcp permissions repair --discard']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
  for (const command of ['sleight-mcp permissions', 'sleight-mcp permissions list', 'env sleight-mcp permissions', 'sh -c "sleight-mcp permissions"',
    'node /x/lib/launch.mjs permissions list', 'sleight-mcp permissions | head', 'sleight-mcp permissions; echo done', 'sleight-mcp --doctor',
    'echo permissions unblock', 'permissions unblock x.y', 'sleight-mcp allow list']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
});

test('deleting, moving or changing the permissions file by a parent folder, find, perl, chmod or an import of the writers denies', async () => {
  const home = `${MAC_USERS}fixture`;
  for (const command of ['find ~/Library -name permissions.json -delete', 'find "$HOME/Library/Application Support" -exec rm {} +',
    `find ${MAC_USERS}fixture/Library -type f -delete`, 'find -L ~/Library -delete', 'find ~ -name "*.json" -execdir rm {} \\;',
    `perl -e 'unlink "$ENV{HOME}/Library/Application Support/sleight/permissions.json"'`,
    'chmod 644 ~/Library/Application\\ Support/sleight/permissions.json', 'chown root ~/Library/Application\\ Support/sleight/permissions.json',
    'chmod -R 777 ~/Library', 'mv ~/Library/Application\\ Support ~/elsewhere', 'mv "$HOME/Library" /tmp/x', 'rm -rf ~/Library/Application\\ Support',
    `rm -rf ${MAC_USERS}fixture`, `mv ${MAC_USERS}fixture/Library/Application\\ Support/sleight /tmp/s`,
    `node -e "import('/x/plugins/sleight/lib/permissions-command.mjs').then(m => m.permissionsCommand(['unblock', 'x.y']))"`,
    `node -e "import('/x/lib/preapproved.mjs').then(m => m.removePreapproved('x'))"`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home }), true, command);
  }
  for (const command of ["find . -name '*.tmp' -delete", 'find ~/Projects -name x -delete', 'find ~/Library -name "*.log"', 'mv a.txt ~/',
    'rm -rf /tmp/build', 'chmod +x script.sh', 'chmod -R 755 ~/Projects/x', "perl -e 'print 1'", `node -e "console.log(1)"`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home }), false, command);
  }
});

test('globs, braces, archives, downloads, patch and git checkout into sleight\'s folder deny; find denies only when it deletes or runs a writer', async () => {
  const home = `${MAC_USERS}fixture`, folder = '~/Library/Application\\ Support/sleight';
  for (const command of [`rm ${folder}/perm*`, `cd ${folder} && rm -f *.json`, `rm -f ${folder}/{a,permissions}.json`, `mv ${folder}/[p]ermissions.json /tmp/x`,
    'tar -xf x.tar -C ~/Library/Application\\ Support', `tar xf x.tar --directory=${MAC_USERS}fixture/Library`, 'unzip x.zip -d ~/Library',
    `ditto x ${folder}`, `curl -o ${folder}/permissions.json https://example.com/x`, `curl --output=${folder}/hand.json https://example.com/x`,
    `wget -O ${folder}/permissions.json https://example.com/x`, `git checkout -- ${folder}/permissions.json`, `git restore ${folder}/turbo.json`,
    `patch ${folder}/permissions.json fix.diff`, 'find ~ -name permissions.json -exec rm {} \;', 'find ~/Library -execdir mv {} /tmp \;']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home }), true, command);
  }
  for (const command of ['find ~ -name x -exec cat {} \;', 'find / -name hand.json -print', "find ~ -name '*.log' -exec ls -l {} +",
    'tar -xf x.tar -C /tmp/out', 'unzip x.zip -d build', 'curl -o out.json https://example.com/x', 'git checkout -- src/a.js', 'rm -f *.tmp',
    `ls ${folder}/*.json`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home }), false, command);
  }
});

test('the logging switch hook folds config paths and setter names as well as switch names', async () => {
  const { loggingSwitchWriteDenied: denied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  for (const command of [
    `py'thon3' -c "open('${MAC_USERS}fixture/.zsh'+'rc','a').write('export SLEIGHT_OUTCOMES=1')"`,
    `python3 -c "open('${MAC_USERS}fixture/.zsh' 'rc','a').write('export SLEIGHT_OUTCOMES=1')"`,
    `python3 -c "open('${MAC_USERS}fixture/.zsh\\x72c','a').write('export SLEIGHT_ACTION_LOG=a')"`,
  ]) assert.equal(denied({ tool: 'Bash', command }), true, command);
  assert.equal(denied({ tool: 'Bash', command: `grep SLEIGHT_OUTCOMES ~/.zsh'rc'` }), false);
});

test('the logging switch hook checks raw commands when quote folding joins separate arguments', async () => {
  const { loggingSwitchWriteDenied: denied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  for (const command of [
    `env 'A=1' 'python3' -c "open('${MAC_USERS}u/.zshrc','a').write('SLEIGHT_OUTCOMES=1')"`,
    `env 'A=1' 'node' -e "require('fs').appendFileSync('${MAC_USERS}u/.zshrc','SLEIGHT_ACTION_LOG=a')"`,
    `env 'A=1' 'launchctl' 'setenv' SLEIGHT_OUTCOMES 1`,
  ]) assert.equal(denied({ tool: 'Bash', command }), true, command);
  assert.equal(denied({ tool: 'Bash', command: `env 'A=1' 'grep' SLEIGHT_OUTCOMES ~/.zshrc` }), false);
});

test('the logging switch hook folds JS joins without joining quoted shell arguments', async () => {
  const { loggingSwitchWriteDenied: denied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  for (const join of ["'+'", "' + '", '"+"']) {
    const command = `env 'A=1' 'python3' -c "open('${MAC_USERS}u/.zs${join}hrc','a').write('SLEIGHT_OUTCOMES=1')"`;
    assert.equal(denied({ tool: 'Bash', command }), true, command);
  }
  assert.equal(denied({ tool: 'Bash', command: `env 'A=1' 'grep' SLEIGHT_OUTCOMES '${MAC_USERS}u/.zs'+'hrc'` }), false);
});

test('the logging switch hook catches Python and Ruby adjacent literals beside separate quoted shell arguments', async () => {
  const { loggingSwitchWriteDenied: denied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  for (const command of [
    `env 'A=1' 'python3' -c "open('${MAC_USERS}u/.zs' 'hrc','a').write('SLEIGHT_OUTCOMES=1')"`,
    `env 'A=1' 'ruby' -e "File.write('${MAC_USERS}u/.zs' 'hrc','SLEIGHT_OUTCOMES=1',mode:'a')"`,
    `env 'A=1' 'python3' -c "open('${MAC_USERS}u/.zs' 'hrc','a').write('SLEIGHT_OUT' 'COMES=1')"`,
  ]) assert.equal(denied({ tool: 'Bash', command }), true, command);
  assert.equal(denied({ tool: 'Bash', command: `env 'A=1' 'grep' SLEIGHT_OUTCOMES '${MAC_USERS}u/.zs' 'hrc'` }), false);
});

// VC10 security review (2026-10-26): sleight's helper cache (the consent host that answers its cards and Touch ID
// confirmation) and installed copies of the plugin are sleight's own code, so Claude's tools can't swap them. A working
// checkout of the source stays editable.
test('the helper cache and installed plugin copies deny every mutation; a source checkout and lookalikes pass', async () => {
  const helper = `${MAC_USERS}fixture/Library/Caches/sleight/turbo-host/0123abcd/consent-host`;
  const installed = [`${MAC_USERS}fixture/.claude/plugins/cache/sleight/sleight/1.5.0/lib/launch.mjs`,
    `${MAC_USERS}fixture/.codex/plugins/cache/land-o-clusters/sleight/abc123/lib/person-confirm.mjs`,
    `${MAC_USERS}fixture/.cursor/plugins/cache/market/sleight/hooks/preapproved-write-guard.mjs`];
  for (const path of [helper, helper.toUpperCase(), '~/Library/Caches/sleight/turbo-host/k/consent-host', ...installed]) {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(await guard({ tool, file_path: path, notebook_path: path }, { stat }), true, `${tool} ${path}`);
  }
  for (const command of [`cp /tmp/evil ${helper}`, `printf x > ${installed[0]}`, 'rm -rf ~/Library/Caches/sleight', 'rm -rf ~/Library/Caches',
    `ln -sf /tmp/evil ${helper}`, `python3 -c "open('${helper}', 'wb').write(b'x')"`, `node -e "require('fs').writeFileSync('${installed[1]}', 'x')"`,
    `sed -i '' 's/a/b/' ${installed[2]}`, `mv ${MAC_USERS}fixture/Library/Caches/sleight /tmp/old`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home: `${MAC_USERS}fixture` }), true, command);
  }
  for (const path of [`${MAC_USERS}fixture/Projects/sleight/plugins/sleight/lib/launch.mjs`, `${MAC_USERS}fixture/Library/Caches/sleight-other/x`,
    `${MAC_USERS}fixture/.claude/plugins/cache/other/other-plugin/x.mjs`, `${MAC_USERS}fixture/Library/Caches/com.example/sleight.txt`]) {
    assert.equal(await guard({ tool: 'Write', file_path: path }, { stat }), false, path);
  }
  // The benchmark's own caches and lookalike names pass, inline code included (Sonnet review finding 5).
  const bench = `${MAC_USERS}fixture/Library/Caches/sleight-bench/claude-config/plugins/cache/mkt/sleight/lib/launch.mjs`;
  for (const path of [bench, `${MAC_USERS}fixture/Library/Caches/sleight-bench/a.json`, '~/Library/Caches/sleight-bench/claude-config/plugins/cache/m/sleight/x']) {
    for (const tool of ['Write', 'Edit']) assert.equal(await guard({ tool, file_path: path }, { stat, home: `${MAC_USERS}fixture` }), false, `${tool} ${path}`);
  }
  // Re-review D: the exemption is anchored to the home folder's Library/Caches, so a sleight-bench folder made inside a
  // protected tree, or elsewhere, doesn't open it.
  for (const path of [`${MAC_USERS}fixture/Library/Caches/sleight/Library/Caches/sleight-bench/x`,
    `${MAC_USERS}fixture/.claude/plugins/cache/m/sleight/Library/Caches/sleight-bench/x`, `/tmp/Library/Caches/sleight-bench/plugins/cache/m/sleight/x`]) {
    assert.equal(await guard({ tool: 'Write', file_path: path }, { stat, home: `${MAC_USERS}fixture` }), true, path);
  }
  for (const command of [`python3 -c "open('${MAC_USERS}x/Library/Caches/sleight-bench/a.json','w').write('x')"`,
    `node -e "require('fs').writeFileSync('~/Library/Caches/sleight-bench/a.json','x')"`,
    `node -e "require('fs').writeFileSync('${MAC_USERS}x/.claude/plugins/cache/mk/sleight-other/x','x')"`,
    `python3 -c "open('${bench}','w').write('x')"`, `cp a ${bench}`, 'rm -rf ~/Library/Caches/sleight-bench/claude-config',
    `rm -rf ${MAC_USERS}fixture/Library/Caches/sleight-bench/claude-config/plugins/cache`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home: `${MAC_USERS}fixture`, configDir: `${MAC_USERS}fixture/Library/Caches/sleight-bench/claude-config` }), false, command);
  }
  for (const command of [`cat ${helper}`, `ls ~/Library/Caches/sleight/turbo-host`, `shasum -a 256 ${installed[0]}`, 'rm -rf ~/Library/Caches/com.example']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat, home: `${MAC_USERS}fixture` }), false, command);
  }
});

test('a link into the helper cache is followed for Write and Edit', async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-guard-cache-'))));
  const cache = join(root, 'Library/Caches/sleight/turbo-host');
  mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, 'consent-host'), 'x');
  symlinkSync(cache, join(root, 'innocent'));
  const { lstat, realpath } = await import('node:fs/promises');
  const real = async path => { await lstat(path); return { realPath: await realpath(path) }; };
  assert.equal(await guard({ tool: 'Write', file_path: join(root, 'innocent/consent-host') }, { stat: real }), true);
});

// VC10 review: the folders above the installed copies, so removing or moving a plugin cache can't take sleight with it.
test('the folders above installed plugin copies deny removal and moves; other marketplaces and plugins pass', async () => {
  const home = `${MAC_USERS}fixture`, configDir = '/tmp/lane-claude-abc123';
  const installs = new Set([`${home}/.claude/plugins/cache/sleight/sleight`, `${home}/.codex/plugins/cache/land-o-clusters/sleight`,
    `${configDir}/plugins/cache`, `${configDir}/plugins/cache/market/sleight`]);
  const fsStat = async path => installs.has(path) ? { realPath: path } : undefined;
  const options = { stat: fsStat, home, configDir };
  for (const command of ['rm -rf ~/.claude/plugins/cache', 'rm -rf ~/.claude/plugins', 'rm -rf ~/.claude', 'rm -rf ~/.codex/plugins/cache',
    'rm -rf ~/.cursor/plugins', 'rm -rf ~/.claude/plugins/cache/sleight', 'rm -rf ~/.codex/plugins/cache/land-o-clusters',
    'mv ~/.claude/plugins/cache /tmp/old', 'rm -rf "$HOME/.claude/plugins/cache"', 'rm -rf ~/.claude/plugins/cache/*',
    `rm -rf ${configDir}/plugins/cache`, `rm -rf ${configDir}`, 'rm -rf $CLAUDE_CONFIG_DIR/plugins', `rm -rf ${configDir}/plugins/cache/market`,
    `find ${home}/.claude/plugins -delete`, `chmod -R 000 ${home}/.claude/plugins/cache`]) {
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
  }
  for (const command of ['rm -rf ~/.claude/plugins/cache/claude-plugins-official', 'rm -rf ~/.claude/plugins/cache/temp_git_1/x',
    'rm -rf ~/.claude/projects/old', 'rm -rf /tmp/lane-claude-other', `rm -rf ${configDir}/projects`, `rm -rf ${configDir}/plugins/cache/other`,
    'rm ~/.claude/plugins/cache/notes.txt']) {
    assert.equal(await guard({ tool: 'Bash', command }, options), false, command);
  }
  // A config folder without a plugin cache is an ordinary folder.
  assert.equal(await guard({ tool: 'Bash', command: 'rm -rf /tmp/lane-claude-empty' }, { ...options, configDir: '/tmp/lane-claude-empty' }), false);
});

// Re-review B: a link to a custom CLAUDE_CONFIG_DIR resolves to it, and the folders above its installed copy still count.
test('a link to a custom config folder can\'t take its installed copy with it', async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-guard-config-'))));
  const configDir = join(root, 'custom-config');
  mkdirSync(join(configDir, 'plugins/cache/mk/sleight'), { recursive: true });
  symlinkSync(configDir, join(root, 'link'));
  const { lstat, realpath } = await import('node:fs/promises');
  const real = async path => { await lstat(path); return { realPath: await realpath(path) }; };
  const options = { stat: real, home: join(root, 'home'), configDir };
  for (const command of [`rm -rf ${configDir}/plugins/cache`, `rm -rf ${join(root, 'link')}/plugins/cache`, `rm -rf ${join(root, 'link')}`,
    `rm -rf ${join(root, 'link')}/plugins/cache/mk`]) {
    assert.equal(await guard({ tool: 'Bash', command }, options), true, command);
  }
  assert.equal(await guard({ tool: 'Bash', command: `rm -rf ${join(root, 'link')}/projects` }, options), false);
});

test('the refusal names the protected folder the call reached', async () => {
  const { preapprovedWriteTarget, preapprovedWriteReason, PROTECTED } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  const options = { stat, home: `${MAC_USERS}fixture` };
  const cases = [
    [{ tool: 'Write', file_path: '~/Library/Application Support/sleight/permissions.json' }, PROTECTED.settings],
    [{ tool: 'Edit', file_path: '~/Library/Caches/sleight/turbo-host/k/consent-host' }, PROTECTED.cache],
    [{ tool: 'Write', file_path: '~/.claude/plugins/cache/m/sleight/lib/launch.mjs' }, PROTECTED.install],
    [{ tool: 'Bash', command: 'rm -rf ~/Library' }, PROTECTED.aboveSleight],
    [{ tool: 'Bash', command: 'rm -rf ~/.claude/plugins/cache' }, PROTECTED.aboveInstall],
    [{ tool: 'Write', file_path: '/project/notes.md' }, undefined],
  ];
  for (const [input, label] of cases) assert.equal(await preapprovedWriteTarget(input, options), label, JSON.stringify(input));
  assert.equal(preapprovedWriteReason(PROTECTED.cache), "Only the user changes sleight's helper cache (~/Library/Caches/sleight). Ask them to make this change.");
  const register = readFileSync(new URL('../plugins/sleight/hooks/register.tsx', import.meta.url), 'utf8');
  assert.match(register, /return denied \? \{ deny: preapprovedWriteReason\(denied\) \} : next\(e\)/);
});
