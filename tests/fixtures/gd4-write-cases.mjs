// Pure command strings. No fixture command is executed.
import { protectedTargets } from './gd3-write-cases.mjs';
const quote = value => JSON.stringify(value);
export const sedForms = ["-I ''", '-I .bak', '-I.bak', "-nI ''", '-nI .bak', '-nI.bak', "-EI ''", '-EI .bak', '-EI.bak', "-EnI ''", '-EnI.bak', "-I '' -nE", "-nE -I ''"];
export const wrappers = [
  'nice', 'nice -n 5', 'nice -n5', 'nice --adjustment=5', 'nice -5',
  'timeout 5', 'timeout -k 1 5', 'timeout --signal=TERM 5s',
  'stdbuf -oL', 'stdbuf --output=L', 'caffeinate', 'caffeinate -i -t 5',
  'exec', 'exec -a writer', 'busybox', 'env', 'env -i A=1', 'env -u NAME',
  'command', 'command -p', 'builtin', 'sudo', 'sudo -n -u root', 'doas', 'doas -n -u root',
  'xargs', 'xargs -n 1', 'xargs -I{}', 'nice -n 5 timeout 5 env A=1 command',
];
const writers = [p => `tee -a ${p}`, p => `sed -I '' 's/a/b/' ${p}`, p => `cp src ${p}`,
  p => `install src ${p} -m 600`, p => `sort -o ${p} input`, p => `uniq input ${p}`];
const options = [
  p => `cp src ${p} -S .bak`, p => `mv src ${p} -S .bak`, p => `cp src ${p} --suffix .bak`,
  p => `install src ${p} -m 600`, p => `install src ${p} --mode 600`, p => `install src ${p} --mode=600`,
  p => `install -D src ${p} -m600 -o root -g wheel`, p => `cp -- src ${p}`,
  p => `wget --output-d=${p} https://example.invalid/file`, p => `wget --output-d ${p} https://example.invalid/file`,
  p => `wget -o ${p} https://example.invalid/file`, p => `curl -O ${p} https://example.invalid/file`,
  p => `curl --outp ${p} https://example.invalid/file`, p => `curl --outp=${p} https://example.invalid/file`,
];
const directories = [
  d => `cp -t ${d} hand.json`, d => `cp -vt ${d} hand.json`, d => `cp -at ${d} hand.json`, d => `cp -t${d} hand.json`,
  d => `install -Dt ${d} hand.json`, d => `install -Dt${d} hand.json`, d => `install hand.json -Dt ${d} -m 600`,
  d => `cp hand.json -vt ${d}`, d => `ln -t ${d} hand.json`,
  d => `tar --extr -C ${d} -f archive`, d => `tar --ext --directory=${d} -f archive`, d => `tar -xf archive --dir=${d}`,
  d => `tar -xf archive -C${d}`, d => `wget --directory-prefix ${d} https://example.invalid/hand.json`,
  d => `wget -P ${d} https://example.invalid/hand.json`, d => `wget -P${d} https://example.invalid/hand.json`,
  d => `curl --output-dir ${d} -O https://example.invalid/hand.json`,
  d => `curl --output-d=${d} -O https://example.invalid/hand.json`,
];
export const directoryTargets = ['~/Library/Application Support/sleight', '~/Library/Caches/sleight',
  '~/.claude/plugins/cache/local/sleight/1', '~/.local/bin'];
export const cases = [
  ...protectedTargets.flatMap(path => sedForms.map(flags => ({ group: 'sed -I', command: `sed ${flags} 's/a/b/' ${quote(path)}` }))),
  ...protectedTargets.flatMap(path => wrappers.flatMap(prefix => writers.map(writer => ({ group: 'wrapped writers', command: `${prefix} ${writer(quote(path))}` })))),
  ...protectedTargets.flatMap(path => options.map(form => ({ group: 'writer options', command: form(quote(path)) }))),
  ...directoryTargets.flatMap(path => directories.map(form => ({ group: 'target directories', command: form(quote(path)) }))),
  ...protectedTargets.flatMap(path => ['cd', 'pushd', 'builtin cd', 'builtin pushd'].flatMap(cd => {
    const slash = path.lastIndexOf('/'), directory = quote(path.slice(0, slash)), file = quote(path.slice(slash + 1));
    return [';', '&&'].flatMap(separator => [
      { group: 'directory tracking', command: `${cd} ${directory} ${separator} echo x > ${file}` },
      { group: 'directory tracking', command: `${cd} ${directory} ${separator} bash -c 'nice tee ${file}'` },
    ]);
  })),
  ...protectedTargets.flatMap(path => sedForms.map(flags => ({ group: 'sed file first', command: `sed ${quote(path)} ${flags} 's/a/b/'` }))),
  ...protectedTargets.map(path => ({ group: 'nested wrapper', command: `bash -c 'nice -n 5 tee ${quote(path)}'` })),
];
export const switchCases = [
  ...sedForms.map(flags => `sed ~/.zshrc ${flags} 's/^/export SLEIGHT_OUTCOMES=1/'`),
  ...sedForms.map(flags => `sed ${flags} 's/^/export SLEIGHT_OUTCOMES=1/' ~/.zshrc`),
  ...wrappers.map(prefix => `${prefix} tee -a ~/.zshrc # SLEIGHT_ACTION_LOG=1`),
  'cd ~ && echo SLEIGHT_OUTCOMES=1 > .zshrc', 'pushd ~ && echo SLEIGHT_ACTION_LOG=1 > .zshrc',
];
export const allows = [
  'sleight-mcp --doctor', 'sleight-mcp hand status', 'sleight-mcp turbo status', 'sleight-mcp permissions list',
  'sleight-mcp --doctor | grep -E "hand|link"', 'node /fixture/lib/launch.mjs --doctor | head -20',
  'echo "$(date) hand the link to the menu and cursor" >> docs/notes.md',
  'printf "%s\\n" "$(date) turbo permissions hand" >> docs/run.log',
  'grep -E "hand|turbo|permissions|menu|cursor|link" file | head -2',
  'echo "$(date) hand"', 'echo sleight "!!! x"',
  ...sedForms.map(flags => `sed ${flags} 's/hand/link/' /tmp/ordinary-output`),
  ...wrappers.flatMap(prefix => writers.map(writer => `${prefix} ${writer('/tmp/ordinary-output')}`)),
  ...options.map(form => form('/tmp/ordinary-output')),
  ...directories.map(form => form('/tmp/ordinary-output')),
  'cd /tmp && echo x > hand.json', 'pushd /tmp && echo x > hand.json',
  'cp "~/Library/Application Support/sleight/hand.json" /tmp/ordinary-output -S .bak',
  "python3 -c 'print(\"rmtree\"); p=\"/tmp/hand.json\"'",
];
export const timingShapes = [
  { name: 'launcher punctuation', platform: 'darwin', make: n => 'echo sleight "' + '!'.repeat(n - 17) + ' x"', refused: n => n > 65536 },
  ...['~', '/a', './'].map(unit => ({ name: `inline ${unit}`, platform: 'darwin',
    make: n => "python3 -c 'rmtree " + unit.repeat(Math.ceil((n - 20) / unit.length)).slice(0, n - 20) + "'", refused: n => n > 65536 })),
  { name: 'Windows percent', platform: 'win32', make: n => 'echo %a:' + '='.repeat(n - 8), refused: () => false },
];
