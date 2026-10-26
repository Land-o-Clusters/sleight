// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

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
