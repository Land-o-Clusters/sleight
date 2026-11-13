const directorySuffix = '/library/application support/sleight';
// grant-seal.key seals the Electron Always records in electron-grants.json; writing it would forge consent. hand.json is the
// user's ghost hand opt-out. permissions.json holds the apps and sites the user told sleight never to act in. turbo-owner.json
// names the copy that issued turbo.json's receipt, which decides whether a startup may move it.
// Keep the sealed names and scheduled folders in sync with sealed-settings.mjs (tested by sa1d-security).
const settingsNames = ['preapproved.json', 'preapproved.json.lock', 'preapproved.json.lock.reclaim', 'turbo.json', 'turbo-apps.json', 'turbo-owner.json', 'electron-grants.json', 'grant-seal.key', 'hand.json', 'permissions.json', 'menu-presence.lock', 'menu-session.lock', 'settings-link.json', 'routine-launcher.mjs'];
const scheduledFolders = ['routines', 'watches'];
const suffixes = settingsNames.map(filename => `${directorySuffix}/${filename}`);
const settingsChild = name => settingsNames.includes(name) || scheduledFolders.some(folder => name === folder || name.startsWith(folder + '/'));
const shimSuffixes = ['/.local/bin/sleight', '/.local/bin/.sleight-shim-v1'];
const inlineSuffixes = [...suffixes, ...shimSuffixes].map(suffix => ({
  pattern: new RegExp(suffix.replaceAll('.', '\\.'), 'i'), length: suffix.length,
}));
const mutations = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const guardUnavailableReason = /* notice */ 'sleight guard unavailable. The tool call was refused.';
export const guardPathReason = /* notice */ 'sleight cannot resolve this protected path. Its directory or filesystem metadata is unknown.';
// Claude Code's mod sandbox has no Node globals. The mod supplies the host platform explicitly.
const runtimePlatform = typeof process === 'undefined' ? undefined : process.platform;
const folded = path => path.normalize('NFC').toLowerCase();
// Everything under these folders is sleight's own code: the helper cache (the consent host that answers sleight's cards and
// its Touch ID confirmation, built from source) and installed copies of the plugin in Claude Code's, Codex's and Cursor's
// plugin caches (<host>/plugins/cache/<marketplace>/sleight). Swapping either would change the checks themselves. A plugin
// loaded from a working checkout is left alone, so its source stays editable. So is a real folder under
// ~/Library/Caches/sleight-bench (the benchmark's throwaway configs), once its path resolves there (benchExempt). The arm
// links its plugins folder to the real cache, so a plugins folder under sleight-bench never counts as the bench's own; the
// arm loads sleight with --plugin-dir, so nothing there needs writing.
const TREES = [/\/library\/caches\/sleight(?:\/|$)/, /\/plugins\/cache\/[^/]+\/sleight(?:\/|$)/];
const ENGINE_TREE = /\/plugins\/cache\/openai-bundled(?:\/|$)/;
// Account-based Windows helper root, including hashed builds and person-run-* copies. Environment spellings are hints
// in command text only; this never reads an environment variable to select authority.
const windowsCachePath = path => folded(normalize(path.replace(/\\/g, '/')));
const WINDOWS_CACHE = /(?:\/appdata\/local|^%localappdata%|^\$\{?(?:env:)?localappdata\}?)\/sleight\/turbo-host(?:\/|$)/;
const WINDOWS_SETTINGS = /(?:\/appdata\/local|^%localappdata%|^\$\{?(?:env:)?localappdata\}?)\/sleight(?:\/(.*))?$/;
// What each refusal names, so the person knows which protected folder the command reached.
export const PROTECTED = Object.freeze({
  unresolved: 'unresolved path',
  unknownDirectory: 'unknown directory before a write to a protected name',
  oversized: 'oversized protected command',
  settings: "sleight's settings files (~/Library/Application Support/sleight)",
  cache: "sleight's helper cache (~/Library/Caches/sleight)",
  windowsCache: "sleight's helper cache (%LOCALAPPDATA%/sleight/turbo-host)",
  windowsSettings: "sleight's settings files (%LOCALAPPDATA%/sleight)",
  engine: 'the bundled computer-use engine folder (plugins/cache/openai-bundled)',
  install: 'an installed copy of the sleight plugin',
  aboveSleight: "a folder that holds sleight's settings or helper cache",
  aboveInstall: 'a folder that holds an installed copy of sleight',
  launcher: "sleight's settings through its launcher",
  replay: 'the replay tool',
  shim: /* notice */ "sleight's managed PATH command (~/.local/bin/sleight)",
});
const protectedLiteral = (path, { platform = runtimePlatform } = {}) => {
  if (platform === 'win32' && WINDOWS_CACHE.test(windowsCachePath(path))) return PROTECTED.windowsCache;
  if (platform === 'win32') {
    const match = WINDOWS_SETTINGS.exec(windowsCachePath(path));
    if (match && (!match[1] || settingsChild(match[1]))) return PROTECTED.windowsSettings;
  }
  const value = folded(normalize(platform === 'win32' ? path.replace(/\\/g, '/') : path));
  if (suffixes.some(suffix => value.endsWith(suffix)) || value.endsWith(directorySuffix)) return PROTECTED.settings;
  if (scheduledFolders.some(folder => value.includes(`${directorySuffix}/${folder}/`) || value.endsWith(`${directorySuffix}/${folder}`))) return PROTECTED.settings;
  if (shimSuffixes.some(suffix => value.endsWith(suffix))) return PROTECTED.shim;
  if (ENGINE_TREE.test(value)) return PROTECTED.engine;
  return TREES[0].test(value) ? PROTECTED.cache : TREES[1].test(value) ? PROTECTED.install : undefined;
};
// Literally under <home>/Library/Caches/sleight-bench, before any link is resolved.
const underBench = (path, home) => {
  if (typeof path !== 'string' || !home) return false;
  const value = folded(normalize(path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home))), folder = folded(normalize(`${home}/Library/Caches/sleight-bench`));
  return value === folder || value.startsWith(folder + '/');
};
/** Whether path is the bench's own: under <home>/Library/Caches/sleight-bench with no plugins folder in between, and still
 *  there after every existing component is resolved by stat (a missing one can't be a link). Without a home folder or a
 *  stat, or when resolving fails, it isn't. Inline code's paths get the same test, so a write through the arm's linked
 *  plugins folder counts as the real cache. */
async function benchExempt(path, { stat, home } = {}) {
  if (typeof path !== 'string' || !home || typeof stat !== 'function') return false;
  const expanded = normalize(path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home));
  const root = normalize(`${home}/Library/Caches/sleight-bench`), value = folded(expanded), folder = folded(root);
  if (value !== folder && !value.startsWith(folder + '/')) return false;
  if (value.slice(folder.length).split('/').includes('plugins')) return false;
  const resolve = async target => {
    let resolved = '/';
    for (const part of target.split('/').filter(Boolean)) {
      const next = `${resolved.replace(/\/$/, '')}/${part}`;
      let info;
      try { info = await stat(next); } catch {}
      if (info && typeof info.realPath !== 'string') return undefined;
      resolved = info?.realPath ?? normalize(next);
    }
    return folded(resolved);
  };
  try {
    const [real, realRoot] = [await resolve(expanded), await resolve(root)];
    return !!real && !!realRoot && (real === realRoot || real.startsWith(realRoot + '/'));
  } catch { return false; }
}
const normalize = path => {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
};

// True when the path is sleight's settings folder or helper cache, or a folder above one, so deleting, moving or changing it
// reaches the protected files.
// Without the home folder, only ~ spellings can be judged.
const above = (path, home, platform) => {
  const windows = platform === 'win32' ? windowsCachePath(path) : '', windowsRoot = home && windowsCachePath(`${home}/AppData/Local/sleight/turbo-host`);
  if (/^(?:%localappdata%|\$\{?localappdata\}?|\$env:localappdata)(?:\/sleight)?$/.test(windows)) return PROTECTED.aboveSleight;
  if (windowsRoot && /^[a-z]:\//.test(windows) && (windows === windowsRoot || windowsRoot.startsWith(windows.endsWith('/') ? windows : windows + '/'))) return PROTECTED.aboveSleight;
  const root = home ?? '/~', value = folded(normalize(path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => root)));
  if (value.startsWith('/') && shimSuffixes.map(suffix => folded(normalize(root + suffix)))
    .some(file => file.startsWith(value === '/' ? '/' : value + '/'))) return PROTECTED.shim;
  return value.startsWith('/') && [`${root}/Library/Application Support/sleight`, `${root}/Library/Caches/sleight`].map(path => folded(normalize(path)))
    .some(folder => value === folder || folder.startsWith(value === '/' ? '/' : value + '/')) ? PROTECTED.aboveSleight : undefined;
};

// The folders above the installed plugin copies (TREES): a host folder, its plugins and plugins/cache folders, and a
// marketplace folder. Removing or moving any of them takes sleight with it. Hosts are ~/.claude, ~/.codex, ~/.cursor and
// the session's CLAUDE_CONFIG_DIR. The upper levels of the home hosts count always; a CLAUDE_CONFIG_DIR's count when it
// has a plugin cache, and a marketplace folder counts when it has a sleight child (by stat), or is named sleight.
const HOSTS = ['.claude', '.codex', '.cursor'];
async function aboveInstall(path, { stat, home, configDir } = {}) {
  if (typeof path !== 'string' || !path || path.length > 4096) return false;
  const expanded = normalize(path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home ?? '/~')
    .replace(/^(?:\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\})(?=\/|$)/, () => configDir ?? '/$CLAUDE_CONFIG_DIR'));
  const value = folded(expanded);
  if (!value.startsWith('/')) return undefined;
  const exists = async target => { try { return !!(await stat?.(target))?.realPath; } catch { return false; } };
  const roots = [...HOSTS.map(host => ({ root: `${home ?? '/~'}/${host}`, always: true })), ...configDir ? [{ root: configDir, always: false }] : []];
  for (const { root, always } of roots) {
    const cache = folded(normalize(`${root}/plugins/cache`));
    if ((value === cache || cache.startsWith(value === '/' ? '/' : value + '/')) && (always || await exists(`${root}/plugins/cache`))) return PROTECTED.aboveInstall;
    const rest = value.startsWith(cache + '/') ? value.slice(cache.length + 1) : undefined;
    if (rest && !rest.includes('/') && (rest === 'sleight' || await exists(`${expanded}/sleight`))) return PROTECTED.aboveInstall;
  }
  return undefined;
}
// The label for a path, ancestors included when the command reaches what is under it.
const literalLabel = async (path, options, ancestor) => {
  const label = protectedLiteral(path, options) ?? (ancestor ? above(path, options?.home, options?.platform ?? runtimePlatform) ?? await aboveInstall(path, options) : undefined);
  return [PROTECTED.install, PROTECTED.aboveInstall].includes(label) && await benchExempt(path, options) ? undefined : label;
};

// Resolve before normalizing: a symlink followed by .. walks from its target.
async function protectedPath(path, options, ancestor = false) {
  const { stat, home } = options ?? {};
  if (typeof path !== 'string' || !path || path.length > 4096) return undefined;
  const literal = await literalLabel(path, options, ancestor);
  if (literal) return literal;
  if (home) path = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home);
  if (options?.configDir) path = path.replace(/^(?:\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\})(?=\/|$)/, () => options.configDir);
  const windows = (options?.platform ?? runtimePlatform) === 'win32' && /^[a-z]:[\\/]/i.test(path);
  if (windows) path = path.replace(/\\/g, '/');
  let resolved = (await stat(windows ? path.slice(0, 3) : path.startsWith('/') ? '/' : '.').catch(() => undefined))?.realPath;
  if (!resolved) return PROTECTED.unresolved;
  for (const part of (windows ? path.slice(3) : path).split('/').filter(Boolean)) {
    const next = `${resolved.replace(/\/$/, '')}/${part}`;
    const info = await stat(next).catch(() => undefined);
    if (info && typeof info.realPath !== 'string') return PROTECTED.unresolved;
    resolved = info?.realPath ?? normalize(next);
  }
  // configDir too: a link to a custom CLAUDE_CONFIG_DIR resolves to it, and its folders above an install still count.
  return literalLabel(resolved, options, ancestor);
}

// Only literal shell names and operators, never eval or shell expansion. Keep
// operators inside quotes as text, and join quoted/escaped pieces of a word.
function shellWords(command) {
  const words = [];
  let word = '', quote = '', quoteType = '', active = false, quotes = 0, escapes = false, bare = false;
  const flush = () => {
    if (!active) return;
    words.push({ text: word, ...quotes === 1 && !bare ? { quoted: true, literal: quoteType === "'" } : {},
      ...escapes || quotes > 1 || quotes && bare ? { joined: true } : {} });
    word = ''; quoteType = ''; active = false; quotes = 0; escapes = false; bare = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '$' && !quote && command[i + 1] === "'") {
      // ANSI-C quoting is one literal word, including option flags such as $'-I'. Decode only its escapes.
      quote = "ansi"; quoteType = "'"; active = true; quotes++; i++;
    }
    else if (quote === 'ansi') {
      if (c === "'") quote = '';
      else if (c === '\\') {
        const tail = command.slice(i + 1), match = /^(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{4})|U([\da-fA-F]{8})|([0-7]{1,3}))/.exec(tail);
        if (match) {
          const point = parseInt(match[1] ?? match[2] ?? match[3] ?? match[4], match[4] ? 8 : 16);
          word += point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'; i += match[0].length;
        } else {
          const escaped = command[++i] ?? '';
          word += ({ n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' })[escaped] ?? '\\' + escaped;
        }
      } else word += c;
    }
    else if (c === '\\' && quote !== "'") {
      // In double quotes a backslash before a space survives for the nested shell's tokenizer.
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(command[i + 1])) { word += c; continue; }
      const escaped = command[++i] ?? '';
      if (escaped !== '\n') { active = true; escapes = true; word += escaped; }
    }
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === '$' && !quote && command[i + 1] === '"') {
      // Recognize the literal spelling of Bash locale-quoted option flags.
      quote = '"'; quoteType = '"'; active = true; quotes++; i++;
    }
    else if (c === "'" || c === '"') { quote = c; quoteType = c; active = true; quotes++; }
    else if (c === '\n') { flush(); words.push({ text: ';', operator: true }); }
    else if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f' || c.charCodeAt(0) > 127 && /\s/.test(c)) { if (active) flush(); }
    else if (';&|<>()'.includes(c) || '{}'.includes(c) && !active && /[\s;&|()]|^$/.test(command[i + 1] ?? '')) {
      flush();
      const pair = c + (command[i + 1] ?? '');
      const operator = command.slice(i, i + 3) === '<<<' ? (i += 2, '<<<') : ['>>', '>|', '>&', '<&', '<>', '<<', '&&', '||', '|&'].includes(pair) ? (i++, pair) : c;
      words.push({ text: operator, operator: true });
    }
    else { word += c; active = true; bare = true; }
  }
  flush();
  return words;
}

// Commands a find -exec runs that change or remove what it finds.
const FIND_WRITERS = new Set(['rm', 'mv', 'cp', 'ln', 'chmod', 'chown', 'chgrp', 'chflags', 'truncate', 'tee', 'unlink', 'sed', 'perl', 'sh', 'bash', 'zsh',
  'python', 'python3', 'node', 'ruby', 'xargs', 'dd', 'install', 'rsync', 'ditto', 'touch', 'shred', 'srm']);
// A path with glob or brace characters names whatever its folder holds that matches; the folder decides.
const globFolder = path => /[*?[{]/.test(path) ? path.slice(0, path.search(/[*?[{]/)).replace(/\/[^/]*$/, '') : undefined;
const PROTECTED_NAME = /(?:preapproved|turbo|turbo-apps|turbo-owner|electron-grants|hand|permissions|settings-link)\.json|routine-launcher\.mjs|grant-seal\.key|menu-(?:presence|session)\.lock|\.sleight-shim-v1/i;
// 18 times the largest pre-GD3 corpus command (3,606 characters). Above this UTF-16 limit, only a literal read allowlist runs.
// This bounds parser work even without a protected-name hint; the hook also denies on a host-enforced timeout.
export const MAX_PROTECTED_COMMAND = 65536;
const protectedNames = [...settingsNames, ...scheduledFolders, 'sleight', 'sleight-mcp', 'launch.mjs', '.sleight-shim-v1'];
// The candidate names have fixed small lengths. This wildcard walk has at most name.length retries per pattern character.
function globNamesProtected(pattern, name) {
  let i = 0, j = 0, star = -1, retry = 0;
  while (j < name.length) {
    if (pattern[i] === '?' || pattern[i] === name[j]) { i++; j++; }
    else if (pattern[i] === '*') { star = i++; retry = j; }
    else if (star >= 0) { i = star + 1; j = ++retry; }
    else return false;
  }
  while (pattern[i] === '*') i++;
  return i === pattern.length;
}
function oversizedProtectedCommand(command) {
  if (command.length <= MAX_PROTECTED_COMMAND) return false;
  // Fold literal concatenation, continuations, ANSI octal/hex and Unicode escapes before looking for names.
  const decoded = command.replace(/\\(?:u\{([\da-f]{1,6})\}|([0-7]{1,3}))/gi, (match, unicode, octal) => {
    const point = parseInt(unicode ?? octal, unicode ? 16 : 8);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
  // Test before folding out backticks, which can execute code while constructing any path.
  if (/`/.test(command)) return true;
  const text = folded(unescaped(decoded)).replace(/[`^+]/g, ''), compact = text.replace(/\s/g, '');
  if (sourceProtectedTarget(compact) || /sleight|sleigh~|launch\.mjs|appdata|turbo-host|powershell|pwsh|frombase64string|invoke-expression/.test(compact)) return true;
  // Opaque expansions can construct any protected name. Fail closed without evaluating assignments or substitutions.
  if (/[$`]|%[^%]*%/.test(text)) return true;
  for (const token of text.split(/[\s/;|&()<>=]+/)) {
    if (!/[*?\[{]/.test(token)) continue;
    let pattern = '';
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '[' || token[i] === '{') {
        const end = token.indexOf(token[i] === '[' ? ']' : '}', i + 1);
        // An unfinished bracket or brace is literal shell text. Stop searching the rest of this token once.
        if (end < 0) { pattern += token.slice(i); break; }
        pattern += token[i] === '[' ? '?' : '*'; i = end;
      } else pattern += token[i];
    }
    if (protectedNames.some(name => globNamesProtected(pattern, name))) return true;
  }
  // Do not infer safety from absent protected names. An ancestor, decoder or arbitrary program needs no such name.
  // Permit only a single literal data/read command, optionally after one inert comment-padding line. No expansion,
  // redirection, pipeline, command separator, wrapper, assignment or executable option is admitted by this grammar.
  const literal = command.replace(/^#+\r?\n/, '').trim();
  return !/^(?:echo|printf|cat)[ \t]+[\w ./:%="'\[\]*?\\-]+$/.test(literal);
}
const launcher = name => ['sleight', 'sleight-mcp', 'launch.mjs', '.sleight-shim-v1'].includes(name.toLowerCase());
const commandArgument = value => value.replace(/^['"]+|[;&|)'"]+$/g, '');
// True when the words run the launcher's command with arguments `allowed` refuses (by default anything but status), as
// separate words or inside a -c string, where the arguments run to the next shell operator.
const statusOnly = rest => rest[0] === 'status';
function launcherToggle(words, command, allowed = statusOnly) {
  const names = words.map(word => word.split('/').at(-1));
  const { index } = commandWord(words.map(text => ({ text })));
  const first = names.findIndex((name, at) => launcher(name) && (name !== 'sleight' || at === index || at === index + 1 && names[index] === 'node'));
  if (first >= 0) {
    const at = names.indexOf(command, first + 1);
    if (at >= 0 && !allowed(names.slice(at + 1).map(commandArgument))) return true;
  }
  return words.some(word => {
    if (!/\s/.test(word)) return false;
    const hit = /(?<![\w.-])(?:sleight-mcp|\.sleight-shim-v1|launch\.mjs)(?=[\s'"]|$)/.exec(word);
    // A script string that runs the launcher through xargs gives it arguments from input the guard doesn't see.
    if (hit && /(?<![\w-])xargs(?![\w-])[^;&\n]*$/.test(word.slice(0, hit.index))) return true;
    return !!hit && [...word.slice(hit.index).matchAll(new RegExp(`(?<![\\w-])${command}(?![\\w-])([^;&|)\\n]*)`, 'g'))]
      .some(match => !allowed(match[1].trim().split(/\s+/).filter(Boolean).map(commandArgument)));
  });
}
// `permissions` alone or `permissions list` only reads; block, unblock, revoke and sites write permissions.json or a grant.
const listingOnly = rest => rest.length === 0 || rest.length === 1 && rest[0] === 'list';
// The launcher's commands that change what sleight may do, each with the forms Claude's shell may run.
const cursorReads = rest => ['list', 'check', 'status'].includes(rest[0]);
const LAUNCHER_COMMANDS = [['turbo', statusOnly, 'turbo.json'], ['hand', statusOnly, 'hand.json'], ['cursor', cursorReads, 'hand.json'],
  ['permissions', listingOnly, 'permissions.json'], ...['menu', 'link', 'unlink', 'replay', 'record'].map(word => [word, () => false, 'hand.json'])];
// Fail closed on launcher segments and executable shell text. Other pipelines' read/print arguments cannot change
// the launcher's argv. The guard never evaluates expansions or reads scripts on disk.
const LAUNCHER_NAME = /(?<![\w.-])(?:sleight-mcp|launch\.mjs)(?![\w.-])|(?:^|[^\w.-])\.sleight-shim-v1(?![\w.-])|\/\.local\/bin\/sleight(?![\w./:-])/i;
const launcherText = text => LAUNCHER_NAME.test(text) || /(?<![\w./-])sleight(?![\w./:-])/i.test(text);
const SUBCOMMAND = /(?<![\w-])(?:hand|turbo|permissions|cursor|menu|link|unlink|replay|record)(?![\w.-])/; // not turbo.json or hand.json
const INPUT_RUNNERS = String.raw`(?<![\w-])(?:\w*args|parallel|eval|source)(?![\w-])`;
const EXPANDS = String.raw`[$` + '`' + String.raw`*?[\]{}]`;
// With the launcher named but no subcommand word: text that could still make one.
const GENERATES = new RegExp(EXPANDS + String.raw`|[<>]\(|` + INPUT_RUNNERS);
// With a subcommand word as well: anything but plain words and ;, &, |.
const UNPLAIN = new RegExp(String.raw`[$` + '`' + String.raw`*?[\]{}()<>]|` + INPUT_RUNNERS);
const EXPANDING_WORD = new RegExp(EXPANDS);
// A command word the guard can't read: an expansion, a substitution, a glob or brace, or a runner of other text.
const UNREADABLE_WORD = new RegExp(EXPANDS + String.raw`|^(?:\w*args|parallel|eval|source|\.)$`);
// Each prefix's known options: flags, options that take the next word, and a required positional (timeout's duration).
// Anything else, env -S / --split-string among them, makes the command word unreadable.
const PREFIX_OPTIONS = {
  env: { flags: ['-i', '-0', '-v', '--ignore-environment', '--null', '--debug'], args: ['-u', '--unset', '-C', '--chdir'] },
  sudo: { flags: ['-E', '-H', '-n', '-k', '-K', '-b', '-P'], args: ['-u', '-g', '-C', '-D', '-p', '-r', '-t', '-U', '-h', '-T'] },
  timeout: { flags: ['--foreground', '--preserve-status', '-v', '--verbose', '-f', '-p'], args: ['-s', '--signal', '-k', '--kill-after'], duration: true },
  nice: { flags: [], args: ['-n', '--adjustment'], numeric: true },
  nohup: { flags: [], args: [] },
  time: { flags: ['-p', '-l', '-h', '-a', '-v', '--portability', '--verbose'], args: ['-o', '--output', '-f', '--format'] },
  stdbuf: { flags: [], args: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  caffeinate: { flags: ['-d', '-i', '-m', '-s', '-u'], args: ['-t', '-w'] },
  command: { flags: ['-p', '-v', '-V'], args: [] },
  exec: { flags: ['-c', '-l'], args: ['-a'] },
  builtin: { flags: [], args: [] },
  busybox: { flags: [], args: [] },
  doas: { flags: ['-n', '-s', '-L'], args: ['-u', '-C'] },
  xargs: { flags: ['-0', '-r', '-t', '-p', '-x', '--null', '--no-run-if-empty', '--verbose'],
    args: ['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-a', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--eof', '--arg-file'] },
  arch: { flags: ['-arm64', '-arm64e', '-x86_64', '-i386'], args: [] },
  taskpolicy: { flags: ['-b', '-B', '-s', '-a', '-x', '-X'], args: ['-c', '-t', '-d', '-g', '-l', '-p', '-m', '-j', '-S', '-P'] },
  script: { flags: ['-a', '-d', '-e', '-F', '-k', '-q', '-r'], args: ['-t'], positional: true },
  chroot: { flags: [], args: ['--userspec', '--groups'], positional: true },
  setsid: { flags: ['-c', '-f', '-w', '--ctty', '--fork', '--wait'], args: [] },
  unbuffer: { flags: ['-p'], args: [] },
  noglob: { flags: [], args: [] },
  nocorrect: { flags: [], args: [] },
  lockf: { flags: ['-k', '-n', '-s'], args: ['-t'], positional: true },
  'sandbox-exec': { flags: [], args: ['-f', '-p', '-D'] },
  watch: { flags: ['-d', '-e', '-g', '-t', '-x', '--differences', '--errexit', '--chgexit', '--no-title', '--exec'], args: ['-n', '--interval'] },
  'reattach-to-user-namespace': { flags: ['-l'], args: [] },
};
for (const name of ['timeout', 'nice', 'env', 'stdbuf', 'time', 'xargs']) PREFIX_OPTIONS['g' + name] = PREFIX_OPTIONS[name];
const PREFIXES = new Set(Object.keys(PREFIX_OPTIONS).filter(name => !['xargs', 'gxargs'].includes(name)));
const WRITER_PREFIXES = new Set([...PREFIXES, 'xargs', 'gxargs']);
const READ_PREFIXES = new Set(['env', 'nohup', 'time', 'timeout']);
// The index after a prefix's options, or -1 for an option the guard doesn't know.
function prefixEnd(segment, i, options) {
  const word = k => segment[k] && !segment[k].operator ? segment[k].text : undefined;
  while (word(i)?.startsWith('-') && word(i) !== '-') {
    const text = word(i);
    if (text === '--') { i++; break; }
    if (options.flags.includes(text) || options.numeric && /^-\d+$/.test(text)) { i++; continue; }
    if (options.args.includes(text)) { if (word(i + 1) === undefined) return -1; i += 2; continue; }
    const long = /^(--[\w-]+)=/.exec(text)?.[1], short = text.slice(0, 2);
    if (long && options.args.includes(long) || !text.startsWith('--') && text.length > 2 && options.args.includes(short)) { i++; continue; }
    return -1;
  }
  if (options.duration) { if (!/^\d+(?:\.\d+)?[smhd]?$/.test(word(i) ?? '')) return -1; i++; }
  if (options.positional) { if (word(i) === undefined) return -1; i++; }
  return i;
}
// The segment's command word, after assignments and prefixes such as env or nohup (with their known options).
// assigned: an assignment came first, which can change what the command word runs (PATH, GIT_PAGER).
function commandWord(segment, prefixes = PREFIXES) {
  let assigned = false, xargs = false, keyword = false;
  const outputs = [];
  for (let i = 0; i < segment.length;) {
    if (segment[i].operator) return { unreadable: true };
    const text = segment[i].text, name = text.split('/').at(-1);
    if (!segment[i].quoted && !segment[i].joined && /^(?:!|if|then|elif|else|do|while|until|coproc)$/.test(text)) { keyword = true; i++; continue; }
    if (!segment[i].quoted && text === 'function') { keyword = true; i += 2; continue; }
    if (/^[A-Za-z_]\w*=/.test(text)) { assigned = true; i++; continue; }
    if (prefixes.has(name)) {
      xargs ||= name === 'xargs' || name === 'gxargs';
      i = prefixEnd(segment, i + 1, PREFIX_OPTIONS[name]);
      if (i < 0) return { unreadable: true, xargs, opaque: name === 'script', outputs };
      if (name === 'script') outputs.push(segment[i - 1].text);
      continue;
    }
    return { index: i, unreadable: UNREADABLE_WORD.test(text) || segment[i].joined === true, assigned, xargs, keyword, outputs };
  }
  return { assigned, xargs };
}
const READ_FORMS = ['--doctor', 'hand status', 'turbo status', 'permissions', 'permissions list', 'cursor list', 'cursor status', 'runs list'];
const readForm = args => args.length === 3 && args[0] === 'runs' && args[1] === 'open' && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{32}$/.test(args[2]) || READ_FORMS.includes(args.join(' ')) || args.length === 3 && args[0] === 'cursor' && args[1] === 'check' && /^[\w-]{1,64}$/.test(args[2]);
// The launcher run directly, or by node with -- options, with literal arguments in a read form. at is its first word.
function launcherReadForm(plain, at) {
  if (plain[at]?.split('/').at(-1) === 'node') { at++; while (plain[at]?.startsWith('--')) at++; }
  return launcher(plain[at]?.split('/').at(-1) ?? '') && readForm(plain.slice(at + 1));
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const INTERPRETERS = /^(?:python[\d.]*|node|ruby|perl|php|osascript|swift|lua|tclsh|deno|bun|expect)$/;
const INLINE_FLAG = /^-(?:[a-zA-Z]*[ceEprRF]|-eval|-print)(?:=|$)/;
const shellScript = (words, at) => {
  if (!SHELLS.has(words[at]?.split('/').at(-1))) return undefined;
  let source = false;
  for (let i = at + 1; i < words.length; i++) {
    const word = words[i];
    if (word === '--') return source ? words[i + 1] ?? '' : null;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) source = true;
    // A trailing o/O consumes the next word even when this cluster also sets -c.
    if (['-o', '-O', '+o', '+O', '--rcfile', '--init-file'].includes(word) || /^[+-][a-zA-Z]+[oO]$/.test(word)) { i++; continue; }
    if (/^[+-]/.test(word)) continue;
    return source ? word : null;
  }
  return source ? '' : null;
};
// A shell or interpreter beside a subcommand word passes only when it runs the launcher's read form literally:
// node /x/lib/launch.mjs hand status, or sh -c with exactly that script and nothing after it.
function runsLauncherReadForm(segment, index) {
  const plain = segment.map(word => word.text), name = plain[index].split('/').at(-1);
  if (name === 'node') return launcherReadForm(plain, index);
  if (!SHELLS.has(name)) return false;
  const script = shellScript(plain, index);
  if (typeof script !== 'string' || plain.at(-1) !== script || plain.indexOf(script) !== plain.length - 1) return false;
  const inner = shellWords(script);
  return inner.length > 0 && inner.every(word => !word.operator && !word.joined && !EXPANDING_WORD.test(word.text)) &&
    launcherReadForm(inner.map(word => word.text), 0);
}
// Read-only tools that never run the launcher, so a segment of one may name it (grep -n hand .../launch.mjs). Options
// that run another program or write a file make the tool something else.
const READ_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'wc', 'ls', 'file', 'stat', 'diff']);
const GIT_READS = new Set(['log', 'show', 'diff', 'grep', 'blame', 'status']);
const RUNS_COMMAND = /^--(?:pre|pre-glob|filter|view|pager|open-files-in-pager|output|ext-diff|exec|hostname-bin)(?:=|$)/;
function readTool(segment) {
  const { index, unreadable, assigned } = commandWord(segment, READ_PREFIXES);
  if (index === undefined || unreadable || assigned) return false;
  const plain = segment.map(word => word.text), name = plain[index].split('/').at(-1), args = plain.slice(index + 1);
  if (args.some(word => RUNS_COMMAND.test(word))) return false;
  if (READ_TOOLS.has(name)) return true;
  // git grep -O opens a pager command.
  return name === 'git' && GIT_READS.has(args[0] === '--no-pager' ? args[1] : args[0]) && !args.some(word => /^-O/.test(word));
}
// Drop shell redirections and their optional fd prefixes while preserving argument quote metadata.
function shellArgv(segment, at) {
  const argv = [];
  for (let i = at; i < segment.length; i++) {
    if (segment[i].operator && /^[<>]/.test(segment[i].text)) { i++; continue; }
    if (/^\d+$/.test(segment[i].text) && segment[i + 1]?.operator && /^[<>]/.test(segment[i + 1].text)) continue;
    argv.push(segment[i]);
  }
  return argv;
}
// One forward scan. Delimited patterns and replacements are skipped once, so long flag strings cannot backtrack.
function sedEffects(text) {
  let i = 0, executes = false;
  const writes = [];
  const delimited = (delimiter, pattern = false) => {
    let bracket = false, first = false;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (pattern && c === '[' && !bracket) { bracket = true; first = true; }
      else if (bracket) {
        if (c === ']' && !first) bracket = false;
        if (c !== '^' || !first) first = false;
      } else if (c === delimiter) return;
    }
  };
  const filename = () => {
    const start = i;
    while (i < text.length && !/[;\n}]/.test(text[i])) i++;
    const path = text.slice(start, i).trim();
    if (path) writes.push(path);
  };
  while (i < text.length) {
    // Addresses, ranges, negation and group separators precede a command.
    while (i < text.length) {
      const c = text[i];
      if (/[\s;{}\d$,!~+]/.test(c)) { i++; continue; }
      if (c === '/') { i++; delimited('/', true); continue; }
      if (c === '\\' && i + 1 < text.length) { i++; delimited(text[i++], true); continue; }
      break;
    }
    const op = text[i++];
    if (op === 'e') { executes = true; filename(); }
    else if (op === 'w' || op === 'W') filename();
    else if (op === 's' || op === 'y') {
      const delimiter = text[i++];
      if (!delimiter) break;
      delimited(delimiter, true); delimited(delimiter);
      while (i < text.length && !/[;\n}]/.test(text[i])) {
        const flag = text[i++];
        if (op === 's' && flag === 'e') executes = true;
        if (op === 's' && (flag === 'w' || flag === 'W')) { filename(); break; }
      }
    } else {
      // Other commands cannot execute text. Their operands end at the next command separator.
      while (i < text.length && !/[;\n{}]/.test(text[i])) {
        if (text[i] === '\\') i++;
        i++;
      }
    }
  }
  return { executes, writes };
}
const sedExecutes = text => sedEffects(text).executes;
// getopt accepts every unique long-option prefix. Conservatively recognize even an ambiguous writing prefix.
const longOption = (arg, option) => arg.startsWith('--') && arg.length > 2 && option.startsWith(arg.split('=')[0]);
const sedInPlace = arg => /^-[^-]*[iI]/.test(arg) || longOption(arg, '--in-place');
function sedData(segment, index) {
  const args = shellArgv(segment, index + 1), scripts = [], files = [];
  let inPlace = false, options = true;
  for (let i = 0; i < args.length; i++) {
    const word = args[i], text = word.text;
    if (options && text === '--') { options = false; continue; }
    if (options && /^-[^-]*f|^--file(?:=|$)/.test(text)) return false;
    if (options && ['-n', '-E', '-r', '--quiet', '--silent', '--regexp-extended'].includes(text)) continue;
    if (options && sedInPlace(text)) {
      inPlace = true;
      if (['-i', '-I', '-ni', '-nI', '-Ei', '-EI'].includes(text) && (args[i + 1]?.text === '' || args[i + 1]?.text.startsWith('.'))) i++;
      continue;
    }
    if (options && ['-e', '--expression'].includes(text)) { if (!args[++i]) return false; scripts.push(args[i]); continue; }
    if (options && text.startsWith('--expression=')) { scripts.push({ ...word, text: text.slice(13) }); continue; }
    if (options && text.startsWith('-')) return false;
    if (!scripts.length) scripts.push(word); else files.push(word);
    options = false;
  }
  return scripts.length > 0 && scripts.every(word => !word.operator && !sedExecutes(word.text) &&
    (word.literal || word.quoted ? word.literal || !/\$|`/.test(word.text) : !EXPANDING_WORD.test(word.text))) &&
    (!inPlace || files.every(word => !word.joined && !EXPANDING_WORD.test(word.text)));
}
// These fixed command words treat arguments as data. Shell substitutions are checked separately, and shellWritePaths
// still checks every output destination. Runner options keep tools such as rg and sort outside this exemption.
function dataTool(segment) {
  const { index, unreadable, assigned } = commandWord(segment, new Set());
  if (index === undefined || unreadable || assigned) return false;
  const plain = segment.map(word => word.text), name = plain[index].split('/').at(-1), args = plain.slice(index + 1);
  if (args.some(word => RUNS_COMMAND.test(word) || word.startsWith('--') && word.length > 2 &&
    '--compress-program'.startsWith(word.split('=')[0]))) return false;
  // sed's e command and s///e flag execute text; -f loads a script the guard cannot inspect. Its w and -i writes
  // remain data operations here, with destinations checked by shellWritePaths.
  if (name === 'sed') return sedData(segment, index);
  return READ_TOOLS.has(name) || ['echo', 'printf', 'sort', 'uniq', 'jq'].includes(name);
}
// Output operands that are not shell redirections. Keep option arguments out of uniq's positional operands.
function argumentWritePaths(name, args) {
  const paths = [];
  if (name === 'sort' || name === 'shuf') for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (longOption(arg, '--output')) paths.push(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]);
    else if (arg === '-o') paths.push(args[++i]);
    else if (/^-[^-]*o/.test(arg)) {
      const tail = arg.slice(arg.indexOf('o') + 1);
      paths.push(tail || args[++i]);
    }
  }
  if (name === 'csplit') for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (longOption(arg, '--prefix')) paths.push(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]);
    else if (/^-f/.test(arg)) paths.push(arg.slice(2) || args[++i]);
  }
  if (name === 'uniq') {
    const operands = [];
    let options = true;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (options && arg === '--') { options = false; continue; }
      if (options && ['--skip-fields', '--skip-chars', '--check-chars'].some(option => longOption(arg, option))) {
        if (!arg.includes('=')) i++;
        continue;
      }
      if (options && ['-f', '-s', '-w'].includes(arg)) { i++; continue; }
      if (options && /^-[^-]*[fsw]$/.test(arg)) { i++; continue; }
      if (options && arg.startsWith('-') && arg !== '-') continue;
      operands.push(arg);
    }
    if (operands.length > 1) paths.push(operands[1]);
  }
  if (name === 'file' && args.some(arg => /^-[^-]*C/.test(arg) || arg === '--compile')) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') break;
      if (arg === '-m' || arg === '--magic-file') paths.push(args[++i]);
      else if (arg.startsWith('--magic-file=')) paths.push(arg.slice(13));
      else if (/^-[^-]*m/.test(arg)) paths.push(arg.slice(arg.indexOf('m') + 1) || args[++i]);
    }
    // With no -m, file compiles the default database in the current directory.
    if (!paths.length) paths.push('magic.mgc');
  }
  return paths.filter(path => typeof path === 'string');
}
function substitutionWriter(segment) {
  const { index } = commandWord(segment);
  if (index === undefined) return false;
  const name = segment[index].text.split('/').at(-1), args = shellArgv(segment, index + 1).map(word => word.text);
  const redirects = segment.flatMap((word, at) => word.operator && /^>/.test(word.text) && segment[at + 1] ? [segment[at + 1].text] : []);
  const outputs = argumentWritePaths(name, args);
  const writes = redirects.length || outputs.length || ['tee', 'truncate', 'touch'].includes(name) ||
    name === 'sed' && args.some(arg => sedInPlace(arg) || sedEffects(arg).writes.length);
  if (!writes) return false;
  // GD1's requested dated documentation log remains allowed. Only plain literal document redirects get this exception.
  const documentLog = ['echo', 'printf'].includes(name) && !outputs.length && redirects.length &&
    redirects.every(path => /^[\w./-]+\.(?:md|txt|log)$/.test(path) && !path.split('/').includes('..') && !CONFIG.test(folded(normalize(path)))) &&
    !segment.some(word => LAUNCHER_NAME.test(word.text));
  return !documentLog;
}
// Heredoc input to a shell/interpreter is source, even with a quoted delimiter. Never exempt or erase its body.
// Inspect literal names and cheap joined-string spellings without interpreting the language or trusting a runner denylist.
function heredocSources(command) {
  const continued = command.replace(/\\\n/g, '');
  if (!continued.includes('<<')) return [];
  const lines = continued.split('\n'), sources = [];
  for (let i = 0; i < lines.length; i++) {
    const words = shellWords(lines[i]);
    if (!words.some(word => !word.operator && (SHELLS.has(word.text.split('/').at(-1)) || INTERPRETERS.test(word.text.split('/').at(-1))))) continue;
    const delimiters = words.flatMap((word, at) => word.operator && word.text === '<<' && words[at + 1] && !words[at + 1].operator ? [words[at + 1].text] : []);
    for (const delimiter of delimiters) {
      const tabs = delimiter.startsWith('-'), end = tabs ? delimiter.slice(1) : delimiter;
      const start = ++i;
      while (i < lines.length && (tabs ? lines[i].replace(/^\t+/, '') : lines[i]) !== end) i++;
      sources.push(lines.slice(start, i).join('\n'));
    }
  }
  return sources;
}
function sourceProtectedTarget(source) {
  const text = folded(unescaped(source));
  if (ENGINE_TREE.test(text)) return PROTECTED.engine;
  if (PROTECTED_NAME.test(text) || /permissions-command\.mjs|preapproved\.mjs/.test(text) ||
      /application\s*support/.test(text) && /sleight/.test(text)) return PROTECTED.settings;
  if (/library[\s/]*caches/.test(text) && /sleight/.test(text)) return PROTECTED.cache;
  if (/plugins[\s/]*cache/.test(text) && /sleight/.test(text)) return PROTECTED.install;
  if (/\.local[\s/]*bin[\s/]*sleight/.test(text)) return PROTECTED.shim;
  return undefined;
}
// A read tool's segment passes only when nothing in the command can run something else: no output redirection,
// subshell, find -exec or substitution anywhere.
function readOnly(command, words) {
  if (/`|\$\(|[<>]\(/.test(command)) return false;
  return !words.some(word => word.operator ? />|^[()]$/.test(word.text) : /^-(?:exec|execdir|ok|okdir)$/.test(word.text));
}
// After a pipe: a segment that runs its input as code (git log --format=%s | sh) or as arguments (| xargs, | parallel).
function runsInput(segment) {
  const { index } = commandWord(segment);
  if (index === undefined) return false;
  const plain = segment.map(word => word.text), name = plain[index].split('/').at(-1), args = plain.slice(index + 1);
  if (['eval', 'source', '.'].includes(name)) return 'code';
  if (/^\w*args$|^parallel$/.test(name)) return 'arguments';
  if (name === 'sed' && args.some(arg => /^-[^-]*f|^--file(?:=|$)/.test(arg) ||
      sedExecutes(arg.replace(/^--expression=/, '').replace(/^-[nEr]*e/, '')))) return 'code';
  if (SHELLS.has(name)) return args.includes('-s') || !args.some(arg => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) || !arg.startsWith('-')) ? 'code' : false;
  if (INTERPRETERS.test(name)) return args.includes('-') || !args.some(arg => /^-(?:c|e|m|p|E|-eval|-print)(?:=|$)/.test(arg) || !arg.startsWith('-')) ? 'code' : false;
  return false;
}
function runsSubcommand(segment) {
  let { index } = commandWord(segment);
  if (index === undefined) return false;
  if (segment[index].text.split('/').at(-1) === 'node') { index++; while (segment[index]?.text.startsWith('--')) index++; }
  return launcher(segment[index]?.text.split('/').at(-1) ?? '') && segment[index + 1]?.text === 'runs';
}
// Literal launcher words share the conservative segment check, including command positions behind keywords and wrappers.
// The short product name in print/read arguments is data. Hard filenames keep their whole-text copy/alias check.
// Interpreter code is inspected separately from ordinary arguments.
function segmentNamesLauncher(segment, depth = 0) {
  if (depth > 8) return true;
  const { index } = commandWord(segment);
  if (index === undefined) return segment.some(word => !word.operator && LAUNCHER_NAME.test(word.text));
  const plain = segment.map(word => word.text), name = plain[index].split('/').at(-1);
  const hardName = segment.some(word => !word.operator && LAUNCHER_NAME.test(word.text));
  const script = shellScript(shellArgv(segment, index).map(word => word.text), 0);
  const codeAt = typeof script === 'string' ? plain.indexOf(script, index + 1) : -1;
  // The tokenizer already removes quoting, escapes and redirection operators. Inspect every remaining word,
  // including redirect targets and words after +/- options, rather than guessing which argument is the script.
  // A shell's -c source is parsed below as code, with its own command and data words.
  if (SHELLS.has(name) || INTERPRETERS.test(name)) {
    if (segment.some((word, at) => at !== codeAt && !word.operator && launcher(word.text.split('/').at(-1)))) return true;
  }
  if (!hardName && SHELLS.has(name)) {
    if (typeof script === 'string') {
      const segments = [[]];
      for (const word of shellWords(script)) {
        if (word.operator && [';', '&', '&&', '||', '|', '|&'].includes(word.text)) segments.push([]);
        else segments.at(-1).push(word);
      }
      return segments.some(segment => segmentNamesLauncher(segment, depth + 1));
    }
    return false;
  }
  if (name === 'node') { let at = index + 1; while (plain[at]?.startsWith('--')) at++; if (launcher(plain[at]?.split('/').at(-1) ?? '')) return true; }
  // -c/-e source is code, unlike commit messages, path operands and node --test arguments.
  const code = INTERPRETERS.test(name) && plain.slice(index + 1).some(word => INLINE_FLAG.test(word));
  const dataArguments = readTool(segment) || ['echo', 'printf', 'git', 'gh', 'npm'].includes(name) || INTERPRETERS.test(name) && !code;
  return segment.some((word, i) => !word.operator &&
    (dataArguments && i !== index ? LAUNCHER_NAME.test(word.text) : (i === index ? launcherText(name) || LAUNCHER_NAME.test(word.text) : launcherText(word.text))));
}
function launcherRefused(command, depth = 0, inheritedSub = false, parsed) {
  if (depth > 8) return true;
  // An expansion in a data argument can execute code even though the outer command cannot.
  const context = inheritedSub || SUBCOMMAND.test(command) || LAUNCHER_NAME.test(command);
  for (const code of bashSubstitutionCode(command)) {
    const refusal = launcherRefused(code, depth + 1, context);
    if (refusal) return refusal;
  }
  if ((parsed?.sources ?? heredocSources(command)).some(source => {
    if (!parsed?.sourcesChecked && sourceProtectedTarget(source)) return true;
    const text = unescaped(source);
    // Dequoting cannot create a launcher word unless its letters are present after unescaping. Preserve the token-level
    // boundary check when they are, including literal quote characters that unescaped removes from between words.
    return launcherText(text) || /sleight|launch\.mjs/.test(text) && shellWords(source).some(word => launcherText(word.text));
  })) return true;
  const words = parsed?.words ?? shellWords(command), texts = [command, ...words.map(word => word.text)];
  // Pipelines split on ; & && || and newline; their segments on | and |&. Subshell parentheses stay in the segment.
  const pipelines = [[[]]];
  for (const word of words) {
    if (word.operator && [';', '&', '&&', '||'].includes(word.text)) pipelines.push([[]]);
    else if (word.operator && ['|', '|&'].includes(word.text)) pipelines.at(-1).push([]);
    else pipelines.at(-1).at(-1).push(word);
  }
  const named = texts.some(text => LAUNCHER_NAME.test(text)) || pipelines.flat().some(segment => segmentNamesLauncher(segment));
  const sub = inheritedSub || texts.some(text => SUBCOMMAND.test(text)) || pipelines.flat().some(runsSubcommand);
  // Piped text run as code can be anything. Piped text as xargs arguments refuses once the launcher or a subcommand shows.
  for (const pipeline of pipelines) for (const segment of pipeline.slice(1)) {
    const runs = segment.length && runsInput(segment);
    if (runs === 'code' || runs === 'arguments' && (named || sub)) return true;
  }
  const reads = readOnly(command, words);
  for (const pipeline of pipelines) {
    const pipeSub = inheritedSub || pipeline.flat().some(word => !word.operator && SUBCOMMAND.test(word.text)) || pipeline.some(runsSubcommand);
    for (const segment of pipeline) {
      if (!segment.length || reads && readTool(segment)) continue;
      const segNamed = segmentNamesLauncher(segment);
      const segSub = inheritedSub || segment.some(word => !word.operator && SUBCOMMAND.test(word.text)) || runsSubcommand(segment);
      const { index, unreadable } = commandWord(segment);
      let launchAt = index;
      if (SHELLS.has(segment[index]?.text.split('/').at(-1)) || INTERPRETERS.test(segment[index]?.text.split('/').at(-1) ?? ''))
        launchAt = segment.findIndex((word, at) => at > index && !word.operator && launcher(word.text.split('/').at(-1)));
      if (launcher(segment[launchAt]?.text.split('/').at(-1) ?? '') &&
          ['replay', 'record'].includes(shellArgv(segment, launchAt + 1)[0]?.text)) return PROTECTED.replay;
      const plain = segment.map(word => word.text);
      const script = index === undefined ? undefined : shellScript(shellArgv(segment, index).map(word => word.text), 0);
      if (typeof script === 'string') {
        const refusal = launcherRefused(script, depth + 1, inheritedSub);
        if (refusal) return refusal;
      }
      const data = dataTool(segment);
      if (data && (segSub || named) && substitutionWriter(segment) &&
          segment.some((word, at) => !word.literal && (/\$\(|`/.test(word.text) ||
            word.text === '$' && segment[at + 1]?.operator && segment[at + 1].text === '('))) return true;
      if (named && !data && segment.some(word => GENERATES.test(word.text))) return true;
      // Expansion checks follow the segment naming the launcher. Other pipelines' patterns and print arguments cannot
      // change its argv. Keep the old conservative rule for reads that name a launcher file as an operand.
      if (segNamed && !(reads && readTool(segment)) && segment.some(word => (segSub ? UNPLAIN : GENERATES).test(word.text))) return true;
      // A command word the guard can't read beside a subcommand word may be the launcher under another spelling.
      if (unreadable && (pipeSub || named)) return true;
      if (index === undefined) { if (segNamed && segSub) return true; continue; }
      // The launcher is not a heredoc consumer in any supported read form.
      if (segNamed && segment.some(word => word.operator && word.text === '<<')) return true;
      if (typeof script === 'string' && plain.at(-1) === script && !segNamed) continue;
      if (segSub && !data) {
        // Beside a subcommand word, every word is plain: no expansion, glob, brace or joined quoting.
        if (segment.some(word => !word.operator && (word.joined || EXPANDING_WORD.test(word.text)))) return true;
        const name = plain[index].split('/').at(-1);
        if (SHELLS.has(name) || INTERPRETERS.test(name)) {
          if (segment.some((word, at) => word.operator && /^[<>]$/.test(word.text) && segment[at + 1]?.text === '(')) return true;
          // Inline programs can construct the launcher from adjacent string pieces. Keep that conservative refusal,
          // while allowing literal programs that only print a subcommand word.
          const inline = INTERPRETERS.test(name) && plain.slice(index + 1).some(word => INLINE_FLAG.test(word));
          if (inline && plain.slice(index + 1).some(word => /sleight|launch\.mjs/i.test(unescaped(word)))) return true;
          if (name === 'node' && plain[index + 1] === '--test' && !segNamed) continue;
          // Only segments with no launcher word may use the ordinary-program exemption. Options and fd redirects
          // do not make an ordinary script or literal inline program into a launcher. Expansions were refused above.
          const scriptWord = shellArgv(segment, index + 1).find(word => !/^[+-]/.test(word.text));
          if (!segNamed && scriptWord && !scriptWord.operator) continue;
          if (!runsLauncherReadForm(segment, index)) return true; continue;
        }
      }
      if (script === null && named && sub) return true;
      if (script !== undefined) continue;
      if (!segNamed || !sub && !plain.includes('--doctor')) continue;
      // A direct invocation: the launcher itself, or node with its options and then the launcher.
      let at = index;
      if (plain[at].split('/').at(-1) === 'node') { at++; while (plain[at]?.startsWith('--')) at++; }
      if (!launcher(plain[at]?.split('/').at(-1) ?? '')) return true;
      const args = plain.slice(at + 1);
      if (args[0] === '--doctor') {
        // Redirections are shell syntax, not doctor arguments. The expansion and protected-path checks still apply.
        if (!readForm(shellArgv(segment, at + 1).map(word => word.text))) return true;
      }
      if (args.some(arg => arg.startsWith('~') || LAUNCHER_NAME.test(arg))) return true;
      if ((args[0] === 'runs' || args.some(arg => SUBCOMMAND.test(arg))) && !readForm(args)) return true;
    }
  }
  return false;
}

// PowerShell and cmd have too many ways to assemble a path to recognize write shapes. Fail closed on state-name hints,
// env traversal and wildcard path words instead. Only a single literal reader is exempt. This courtesy barrier cannot
// see a script file's contents or isolate arbitrary programs running as the same user.
const WINDOWS_CACHE_TEXT = /localappdata|localapplicationdata|appdata|appdat~/i;
const WINDOWS_HELPER_NAME = /sleight|sleigh~|turbo-host/i;
const WINDOWS_PATH_HINT = /appdata|appdat~|(?:^|[/:])local(?:\/|$)|sleight|sleigh~|turbo-host|\$\{?env:|\benv:|%[^%\s]+%|~|\$\{?(?:home|profile)\b|userprofile|(?:^|[^a-z0-9_])[a-z]:\/users(?:\/|$)|(?:^|\/)(?:mnt\/|cygdrive\/)?[a-z]\/users(?:\/|$)/i;
const RELATIVE_ROOT = /^(?:-[\w-]+:)?\.{1,2}\//;
const WINDOWS_MATCHES = Object.freeze({
  name: "names sleight's helper folder",
  helperHint: 'has a sleight helper-name hint',
  appdata: 'has a local app-data folder hint',
  wildcard: 'has a wildcard in a word with a path hint',
  traversal: 'combines an environment path with parent traversal',
  substitution: 'uses cmd variable substitution',
  encoded: 'uses an encoded PowerShell command flag',
  decoded: 'invokes a decoded PowerShell expression',
});
const WINDOWS_READERS = new Set(['cat', 'type', 'dir', 'ls', 'get-content', 'gc', 'get-item', 'gi', 'get-childitem', 'gci', 'test-path', 'get-filehash']);
// Keep quoted arguments atomic: a git message containing "pwsh -e" is data. Backslashes are literal on Windows.
function windowsCommandWords(command) {
  const words = [];
  let text = '', quote = '', quoted = false, bare = false;
  const flush = () => { if (text) words.push({ text, quoted: quoted && !bare }); text = ''; quoted = false; bare = false; };
  for (const c of command.replace(/[`^+]/g, '')) {
    if (quote) { if (c === quote) quote = ''; else text += c; }
    else if (c === '"' || c === "'") { quote = c; quoted = true; }
    else if (/[\r\n;&|()<>{}]/.test(c)) { flush(); words.push({ text: c, operator: true }); }
    else if (/\s/.test(c)) flush();
    else { text += c; bare = true; }
  }
  flush();
  return words;
}
function windowsEncodedCommand(command, depth = 0) {
  // Escape ticks join letters in PowerShell; paired ticks can also run a POSIX substitution.
  // Neither reading may hide a guarded shell name or flag from the other.
  // A continuation joins even a split shell name. Escaped quotes are literal characters, never quote delimiters.
  command = command.replace(/`\r?\n/g, '').replace(/`["']/g, '');
  const stripped = windowsEncodedWords(command, depth);
  if (stripped) return stripped;
  const grouped = command.replace(/`([^`\r\n]*\s[^`\r\n]*)`/g, '($1)');
  return grouped !== command ? windowsEncodedWords(grouped, depth) : undefined;
}
function windowsEncodedWords(command, depth) {
  if (depth > 8) return WINDOWS_MATCHES.encoded;
  const words = windowsCommandWords(command);
  const basename = word => word.replace(/\\/g, '/').split('/').at(-1).toLowerCase().replace(/\.exe$/, '');
  const dataCommands = new Set(['echo', 'write-host', 'write-output', 'git', 'printf', 'winget', 'choco', 'scoop', 'brew', 'which', 'get-command']);
  const runners = new Set(['cmd', 'iex', 'invoke-expression', 'runas', 'wmic', 'schtasks', 'start', 'start-process', 'conhost', 'wsl', 'call']);
  const encodedFlag = arg => {
    const flag = /^[-/]([a-z]+)(?=[:,\s]|$)/i.exec(arg)?.[1].toLowerCase();
    return !!flag && (flag === 'ec' || 'encodedcommand'.startsWith(flag));
  };
  let first, segmentStart = 0, parenDepth = 0;
  const code = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.operator) {
      if (word.text === '(') parenDepth++;
      if (word.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      if (!('()'.includes(word.text) && runners.has(first))) first = undefined;
      segmentStart = i + 1; continue;
    }
    first ??= basename(word.text);
    // A lookup's output inside a group can become the program invoked after that group.
    if (dataCommands.has(first) && parenDepth === 0) continue;
    if (!word.quoted) code.push(word.text);
    // Known runners execute quoted command strings. Arbitrary quoted arguments stay data.
    if (word.quoted && runners.has(first) && /\s/.test(word.text)) {
      const match = windowsEncodedCommand(word.text, depth + 1);
      if (match) return match;
    }
    const name = basename(word.text), powershell = /^(?:powershell|pwsh)$/.test(name);
    if (!powershell || word.quoted && i !== segmentStart && !runners.has(first)) continue;
    for (let j = i + 1; j < words.length; j++) {
      // Parentheses also surround Start-Process -ArgumentList arrays.
      if (words[j].operator) { if ('()'.includes(words[j].text)) continue; break; }
      const arg = words[j].text;
      if (encodedFlag(arg)) return WINDOWS_MATCHES.encoded;
      // Only shell command arguments are parsed again, never arbitrary quoted text.
      if (/^[-/]c(?:ommand)?$|^\/k$/i.test(arg) && words[j + 1] && !words[j + 1].operator) {
        const match = windowsEncodedCommand(words[j + 1].text, depth + 1);
        if (match) return match;
        break;
      }
      // The text barrier also refuses encoded-shaped script arguments after -File, without reading the file.
      // Start-Process joins -ArgumentList strings and comma-separated arrays into the child's command line.
      if (/[\s,]/.test(arg)) {
        const match = windowsEncodedCommand(`${name} ${arg.replace(/,/g, ' ')}`, depth + 1);
        if (match) return match;
      }
    }
  }
  const expression = code.join(' ');
  return /\b(?:iex|invoke-expression)\b/i.test(expression) && /\bGetString\b/i.test(expression) &&
    /\bFromBase64String\b/i.test(expression) ? WINDOWS_MATCHES.decoded : undefined;
}
function windowsLiteralRead(command) {
  if (/[\r\n;&|<>`({]/.test(command)) return false;
  // Match whole words with at most one outer quote pair. Never join quote pieces or interpret backslashes as escapes.
  const words = [], token = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'"]+))(?=\s|$)/y;
  let at = 0;
  while (at < command.length && command.slice(at).trim()) {
    token.lastIndex = at;
    const match = token.exec(command);
    if (!match) return false;
    words.push(match[1] ?? match[2] ?? match[3]); at = token.lastIndex;
  }
  const executable = words.shift()?.toLowerCase(), args = words;
  if (!executable || !args.length) return false;
  if (args.some(word => {
    const literal = word.replace(/\$env:LOCALAPPDATA|\$LOCALAPPDATA|%LOCALAPPDATA%/gi, 'LOCALAPPDATA');
    return /[$%`^+;&|<>()[\]{}'"*?\r\n]/.test(literal) || RUNS_COMMAND.test(word);
  })) return false;
  return WINDOWS_READERS.has(executable) || READ_TOOLS.has(executable) ||
    executable === 'git' && GIT_READS.has(args[0] === '--no-pager' ? args[1] : args[0]) && !args.some(word => /^-O/.test(word));
}
function windowsCacheWrite(command) {
  const text = command.replace(/[`^'"+]/g, '').replace(/\\+/g, '/').toLowerCase();
  const encoded = windowsEncodedCommand(command);
  if (encoded) return encoded;
  if (windowsLiteralRead(command)) return undefined;
  if (/sleight\/turbo-host(?:\/|\b)/.test(text)) return WINDOWS_MATCHES.name;
  if (WINDOWS_HELPER_NAME.test(text)) return WINDOWS_MATCHES.helperHint;
  // APPDATA is Roaming. Only traversal or an additional Local hint makes that variable relevant here.
  const withoutRoaming = text.replace(/\$(?:\{(?:env:)?appdata\}|(?:env:)?appdata\b)|%appdata%/g, 'roaming');
  if (WINDOWS_CACHE_TEXT.test(withoutRoaming) || withoutRoaming !== text && /\blocal\b/.test(text)) return WINDOWS_MATCHES.appdata;
  if (text.includes('..') && /\$env:|%[^%\s]+%|~/.test(text)) return WINDOWS_MATCHES.traversal;
  // Require a complete cmd substitution, not git's %h:%s format placeholders. Git formats are data.
  const gitFormat = /^\s*git(?:\.exe)?\s+(?:--no-pager\s+)?(?:log|show)\b/i.test(command) &&
    windowsCommandWords(command).every(word => !word.operator);
  const withoutGitFormats = gitFormat ? command.replace(/--(?:format|pretty)(?:=|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi, '') : command;
  if (windowsPercentSubstitution(withoutGitFormats.replace(/[`^'"+]/g, ''))) return WINDOWS_MATCHES.substitution;
  // Attached options such as -Path:C:\Users\* count only when that same word carries a path hint.
  if (text.split(/\s+/).some(word => /[*?\[]/.test(word) && (WINDOWS_PATH_HINT.test(word) ||
    RELATIVE_ROOT.test(word) && (/[*?\[]/.test(word.slice(0, word.lastIndexOf('/'))) || /\/[a-z0-9_-]{1,4}[*?]$/i.test(word))))) return WINDOWS_MATCHES.wildcard;
  return undefined;
}

// Bash executes substitutions even inside double quotes. Collect their code with its own quote scope so an outer
// data command cannot hide it. Single-quoted text and escaped substitution openers stay data. Never execute input.
function bashSubstitutionCode(command) {
  const bodies = [], stack = [{ quote: '' }];
  for (let i = 0; i < command.length; i++) {
    const frame = stack.at(-1), c = command[i];
    if (frame.quote === "'") { if (c === "'") frame.quote = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (!frame.quote && c === '#' && (i === frame.start || i === 0 || /[\s;&|()<>]/.test(command[i - 1]))) {
      const newline = command.indexOf('\n', i);
      if (newline < 0) break;
      i = newline; continue;
    }
    if (c === '`') {
      if (frame.end === '`') { bodies.push(command.slice(frame.start, i)); stack.pop(); }
      else stack.push({ start: i + 1, end: '`', quote: '' });
      continue;
    }
    if ((c === '$' || !frame.quote && (c === '<' || c === '>')) && command[i + 1] === '(') {
      stack.push({ start: i + 2, end: ')', parens: 1, quote: '' }); i++; continue;
    }
    if (frame.quote) { if (c === frame.quote) frame.quote = ''; continue; }
    if (c === '"' || c === "'") { frame.quote = c; continue; }
    if (frame.end === ')') {
      if (c === '(') frame.parens++;
      if (c === ')' && --frame.parens === 0) { bodies.push(command.slice(frame.start, i)); stack.pop(); }
    }
  }
  return bodies;
}

// getopt permits options after operands. Consume value options before choosing the destination.
function copyArguments(name, args) {
  const operands = [], targets = [], linkDestinations = [];
  let links = false, paxRead = false, paxWrite = false;
  const shortValues = name === 'install' ? 'tSmog' : name === 'rsync' ? 'eB' : name === 'pax' ? 'bfopsx' : 'tS';
  const longValues = ['--target-directory', '--suffix', '--mode', '--owner', '--group', '--strip-program', '--context', '--backup'];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('--')) {
      // macOS cp has no long options; GNU cp accepts prefixes, including --li and --sym.
      if (name === 'cp' && ['--link', '--symbolic-link'].some(option => longOption(arg, option))) links = true;
      if (name === 'rsync' && longOption(arg, '--copy-links')) links = true;
      if (name === 'rsync' && longOption(arg, '--link-dest')) {
        links = true;
        linkDestinations.push(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i]);
        continue;
      }
      const option = longValues.find(option => longOption(arg, option));
      // --backup takes an optional attached value, never the next operand.
      if (option && option !== '--backup') {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
        if (option === '--target-directory') targets.push(value);
      }
      continue;
    }
    if (options && arg.startsWith('-') && arg !== '-') {
      for (let at = 1; at < arg.length; at++) {
        if (name === 'cp' && 'ls'.includes(arg[at]) || name === 'rsync' && 'HL'.includes(arg[at])) links = true;
        if (name === 'pax') { links ||= arg[at] === 'l'; paxRead ||= arg[at] === 'r'; paxWrite ||= arg[at] === 'w'; }
        if (shortValues.includes(arg[at])) {
          const value = arg.slice(at + 1) || args[++i];
          if (arg[at] === 't') targets.push(value);
          break;
        }
      }
      continue;
    }
    if (arg) operands.push(arg);
  }
  return { operands, targets, links, linkDestinations, passThrough: paxRead && paxWrite };
}
// Examine each percent-delimited field once, including a missing closing percent.
function windowsPercentSubstitution(text) {
  let start = text.indexOf('%');
  while (start >= 0) {
    const end = text.indexOf('%', start + 1);
    if (end < 0) return false;
    const field = text.slice(start + 1, end), name = /^[a-z_]\w*:/i.exec(field);
    if (name && !/[\r\n]/.test(field)) {
      const body = field.slice(name[0].length);
      if (body.startsWith('~') && body.length > 1 || body.includes('=')) return true;
    }
    start = end;
  }
  return false;
}

// Unknown cwd alone does not refuse ordinary build outputs. These names can reach the protected table or startup config.
function unknownDirectoryTarget(path) {
  if (ENGINE_TREE.test(folded(path.replace(/\\/g, '/')))) return true;
  const parts = folded(path.replace(/\\/g, '/')).split('/').filter(Boolean);
  const name = parts.at(-1);
  return protectedNames.includes(name) || parts.some(part => ['sleight', '.claude', '.codex', '.cursor', '.local', '.zshrc.d'].includes(part) ||
    /^\.(?:zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile|envrc)$/.test(part)) ||
    parts.some(part => /[*?\[{]/.test(part) && protectedNames.some(name => globNamesProtected(part.replace(/\[[^\]]*\]/g, '?').replace(/\{[^}]*\}/g, '*'), name)));
}
// Remove quoted heredoc data before the shell writer scan. Track substitution quote scopes so commit-message heredocs
// inside $(cat ...) are data too. Bodies still receive the protected-name scan; unquoted expansion scans stay intact.
function quotedHeredocs(command) {
  const stack = [{ quote: '' }], pending = [], bodies = [], spans = [];
  for (let i = 0; i < command.length; i++) {
    const frame = stack.at(-1), c = command[i];
    if (frame.quote === "'") { if (c === "'") frame.quote = ''; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '`') { if (frame.end === '`') stack.pop(); else stack.push({ quote: '', end: '`' }); continue; }
    if (c === '$' && command[i + 1] === '(') { stack.push({ quote: '', end: ')', parens: 1 }); i++; continue; }
    if (frame.quote) { if (c === frame.quote) frame.quote = ''; continue; }
    if (c === '#' && (i === 0 || /[\s;&|()<>]/.test(command[i - 1]))) {
      const newline = command.indexOf('\n', i); if (newline < 0) break; i = newline - 1; continue;
    }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const match = /^<<(-?)[ \t]*((?:[^\s;&|()<>'"\\]+|'[^'\n]*'|"[^"\n]*"|\\[^\n])+)/.exec(command.slice(i));
      if (match) {
        const [word] = shellWords(match[2]);
        if (word) pending.push({ delimiter: word.text, tabs: !!match[1], quoted: /['"\\]/.test(match[2]) });
        i += match[0].length - 1; continue;
      }
    }
    if (c === '"' || c === "'") { frame.quote = c; continue; }
    if (frame.end === ')') {
      if (c === '(') frame.parens++;
      if (c === ')' && --frame.parens === 0) { stack.pop(); continue; }
    }
    if (c !== '\n' || !pending.length) continue;
    let cursor = i + 1;
    for (const doc of pending.splice(0)) {
      const start = cursor;
      let end = cursor;
      while (cursor < command.length) {
        const lineStart = cursor, newline = command.indexOf('\n', cursor), next = newline < 0 ? command.length : newline;
        const line = command.slice(cursor, next);
        cursor = newline < 0 ? next : next + 1;
        if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) { end = lineStart; break; }
        end = cursor;
      }
      if (doc.quoted) { bodies.push(command.slice(start, end)); spans.push([start, end]); }
    }
    i = cursor - 1;
  }
  let at = 0, text = '';
  for (const [start, end] of spans) { text += command.slice(at, start) + command.slice(start, end).replace(/[^\n]/g, ' '); at = end; }
  return { command: spans.length ? text + command.slice(at) : command, bodies };
}

function shellWritePaths(command, initialDirectory, depth = 0, platform = runtimePlatform, parsedWords, initialCheck) {
  if (depth > 8) return [{ path: '.', unresolved: true, opaque: true }];
  const paths = [], segments = [{ words: [] }], words = parsedWords ?? shellWords(quotedHeredocs(command).command);
  // The whole-command read check is invariant across segments. Re-tokenizing it for every heredoc line is quadratic.
  const reads = readOnly(command, words);
  let directory = initialDirectory, directoryStack, directoryCheck = initialCheck, successfulCd, conditionalCd = false, scopeDepth = 0;
  const created = new Set();
  const cdpath = words.some((word, at) => /^CDPATH\+?=/.test(word.text) && !word.quoted || word.text === 'CDPATH' && ['export', 'typeset', 'declare'].includes(words[at - 1]?.text));
  const homeAssigned = words.some(word => /^HOME\+?=/.test(word.text));
  const subshells = [];
  for (const word of words) {
    const previous = segments.at(-1);
    if (word.operator && [';', '&', '|', '|&', '&&', '||', '(', ')', '{', '}'].includes(word.text)) {
      segments.push({ words: [], boundary: word.text, piped: word.text === '|' ? previous.words : undefined });
    } else previous.words.push(word);
  }
  // ancestor: the command also reaches what is under the path (rm -r, mv, find -delete, chmod -R), so a parent folder counts.
  const add = (path, literalOnly = false, ancestor = false) => {
    if (typeof path !== 'string' || path === '-') return;
    const relative = !/^(?:\/|~|\$HOME|\$\{HOME\}|\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\})/.test(path);
    paths.push({ path: directory && relative ? `${directory}/${path}` : path, literalOnly, ancestor,
      ...relative && directoryCheck ? { directoryCheck, relativePath: path } : {},
      ...directory === null && relative ? { unresolved: true } : {} });
  };
  const destination = (target, sources, contents = false) => {
    if (typeof target !== 'string') return;
    // A file copied into a directory keeps its basename. Inspect that resulting path without treating every home-folder
    // copy as a write to every protected descendant. Replacing a PATH parent or copying directory contents still counts.
    add(target, false, contents || /\/\.local(?:\/bin)?\/?$/i.test(target));
    for (const source of sources) add(`${target}/${source.split('/').filter(Boolean).at(-1)}`, false, true);
  };
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const { words: segment, piped, boundary } = segments[segmentIndex];
    const nextBoundary = segments[segmentIndex + 1]?.boundary;
    if (boundary === '&&' && successfulCd) ({ directory, directoryCheck } = successfulCd);
    else if (conditionalCd && boundary !== '&&') { directory = null; directoryCheck = undefined; conditionalCd = false; }
    if (boundary === '{') scopeDepth++;
    if (boundary === '}') scopeDepth = Math.max(0, scopeDepth - 1);
    successfulCd = undefined;
    // A persistent directory stack makes nested scope saves constant-time, even after many pushd commands.
    if (boundary === '(') subshells.push({ directory, directoryCheck, stack: directoryStack });
    if (boundary === ')') {
      const parent = subshells.pop();
      directory = parent ? parent.directory : null;
      directoryCheck = parent?.directoryCheck;
      directoryStack = parent?.stack;
    }
    const texts = [], textWords = [];
    for (let i = 0; i < segment.length; i++) {
      if (segment[i].operator) {
        const operator = segment[i].text;
        const target = segment[++i];
        if (['>', '>>', '>|', '>&'].includes(operator) && target && !target.operator) add(target.text);
      } else if (!(/^\d+$/.test(segment[i].text) && segment[i + 1]?.operator && /^[<>]/.test(segment[i + 1].text))) { texts.push(segment[i].text); textWords.push(segment[i]); }
    }
    const allWords = [...texts];
    const parsed = commandWord(textWords, WRITER_PREFIXES);
    // Reserved words may follow negation and time. Inspect the command position, excluding its data arguments.
    for (const word of textWords.slice(0, parsed.index === undefined ? 1 : parsed.index + 1)) {
      if (word.quoted || word.joined) continue;
      if (['if', 'for', 'while', 'until', 'select', 'case'].includes(word.text)) scopeDepth++;
      else if (['fi', 'done', 'esac'].includes(word.text)) scopeDepth = Math.max(0, scopeDepth - 1);
    }
    const xargs = parsed.xargs;
    parsed.outputs?.forEach(path => add(path));
    if (parsed.opaque) { paths.push({ path: '.', unresolved: true, opaque: true }); continue; }
    if (parsed.index === undefined) {
      // Unknown wrapper options cannot establish a safe command word. Treat every possible target conservatively.
      allWords.filter(text => text && !text.startsWith('-')).forEach(path => add(path, false, true));
      continue;
    }
    texts.splice(0, parsed.index);
    const name = texts.shift()?.split('/').at(-1);
    const executable = ['bsdtar', 'xar'].includes(name) ? 'tar' : name === 'chdir' ? 'cd' : /^g(?:sed|cp|mv|install|tee|dd|truncate|ln|touch|rm|chmod|chown|chgrp|sort|uniq|unlink|shred|mkdir|find|split|tar|shuf|csplit|rmdir|mktemp|link|patch|awk|wget)$/.test(name) ? name.slice(1) : name;
    const operands = texts.filter(text => text && !text.startsWith('-'));
    if (executable === 'sed') for (const arg of texts) sedEffects(arg.replace(/^--expression=/, '').replace(/^-[nEr]*e/, '')).writes.forEach(path => add(path));
    argumentWritePaths(executable, texts).forEach(path => add(path));
    if (executable === 'tar' && (texts.some(arg => longOption(arg, '--create') || /^-[a-zA-Z]*c/.test(arg)) || /^[a-zA-Z]*c/.test(texts[0] ?? ''))) {
      for (let at = 0; at < texts.length; at++) {
        const arg = texts[at];
        if (longOption(arg, '--file')) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++at]);
        else if (/^-[^-]*f/.test(arg) || at === 0 && /^[a-zA-Z]*f/.test(arg)) add(arg.slice(arg.indexOf('f') + 1) || texts[++at]);
      }
    }
    // `sleight-mcp turbo on|off` writes turbo.json for the user, so a model's shell may not run it. Position-free on purpose:
    // env, nohup, timeout, interpreter flags and sh -c strings all reach it. Only `turbo status` passes. When in doubt, deny.
    // `hand on|off|capture` writes hand.json the same way, and only `hand status` passes. Character writes and the cursor
    // style are the user's commands too: only cursor list, check and status pass, an allow-list, so an argument the guard
    // can't read (a variable, a substitution, xargs input) is refused. `permissions block|unblock|revoke|sites` change what
    // sleight may do, and only the listing passes.
    // A read-only tool's segment can't run the launcher (grep -n hand .../launch.mjs, file .../sleight-mcp hand).
    if (allWords.some(word => word.includes('sleight') || word.includes('launch.mjs'))) {
      if (!(reads && readTool(segment))) for (const [command, allowed, file] of LAUNCHER_COMMANDS) {
        if (launcherToggle(allWords, command, allowed)) add(`~/Library/Application Support/sleight/${file}`, true);
      }
    }
    if (xargs && piped) operands.push(...piped.filter(word => !word.operator).map(word => word.text));
    if (platform !== 'win32' && ['eval', 'source', '.', 'trap'].includes(executable)) {
      if (executable === 'eval') {
        if (texts.some(text => /[$`]/.test(text)) && sourceProtectedTarget(texts.join(' '))) add('~/Library/Application Support/sleight', true);
        if (texts.length && !texts.some(text => /[$`]/.test(text))) {
          texts.forEach(path => add(path, false, true));
          paths.push(...shellWritePaths(texts.join(' '), directory, depth + 1, platform, undefined, directoryCheck));
        } else if (texts.some(text => /[$`]/.test(text)) && !texts.some(text => text.includes('$(') || text.includes('`')) &&
          !(texts.at(-1) === '$' && nextBoundary === '(')) paths.push({ path: '.', unresolved: true, opaque: true });
      } else if (executable === 'trap') {
        if (sourceProtectedTarget(texts.join(' '))) add('~/Library/Application Support/sleight', true);
        if (texts[0] && !['-', '-p', '-l'].includes(texts[0])) paths.push(...shellWritePaths(texts[0], null, depth + 1, platform));
      } else if (!texts[0] || /[$`*?]|^\/dev\//.test(texts[0]) || nextBoundary === '(') paths.push({ path: '.', unresolved: true, opaque: true });
      else if (unknownDirectoryTarget(texts[0])) add(texts[0], false, true);
      // Sourced or evaluated code can change cwd. A trap's body can run after later directory changes too.
      directory = null; directoryCheck = undefined;
    } else if (SHELLS.has(executable) && segment.some(word => word.operator && word.text === '<<<')) {
      // A here-string is shell source, with the same cwd and destination checks as a -c script.
      const at = segment.findIndex(word => word.operator && word.text === '<<<');
      const body = segment[at + 1]?.text;
      if (body) paths.push(...shellWritePaths(body, directory, depth + 1, platform, undefined, directoryCheck));
    }
    if (executable === 'cd' || executable === 'pushd') {
      const next = operands[0];
      if (executable === 'pushd') directoryStack = { directory, directoryCheck, next: directoryStack };
      const unknown = texts.some(arg => arg === '-' || /^[-+]\d|^-n/.test(arg)) || executable === 'pushd' && !next ||
        next && /[$`*?[{]|^~[^/]|\n/.test(next.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, '~')) ||
        operands.length > 1 || cdpath || homeAssigned && (!next || /^(?:~|\$HOME|\$\{HOME\})/.test(next)) ||
        parsed.keyword || scopeDepth > 0 || ['{', '}'].includes(boundary) || segment.some(word => word.operator && word.text === '(');
      if (unknown) directory = null;
      else if (!next) directory = '~';
      else if (/^(?:\/|~|\$HOME|\$\{HOME\})/.test(next)) directory = next;
      else if (directory !== null) directory = directory ? `${directory}/${next}` : next;
      // A long cwd makes every following resolution expensive. Unknown relative writes fail closed instead.
      if (directory?.length > 1024) directory = null;
      directoryCheck = directory === null ? undefined : { path: directory, created: created.has(normalize(directory)), previous: next && !/^(?:\/|~|\$HOME|\$\{HOME\})/.test(next) ? directoryCheck : undefined };
      successfulCd = { directory, directoryCheck };
      // In `A || cd B && write`, write can run after A succeeded and cd B was skipped.
      if (boundary === '||') successfulCd = { directory: null };
      if (['&&', '||'].includes(boundary)) conditionalCd = true;
      // A cd in a conditional, pipeline or background job cannot establish the parent's cwd for a later command.
      if (['&&', '||', '&', '|', '|&'].includes(boundary) || ['&', '|', '|&'].includes(nextBoundary)) {
        directory = null; directoryCheck = undefined;
        if (['&', '|', '|&'].includes(boundary) || ['&', '|', '|&'].includes(nextBoundary) || scopeDepth > 0 || parsed.keyword) successfulCd = undefined;
        if (executable === 'pushd') directoryStack = undefined;
      }
    } else if (executable === 'popd') {
      directory = texts.length || !directoryStack ? null : directoryStack.directory;
      directoryCheck = texts.length ? undefined : directoryStack?.directoryCheck;
      directoryStack = directoryStack?.next;
      if (parsed.keyword || scopeDepth > 0 || ['{', '}', '&&', '||', '&', '|', '|&'].includes(boundary) || ['&', '|', '|&'].includes(nextBoundary)) {
        directory = null; directoryCheck = undefined; directoryStack = undefined;
      }
    } else if (SHELLS.has(executable) && texts.some(text => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(text))) {
      // -c alone or in a flag group (-lc, -ic): the script is the next word.
      const source = shellScript([executable, ...texts], 0) ?? '';
      if (xargs && piped && source.includes('{}')) { const target = sourceProtectedTarget(piped.map(word => word.text).join(' ')); if (target) add('~/Library/Application Support/sleight', true); }
      paths.push(...shellWritePaths(source, directory, depth + 1, platform, undefined, directoryCheck));
      // A missing quoting layer can split "Application Support" into operands. Check the intact spelling for writers.
      const leading = source.trimStart().replace(/^(?:(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh)\s+-[a-zA-Z]+\s+["']?)+/, '');
      if (/^(?:touch|tee|cp|mv|rm|sed|chmod|dd|truncate|ln)\s/.test(leading) && sourceProtectedTarget(command)) add('~/Library/Application Support/sleight', true);
    } else if (SHELLS.has(executable) && nextBoundary === '(' && segment.some(word => word.operator && word.text === '<')) {
      if (sourceProtectedTarget(command)) add('~/Library/Application Support/sleight', true);
    } else if (['cp', 'install', 'rsync', 'ln', 'mv'].includes(executable)) {
      const copyWords = xargs && piped ? [...texts, ...piped.filter(word => !word.operator).map(word => word.text)] : texts;
      const { operands: files, targets, links, linkDestinations } = copyArguments(executable, copyWords);
      if (executable === 'ln' || links) files.slice(0, targets.length ? files.length : -1).forEach(path => add(path, false, true));
      linkDestinations.forEach(path => add(path, false, true));
      if (executable === 'mv') files.forEach((path, at) => add(path, false, at < files.length - 1 || targets.length > 0));
      const contents = executable === 'rsync' || executable === 'cp' && texts.some(arg => /^-[^-]*[Rr]/.test(arg)) && files.slice(0, -1).some(arg => arg.endsWith('/'));
      if (targets.length) targets.forEach(target => destination(target, files, contents));
      else destination(files.at(-1), files.slice(0, -1), contents);
    } else if (['rm', 'unlink', 'shred', 'mkdir', 'rmdir', 'mktemp'].includes(executable)) {
      operands.forEach(path => add(path, false, !['mkdir', 'mktemp'].includes(executable)));
      if (executable === 'mktemp') operands.filter(path => path.includes('/')).forEach(path => add(path.slice(0, path.lastIndexOf('/')), false, true));
      if (executable === 'mkdir' && directory && scopeDepth === 0 && !['||', '|', '|&', '&'].includes(boundary))
        operands.filter(path => !/[$`*?{]/.test(path)).forEach(path => created.add(normalize(path.startsWith('/') ? path : directory + '/' + path)));
    }
    else if (['chmod', 'chown', 'chgrp', 'chflags'].includes(executable)) operands.forEach(path => add(path, false, texts.some(arg => /^-[^-]*R/.test(arg))));
    else if (executable === 'find' && texts.some((arg, at) => arg === '-delete' ||
      ['-exec', '-execdir', '-ok', '-okdir'].includes(arg) && FIND_WRITERS.has(texts[at + 1]?.split('/').at(-1)))) {
      // find's search roots come before its first expression; a protected name anywhere in the expression denies too.
      const start = texts.findIndex(arg => !['-H', '-L', '-P'].includes(arg)), end = texts.findIndex((arg, at) => at >= start && /^[-(!]/.test(arg));
      const roots = texts.slice(start, end < 0 ? texts.length : end);
      for (const root of roots.length ? roots : ['.']) add(root, false, true);
      if (texts.some(arg => PROTECTED_NAME.test(arg))) add('~/Library/Application Support/sleight', true);
    } else if (executable === 'tar' && (texts.some(arg => longOption(arg, '--extract') || longOption(arg, '--get') || /^-[a-zA-Z]*x/.test(arg)) || /^[a-zA-Z]*x/.test(texts[0] ?? ''))) {
      // An archive unpacked into a folder can write any file under it. Long-option prefixes count too.
      for (let i = 0; i < texts.length; i++) {
        const arg = texts[i];
        if (longOption(arg, '--directory') || longOption(arg, '--cd') || longOption(arg, '--one-top-level')) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++i], false, true);
        else if (/^-[^-]*C/.test(arg)) add(arg.slice(arg.indexOf('C') + 1) || texts[++i], false, true);
      }
      if (texts.some(arg => longOption(arg, '--transform') || longOption(arg, '--xform')) && sourceProtectedTarget(texts.join(' '))) add('~/Library/Application Support/sleight', true);
    } else if (executable === 'cpio') {
      const creates = texts.some(arg => /^-[^-]*o/.test(arg) || longOption(arg, '--create'));
      let passThrough = false, links = false;
      for (let at = 0; at < texts.length; at++) {
        const arg = texts[at];
        if (arg === '--') break;
        if (longOption(arg, '--pass-through')) passThrough = true;
        if (longOption(arg, '--link')) links = true;
        if (/^-[^-]/.test(arg)) for (let flag = 1; flag < arg.length; flag++) {
          passThrough ||= arg[flag] === 'p'; links ||= arg[flag] === 'l';
          // These cpio options consume the rest of this word or the next one, never more flags.
          if ('CDFHILOR'.includes(arg[flag])) { if (flag === arg.length - 1) at++; break; }
        }
        if (['--block-size', '--file', '--format', '--owner', '--pattern-file', '--directory', '--rsh-command']
          .some(option => longOption(arg, option) && !arg.includes('='))) at++;
      }
      for (let at = 0; at < texts.length; at++) {
        const arg = texts[at];
        if (arg === '--') break;
        if (longOption(arg, '--directory')) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++at], false, true);
        else if (/^-[^-]*D/.test(arg)) add(arg.slice(arg.indexOf('D') + 1) || texts[++at], false, true);
        else if (creates && longOption(arg, '--file')) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++at]);
        else if (creates && /^-[^-]*[FO]/.test(arg)) { const pos = arg.search(/[FO]/); add(arg.slice(pos + 1) || texts[++at]); }
      }
      // Pass-through link mode creates aliases of names read from stdin. Inspect visible pipe operands as sources;
      // a list loaded from a file or generated by opaque code remains outside this literal-path check.
      if (passThrough && links && piped) for (const word of piped) {
        if (!word.operator) for (const path of word.text.split(/[\n\0]/)) add(path, false, true);
      }
    } else if (executable === 'ar' && /^-?[a-z]*[rdqms][a-z]*$/i.test(texts[0] ?? '')) add(operands[0] === texts[0] ? operands[1] : operands[0]);
    else if (executable === 'hdiutil' && texts[0] === 'create') operands.slice(1).forEach(path => add(path));
    else if (['7z', '7za', '7zz'].includes(executable)) {
      for (const arg of texts) if (arg.startsWith('-o')) add(arg.slice(2), false, true);
      if (['a', 'u'].includes(texts[0])) add(operands[1]);
    } else if (['zip', 'pax'].includes(executable)) {
      if (executable === 'zip') {
        add(operands[0]);
        for (let at = 0; at < texts.length; at++) {
          const arg = texts[at];
          if (longOption(arg, '--out')) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++at]);
          else if (arg.startsWith('-O')) add(arg.slice(2) || texts[++at]);
        }
      } else {
        const { operands: files, links, passThrough } = copyArguments('pax', texts);
        if (passThrough) {
          if (links) files.slice(0, -1).forEach(path => add(path, false, true));
          destination(files.at(-1), files.slice(0, -1), true);
        } else if (texts.some(arg => /^-[^-]*w/.test(arg))) {
          for (let at = 0; at < texts.length; at++) if (/^-[^-]*f/.test(texts[at])) add(texts[at].slice(texts[at].indexOf('f') + 1) || texts[++at]);
        }
      }
    } else if (executable === 'unzip') {
      for (let at = 0; at < texts.length; at++) if (/^-[^-]*d/.test(texts[at])) add(texts[at].slice(texts[at].indexOf('d') + 1) || texts[++at], false, true);
    }
    else if (executable === 'ditto') add(operands.at(-1), false, true);
    else if (['curl', 'wget'].includes(executable)) {
      const writeOut = format => { for (const match of (format ?? '').matchAll(/%output\{(?:>>)?([^}]+)\}/g)) add(match[1]); };
      const executeOutput = value => {
        const match = /^(logfile|dir_prefix|output_document|hsts_file|warc_file|rejected_log)=(.*)$/s.exec(value ?? '');
        if (match) add(match[2], false, match[1] === 'dir_prefix');
      };
      for (let i = 0; i < texts.length; i++) {
        const arg = texts[i], directoryOption = executable === 'curl' ? '--output-dir' : '--directory-prefix';
        const fileOption = executable === 'curl' ? '--output' : '--output-document';
        const extraFiles = executable === 'curl' ? ['--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--libcurl', '--dump-header', '--etag-save', '--hsts', '--alt-svc', '--ssl-sessions'] : ['--append-output', '--output-file', '--save-cookies', '--hsts-file', '--warc-file', '--rejected-log'];
        const directory = longOption(arg, directoryOption), file = longOption(arg, fileOption);
        if (executable === 'curl' && (arg === '-w' || longOption(arg, '--write-out') || /^-w./.test(arg))) {
          const format = arg === '-w' || arg === '--write-out' ? texts[++i] : arg.startsWith('--') ? arg.slice(arg.indexOf('=') + 1) : arg.slice(2);
          writeOut(format);
        } else if (executable === 'wget' && (arg === '-e' || arg.startsWith('-e') || longOption(arg, '--execute'))) {
          const value = arg === '-e' || arg === '--execute' ? texts[++i] : arg.startsWith('--') ? arg.slice(arg.indexOf('=') + 1) : arg.slice(2);
          executeOutput(value);
        } else if (directory || file) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++i], false, directory);
        else if (extraFiles.some(option => longOption(arg, option))) add(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : texts[++i]);
        else if (executable === 'curl' && /^-[^-]/.test(arg)) {
          for (let at = 1; at < arg.length; at++) {
            if (arg[at] === 'w') { writeOut(arg.slice(at + 1) || texts[++i]); break; }
            if ('AbdeEFHKmQrtTuUxXyYz'.includes(arg[at])) { if (!arg.slice(at + 1)) i++; break; }
            if ('oDc'.includes(arg[at])) { add(arg.slice(at + 1) || texts[++i]); break; }
            if (arg[at] === 'O') {
              // -O takes no value. Retain the old conservative operand check without consuming --output-dir.
              if (texts[i + 1] && !texts[i + 1].startsWith('-')) add(texts[i + 1]);
            }
          }
        }
        else if (executable === 'wget' && /^-[^-]/.test(arg)) {
          for (let at = 1; at < arg.length; at++) {
            if ('oOaP'.includes(arg[at])) { add(arg.slice(at + 1) || texts[++i], false, arg[at] === 'P'); break; }
            if (arg[at] === 'e') { executeOutput(arg.slice(at + 1) || texts[++i]); break; }
            if ('tTiU'.includes(arg[at])) { if (!arg.slice(at + 1)) i++; break; }
          }
        }
      }
    } else if (executable === 'git' && texts[0] === 'clone') {
      const target = operands.at(-1); add(target, false, true);
      if (directory && target && operands.length >= 3 && !/[$`*?{]/.test(target) && scopeDepth === 0 && !['||', '|', '|&', '&'].includes(boundary)) created.add(normalize(target.startsWith('/') ? target : directory + '/' + target));
    } else if (executable === 'git' && ['checkout', 'restore', 'apply'].includes(texts[0])) operands.slice(1).forEach(path => add(path));
    else if (executable === 'patch') operands.forEach(path => add(path));
    else if (['tee', 'truncate', 'touch', 'split', 'link', 'csplit', 'shuf'].includes(executable) ||
      (executable === 'sed' && (texts.some(sedInPlace) || texts.some(text => /\$\(|`/.test(text)))) ||
      (executable === 'awk' && texts.some(arg => arg === 'inplace' || arg === '-iinplace' || arg === '--include=inplace')) ||
      (executable === 'perl' && texts.some(arg => /^-[^-]*i/.test(arg))) ||
      (executable === 'defaults' && ['write', 'delete', 'import'].includes(texts[0]))) operands.forEach(path => add(path));
    else if (executable === 'plutil' && texts.some(arg => ['-replace', '-insert', '-remove', '-convert'].includes(arg))) {
      add(texts.includes('-o') ? texts[texts.indexOf('-o') + 1] : operands.at(-1));
    } else if (executable === 'dd') texts.filter(arg => arg.startsWith('of=')).forEach(arg => add(arg.slice(3)));
    else if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable ?? '') || ['node', 'ruby', 'perl'].includes(executable)) {
      const flag = texts.findIndex(arg => /^python/.test(executable) ? /^-c/.test(arg) : executable === 'perl' ? /^-\w*[eE]$/.test(arg) : /^-e|^--eval(?:=|$)/.test(arg));
      if (flag < 0) continue;
      const option = texts[flag], source = ['-c', '-e', '--eval'].includes(option) || executable === 'perl' ? texts[flag + 1] ?? '' : option.replace(/^(?:-[ce]|--eval=)/, '');
      // Code that loads sleight's own writers can change permissions.json or the always list without naming either file.
      if (/\b(?:permissions-command|preapproved)\.mjs\b/i.test(source)) { add('~/Library/Application Support/sleight', true); continue; }
      // The first open( in each disjoint closing-parenthesis span decides whether any later mode can match.
      // This preserves the old open([^)]*, mode) language, including '(' in quoted paths, without repeated suffix scans.
      const writes = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|rm(?:Sync)?|remove|truncate|File\.write)\s*\(|\b(?:unlink|rename|chmod|chown|rmtree|move|symlink)\b/.test(source) ||
        source.split(')').some(span => {
          const open = /\bopen\s*\(/.exec(span);
          return open && /,\s*(?:mode\s*=\s*)?['"][wax][+bt]*['"]/.test(span.slice(open.index + open[0].length));
        });
      if (!writes) continue;
      // Maximal disjoint spans are scanned once. Never restart a suffix search at every slash or tilde.
      for (const span of source.matchAll(/[^'"`;\n()<>|]+/g)) {
        const text = span[0], root = /[a-z]:[\\/]|%LOCALAPPDATA%[\\/]|\$env:LOCALAPPDATA[\\/]|~|\$\{?HOME\}?|\/|\.{1,2}\//i.exec(text);
        const name = PROTECTED_NAME.exec(text);
        if (name) add(text.slice(root && root.index < name.index ? root.index : name.index, name.index + name[0].length), true);
        if (root) {
          // A preceding ordinary filename must not hide a later protected suffix in the same span.
          for (const { pattern, length } of inlineSuffixes) {
            const at = text.search(pattern);
            if (at >= root.index) add(text.slice(root.index, at + length), true);
          }
          const tree = /\/(?:library\/(?:caches|application support)|plugins\/cache\/[^/'"`;\n()<>|]+)\/sleight(?=\/|\s|$)/i.exec(text);
          if (tree) add(text.slice(root.index, tree.index + tree[0].length), true);
          const path = text.slice(root.index).trimEnd();
          if (/sleight|sleight-bench/i.test(path)) add(path, true);
        }
      }
    }
  }
  return paths;
}

/** The protected target or matched shell text rule, or undefined. */
export async function preapprovedWriteTarget(input, options) {
  const { tool } = input;
  const shell = tool === 'Bash' || tool === 'PowerShell';
  // One timeout ends metadata work for this decision. Missing paths are distinct from unavailable metadata.
  // The mod supplies its host clock; Node callers may use the ordinary timer fallback.
  let exhausted = false, unavailable = false;
  if (typeof options?.stat === 'function') {
    const stat = options.stat, cache = new Map();
    const after = options.after ?? (typeof setTimeout === 'function' ? (ms, fn) => {
      const timer = setTimeout(fn, ms); return { cancel: () => clearTimeout(timer) };
    } : undefined);
    const unknown = { unknown: true };
    options = { ...options, stat: path => {
      // The hook always passes cwd, even when unavailable. Callers omitting it retain their stat provider's contract.
      if (!/^(?:\/|[a-z]:[\\/])/i.test(path)) {
        if ('cwd' in options && !options.cwd) return Promise.resolve(unknown);
        if (options.cwd) path = options.cwd.replace(/[\\/]$/, '') + '/' + path;
      }
      if (cache.has(path)) return cache.get(path);
      if (cache.size >= 2048) { exhausted = true; return Promise.resolve(unknown); }
      if (unavailable || !after) return Promise.resolve(unknown);
      const result = new Promise(resolve => {
        let settled = false, timer;
        const finish = info => { if (settled) return; settled = true; timer?.cancel(); resolve(info); };
        try {
          timer = after(100, () => { unavailable = true; finish(unknown); });
          Promise.resolve().then(() => stat(path)).then(finish, error => {
            if (['ENOENT', 'ENOTDIR'].includes(error?.code)) finish(undefined);
            else { unavailable = true; finish(unknown); }
          });
        } catch { unavailable = true; finish(unknown); }
      });
      cache.set(path, result);
      return result;
    } };
  }
  let paths;
  if (mutations.has(tool)) {
    paths = [input.file_path, input.notebook_path, ...(Array.isArray(input.edits) ? input.edits.map(edit => edit?.file_path) : [])];
  } else if (shell && typeof input.command === 'string') {
    // This bounded lexical check runs before substitutions, heredocs, tokenization or filesystem probes.
    if (input.command.length > MAX_PROTECTED_COMMAND) return oversizedProtectedCommand(input.command) ? PROTECTED.oversized : undefined;
    const commands = [input.command];
    if (tool === 'Bash') commands.push(...bashSubstitutionCode(quotedHeredocs(input.command).command));
    paths = [];
    for (const command of commands) {
      const sources = heredocSources(command);
      for (const source of sources) {
        const target = sourceProtectedTarget(source);
        if (target) return target;
      }
      const words = shellWords(command);
      const launcherRefusal = launcherRefused(command, 0, false, { words, sources, sourcesChecked: true });
      if (launcherRefusal) return launcherRefusal === PROTECTED.replay ? PROTECTED.replay : PROTECTED.launcher;
      if ((options?.platform ?? runtimePlatform) === 'win32') {
        const match = windowsCacheWrite(command);
        if (match) return match;
      } else if (tool === 'PowerShell') {
        const encoded = windowsEncodedCommand(command);
        if (encoded) return encoded;
        // POSIX PowerShell has cmdlets and aliases the Bash write parser cannot recognize. Keep Bash unchanged.
        const text = command.replace(/[`^'"+]/g, '');
        const reading = windowsLiteralRead(command.replace(/\$\{HOME\}|\$HOME\b/gi, '/home'));
        // PowerShell can resolve wildcard cache names and Set-Location separately from the write cmdlet.
        const libraryGlob = /[*?\[]/.test(text) && /\blibrary\/(?:caches|application(?:\s|\\|[*?\[]))/i.test(text);
        if (!reading && (/sleight|application support/i.test(text) || PROTECTED_NAME.test(text) || libraryGlob)) return PROTECTED.settings;
      }
      const data = quotedHeredocs(command);
      for (const body of data.bodies) { const target = sourceProtectedTarget(body); if (target) return target; }
      paths.push(...shellWritePaths(command, options && 'cwd' in options ? options.cwd ?? null : undefined, 0, options?.platform, shellWords(data.command)));
    }
  } else return undefined;
  const checkedDirectories = new WeakMap();
  const directoryExists = async check => {
    const pending = [];
    while (check && !checkedDirectories.has(check)) { pending.push(check); check = check.previous; }
    let exists = !check || checkedDirectories.get(check);
    for (const node of pending.reverse()) {
      const expanded = node.path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => options?.home ?? '/~');
      try {
        const parentTraversal = /(?:^|\/)\.\.(?:\/|$)/.test(expanded);
        const info = exists && (node.created && !parentTraversal ? { realPath: expanded } : await options?.stat?.(expanded));
        exists = typeof info?.realPath === 'string' && info.realPath.length > 0;
        // cd -L normalizes parents before resolving links, while realpath resolves links first. A disagreement is unknown.
        if (exists && parentTraversal) {
          const logical = await options?.stat?.(normalize(expanded));
          exists = typeof logical?.realPath === 'string' && normalize(logical.realPath) === normalize(info.realPath);
        }
        node.realPath = info?.realPath;
      } catch { exists = false; }
      checkedDirectories.set(node, exists);
    }
    return exists;
  };
  for (const candidate of paths) {
    if (shell && candidate.unresolved) {
      // Explicit opaque-program sentinels refuse independently of cwd. Relative writes use the name-limited rule.
      if (candidate.opaque || unknownDirectoryTarget(candidate.path)) return candidate.opaque ? PROTECTED.unresolved : PROTECTED.unknownDirectory;
      continue;
    }
    if (shell && candidate.directoryCheck && !await directoryExists(candidate.directoryCheck)) {
      if (unknownDirectoryTarget(candidate.relativePath ?? candidate.path)) return PROTECTED.unknownDirectory;
      continue;
    }
    const { literalOnly, ancestor } = shell ? candidate : {};
    let path = shell ? candidate.path : candidate;
    if (shell && candidate.directoryCheck?.realPath) {
      const { directoryCheck: check } = candidate;
      if (path.startsWith(check.path + '/')) path = check.realPath + path.slice(check.path.length);
    }
    if (typeof path !== 'string') continue;
    // A short-name write through an opaque shell root may be the managed executable. This concerns write targets only;
    // product names in arguments, messages and ordinary paths never enter this branch.
    if (tool === 'Bash' && /(?:^|\/)sleight$/i.test(path) && /[$`]/.test(path.replace(/^\$(?:HOME|\{HOME\})(?=\/)/, ''))) return PROTECTED.unresolved;
    // Check missing expansion roots before the literal-only/whitespace shortcut.
    // Read-only shell operands never enter this list, so an unset HOME permits ls.
    if (!options?.home && /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.test(path) ||
        !options?.configDir && /^(?:\$CLAUDE_CONFIG_DIR|\$\{CLAUDE_CONFIG_DIR\})(?=\/|$)/.test(path)) return PROTECTED.unresolved;
    if (shell) {
      const literal = await literalLabel(path, options, ancestor);
      if (literal) return literal;
      const folder = globFolder(path), inFolder = folder && await literalLabel(folder, options, ancestor);
      if (inFolder) return inFolder;
      if (folder && PROTECTED_NAME.test(path) && /application(?:\s|\\)*support/i.test(path)) return PROTECTED.settings;
      // Inline code's paths stay text, except under sleight-bench, where the arm's links make the real target count.
      if ((literalOnly || path.length >= 512) && !underBench(path, options?.home)) continue;
    }
    const label = await protectedPath(path, options, ancestor);
    if (exhausted) return PROTECTED.unresolved;
    if (label) return label;
  }
  return exhausted ? PROTECTED.unresolved : undefined;
}
export const preapprovedWriteDenied = async (input, options) => !!await preapprovedWriteTarget(input, options);
/** The refusal Claude gets, naming what the call reached. */
export const preapprovedWriteReason = label => label === PROTECTED.unknownDirectory
  ? 'Unknown directory before a write to a protected name. Use an absolute ordinary path.'
  : label === PROTECTED.unresolved
  ? guardPathReason
  : label === PROTECTED.oversized
  ? `This command exceeds ${MAX_PROTECTED_COMMAND} characters and is outside the literal read-only allowance. Split it into smaller commands.`
  : label === PROTECTED.replay
  ? 'Use the replay tool in this session. The shell cannot start a separate replay or recording.'
  : Object.values(WINDOWS_MATCHES).includes(label)
  ? `This command ${label}. Only the user changes sleight's helper cache. Ask them to make this change.`
  : `Only the user changes ${label}. Ask them to make this change.`;

// SLEIGHT_ACTION_LOG and SLEIGHT_OUTCOMES are the user's switches. Claude's file and shell tools may not set them where
// sleight's MCP server reads its environment: Claude Code settings, MCP configs, the plugin's own manifest and launcher,
// shell startup files, launchd. This catches mistakes and the plain ways around it, not a determined agent: a script
// Claude writes and then runs, a symlinked config path, or another MCP server's shell tool all get past it
// (docs/known-problems.md).
// The switches' stems, so an edit of part of a name counts; matched after JSON and shell escapes and quotes are folded out.
const SWITCHES = /OUTCOMES|ACTION_LOG/;
const unescaped = (text, concatenate = true) => {
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (_, u, x) => String.fromCharCode(parseInt(u ?? x, 16)));
  return (concatenate ? decoded.replace(concatenate === 'js' ? /['"]\s*\+\s*['"]/g : /['"]\s*(?:\+\s*)?['"]/g, '') : decoded).replace(/['"\\]/g, '');
};
const switched = text => typeof text === 'string' && SWITCHES.test(unescaped(text));
// Paths are matched lowercased (folded).
const CONFIG = /(?:^|\/)(?:\.claude\/[^/]*\.json|\.claude\.json|\.?mcp\.json|managed-settings\.json|settings(?:\.local)?\.json|\.claude-plugin\/plugin\.json|bin\/sleight(?:-mcp)?|launchagents\/[^/]+\.plist|\.config\/fish\/(?:[^/]+\/)*[^/]+\.fish|\.(?:zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile|envrc)|\.zshrc\.d\/[^/]+)$/;
const CONFIG_TEXT = /(?:settings(?:\.local)?|\.claude|mcp|managed-settings|plugin)\.json|\.plist\b|\.fish\b|\.(?:zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile|envrc)\b/;
// Commands that can write a file they name in their own text. awk only with an output redirect, a pipe or system().
const SETTERS = /\b(?:claude\s+(?:mcp|config)|launchctl\s+setenv|python\d*(?:\.\d+)?|node|ruby|perl|jq|plutil|defaults|osascript)\b|\bg?awk\b[^\n]*(?:>|\||\bsystem\s*\()/;
export function loggingSwitchWriteDenied(input) {
  const { tool } = input ?? {};
  if (mutations.has(tool)) {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const texts = [input.content, input.new_string, input.new_source, ...edits.map(edit => edit?.new_string)];
    const paths = [input.file_path, input.notebook_path, ...edits.map(edit => edit?.file_path)];
    return texts.some(switched) && paths.some(path => typeof path === 'string' && CONFIG.test(folded(normalize(path))));
  }
  if (tool !== 'Bash' || !switched(input.command)) return false;
  const { command } = input, candidates = [command, unescaped(command), unescaped(command, false), unescaped(command, 'js')];
  // Keep the raw spelling and argument spaces too: folding adjacent literals can join separate shell arguments.
  if (candidates.some(text => /\blaunchctl\s+setenv\b|\bclaude\s+(?:mcp|config)\b/.test(text))) return true;
  if (command.length > MAX_PROTECTED_COMMAND) return oversizedProtectedCommand(command) || CONFIG_TEXT.test(folded(unescaped(command)));
  // A write to a config file, or an interpreter or editor tool run with one named: reads such as grep pass.
  return shellWritePaths(command).some(({ path }) => CONFIG.test(folded(normalize(path)))) ||
    // Each test on its own spelling: a fold that reaches the path can join the interpreter's name onto the argument before it
    // (Python's and Ruby's adjacent literals), and the raw spelling keeps the name but not the path.
    candidates.some(text => CONFIG_TEXT.test(text)) && candidates.some(text => SETTERS.test(text));
}
