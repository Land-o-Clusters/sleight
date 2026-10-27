import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preapprovedWriteTarget, PROTECTED } from '../plugins/sleight/hooks/preapproved-write-guard.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
// A synthetic macOS home for validation, never a filesystem allocation root.
const home = ['', 'Users', 'fixture'].join('/');
const options = { home, stat: async path => ({ realPath: path }) };
const target = command => preapprovedWriteTarget({ tool: 'Bash', command }, options);
for (const file of ['sleight', '.sleight-shim-v1']) {
  const path = `${home}/.local/bin/${file}`;
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) test(`${tool} protects ${file}`, async () => {
    for (const spelling of [path, path.toUpperCase(), `~/.local/bin/${file}`, `${home}/.local/bin/../bin/${file}`]) {
      assert.ok(await preapprovedWriteTarget({ tool, file_path: spelling, notebook_path: spelling }, options), spelling);
    }
  });
  for (const command of [`printf x > ${path}`, `tee ${path}`, `cp /tmp/evil ${path}`, `mv /tmp/evil ${path}`,
    `mv ${path} /tmp/old`, `ln -sf /tmp/evil ${path}`, `rm ${path}`, `chmod 777 ${path}`,
    `cd ~/.local/bin && tee ${file}`, `node -e "require('fs').writeFileSync('${path}', 'x')"`]) {
    test(`write guard refuses ${command}`, async () => assert.ok(await target(command)));
  }
}
for (const command of ['rm -rf ~/.local/bin', 'mv ~/.local /tmp/old', 'ln -sf /tmp/evil ~/.local/bin',
  'cp /tmp/evil ~/.local/bin', 'ln ~/.local/bin/.sleight-shim-v1 /tmp/alias', 'ln -s ~/.local/bin /tmp/bin-alias',
  'touch ~/Library/Application\\ Support/sleight/menu-presence.lock',
  'tee ~/Library/Application\\ Support/sleight/settings-link.json',
  'B=~/.local/bin; printf x > "$B/sleight"', 'B=~/.local/bin; tee "$B/sleight"']) {
  test(`write guard protects ancestor or authority: ${command}`, async () => assert.ok(await target(command)));
}
test('write guard resolves file and folder aliases to the shim', async t => {
  const root = registerTemp(t, trackTemp(fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-sm1r-guard-')))));
  fs.mkdirSync(join(root, '.local/bin'), { recursive: true });
  fs.writeFileSync(join(root, '.local/bin/.sleight-shim-v1'), 'fixture');
  fs.symlinkSync(join(root, '.local/bin/.sleight-shim-v1'), join(root, 'alias'));
  fs.symlinkSync(join(root, '.local/bin'), join(root, 'folder'));
  const opts = { home: root, stat: async path => ({ realPath: fs.realpathSync(path) }) };
  for (const path of [join(root, 'alias'), join(root, 'folder/.sleight-shim-v1')]) {
    assert.ok(await preapprovedWriteTarget({ tool: 'Write', file_path: path }, opts));
    assert.ok(await preapprovedWriteTarget({ tool: 'Bash', command: `tee '${path}'` }, opts));
  }
});
for (const name of ['.sleight-shim-v1', '~/.local/bin/.sleight-shim-v1', '/x/.sleight-shim-v1']) {
  for (const command of [`${name} hand on`, `exec -a x ${name} menu`, `cp ${name} /tmp/s; /tmp/s hand off`,
    `ln -s ${name} /tmp/zz && /tmp/zz link`, `cd ~/.local/bin && ./${name.split('/').at(-1)} hand on`]) {
    test(`shim launch refuses ${command}`, async () => assert.equal(await target(command), PROTECTED.launcher));
  }
}
for (const command of ['git commit -m "sleight: add link command"', 'git commit -m "document sleight menu and link"',
  'cd ~/Projects/sleight && git commit -m "add menu"', 'cd ~/Projects/sleight && npm test -- menu',
  'cd ~/Projects/sleight && node --test tests/x.mjs --test-name-pattern=link',
  'mkdir -p ~/Projects/sleight/docs/menu', 'cp ~/Projects/sleight/a.md /tmp/menu',
  'gh pr create --title "menu" --body "sleight"', 'echo "see sleight docs for link"',
  'echo sleight menu', 'printf "%s" sleight', 'git -C ~/Projects/sleight status',
  'sh -c \'git commit -m "document sleight menu and link"\'', 'sh -c \'echo "sleight menu"\'']) {
  test(`ordinary data allows ${command}`, async () => assert.equal(await target(command), undefined));
}
for (const command of ['sleight menu', 'exec sleight link', 'command sleight unlink', 'env sleight hand on',
  'nohup sleight hand off', 'sudo sleight menu', 'xargs sleight menu', 'time sleight link',
  'sh -c "sleight menu"', 'python3 -c "import os; os.system(\'sleight menu\')"']) {
  test(`command position refuses ${command}`, async () => assert.equal(await target(command), PROTECTED.launcher));
}
for (const command of ['ln -s ~/.local/bin/sleight /tmp/zz && /tmp/zz hand off',
  'cp ~/.local/bin/sleight /tmp/s; /tmp/s hand off']) {
  test(`managed short-path alias refuses ${command}`, async () => assert.equal(await target(command), PROTECTED.launcher));
}
// Both launcher names use the same command-position check, including opaque wrappers. Never execute these strings.
for (const form of [
  'if true; then CMD menu; fi', 'while true; do CMD hand on; done',
  'for x in 1; do CMD menu; done', 'if false; then true; else CMD link; fi',
  'true && CMD menu', 'false || CMD menu', 'true; CMD menu', 'printf x | CMD menu',
  'watch CMD menu', 'watch -n 2 CMD menu', 'watch "CMD menu"',
  'script -q /dev/null CMD menu', 'script -q -c "CMD menu" /dev/null',
  'setsid sh -c "CMD menu"',
  'setsid CMD menu', 'arch -arm64 CMD menu', 'doas CMD menu',
  'tmux new-session -d CMD menu', 'screen -dm CMD menu',
]) {
  for (const name of ['sleight', 'sleight-mcp']) {
    const command = form.replace('CMD', name);
    test(`shared launcher position refuses ${command}`, async () => assert.equal(await target(command), PROTECTED.launcher));
  }
}
