// Validation data only. No candidate shell command is executed.
export const protectedTargets = [
  ...['preapproved.json', 'turbo.json', 'turbo-apps.json', 'turbo-owner.json', 'electron-grants.json', 'grant-seal.key',
    'hand.json', 'permissions.json', 'menu-presence.lock', 'menu-session.lock', 'settings-link.json']
    .map(file => `~/Library/Application Support/sleight/${file}`),
  '~/Library/Caches/sleight/host', '~/.claude/plugins/cache/local/sleight/1/hooks.mjs', '~/.local/bin/sleight',
];
export const writeForms = [
  ...Array.from({ length: '--in-place'.length - 2 }, (_, i) => '--in-place'.slice(0, i + 3))
    .flatMap(option => [p => `sed ${option} 's/a/b/' ${p}`, p => `sed ${option}=.bak 's/a/b/' ${p}`]),
  p => `sed -i.bak 's/a/b/' ${p}`, p => `sed -i '' 's/a/b/' ${p}`, p => `sed -ni '' 's/a/b/' ${p}`,
  ...Array.from({ length: '--output'.length - 2 }, (_, i) => '--output'.slice(0, i + 3))
    .flatMap(option => [p => `sort ${option}=${p} input`, p => `sort ${option} ${p} input`]),
  p => `sort -o${p} input`, p => `sort -o ${p} input`,
  p => `uniq input ${p}`, p => `uniq -f 1 input ${p}`, p => `uniq --skip-f 1 input ${p}`,
  p => `uniq --skip-c 1 input ${p}`, p => `uniq --check-c 1 input ${p}`,
  p => `uniq --skip-fields=1 input ${p}`, p => `uniq -- input ${p}`,
  p => `tee -a ${p}`, p => `install -m 600 source ${p}`, p => `cp source ${p}`,
  p => `mv source ${p}`, p => `ln source ${p}`, p => `dd if=/dev/null of=${p}`,
  p => `truncate -s 0 ${p}`, p => `touch ${p}`,
];
export const writeCases = protectedTargets.flatMap(path => writeForms.map(form => form(JSON.stringify(path))));
