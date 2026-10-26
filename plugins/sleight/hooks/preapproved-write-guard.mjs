const directorySuffix = '/library/application support/sleight';
// grant-seal.key seals the Electron Always records in electron-grants.json; writing it would forge consent. hand.json is the
// user's ghost hand opt-out. permissions.json holds the apps and sites the user told sleight never to act in. turbo-owner.json
// names the copy that issued turbo.json's receipt, which decides whether a startup may move it.
const suffixes = ['preapproved.json', 'turbo.json', 'turbo-apps.json', 'turbo-owner.json', 'electron-grants.json', 'grant-seal.key', 'hand.json', 'permissions.json'].map(filename => `${directorySuffix}/${filename}`);
const mutations = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const folded = path => path.normalize('NFC').toLowerCase();
// Everything under these folders is sleight's own code: the helper cache (the consent host that answers sleight's cards and
// its Touch ID confirmation, built from source) and installed copies of the plugin in Claude Code's, Codex's and Cursor's
// plugin caches (<host>/plugins/cache/<marketplace>/sleight). Swapping either would change the checks themselves. A plugin
// loaded from a working checkout is left alone, so its source stays editable. So is a real folder under
// ~/Library/Caches/sleight-bench (the benchmark's throwaway configs), once its path resolves there (benchExempt). The arm
// links its plugins folder to the real cache, so a plugins folder under sleight-bench never counts as the bench's own; the
// arm loads sleight with --plugin-dir, so nothing there needs writing.
const TREES = [/\/library\/caches\/sleight(?:\/|$)/, /\/plugins\/cache\/[^/]+\/sleight(?:\/|$)/];
// What each refusal names, so the person knows which protected folder the command reached.
export const PROTECTED = Object.freeze({
  settings: "sleight's settings files (~/Library/Application Support/sleight)",
  cache: "sleight's helper cache (~/Library/Caches/sleight)",
  install: 'an installed copy of the sleight plugin',
  aboveSleight: "a folder that holds sleight's settings or helper cache",
  aboveInstall: 'a folder that holds an installed copy of sleight',
  launcher: "sleight's settings through its launcher",
});
const protectedLiteral = path => {
  const value = folded(normalize(path));
  if (suffixes.some(suffix => value.endsWith(suffix)) || value.endsWith(directorySuffix)) return PROTECTED.settings;
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
const above = (path, home) => {
  const root = home ?? '/~', value = folded(normalize(path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => root)));
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
  const label = protectedLiteral(path) ?? (ancestor ? above(path, options?.home) ?? await aboveInstall(path, options) : undefined);
  return [PROTECTED.install, PROTECTED.aboveInstall].includes(label) && await benchExempt(path, options) ? undefined : label;
};

// Resolve before normalizing: a symlink followed by .. walks from its target.
async function protectedPath(path, options, ancestor = false) {
  const { stat, home } = options ?? {};
  if (typeof path !== 'string' || !path || path.length > 4096) return undefined;
  const literal = await literalLabel(path, options, ancestor);
  if (literal) return literal;
  if (home) path = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home);
  let resolved = (await stat(path.startsWith('/') ? '/' : '.').catch(() => undefined))?.realPath;
  // An unavailable root cannot establish that an alias is outside the protected
  // trees. Refuse instead of allowing a tool the host may still execute.
  if (!resolved) return PROTECTED.settings;
  for (const part of path.split('/').filter(Boolean)) {
    const next = `${resolved.replace(/\/$/, '')}/${part}`;
    const info = await stat(next).catch(() => undefined);
    if (info && typeof info.realPath !== 'string') return PROTECTED.settings;
    resolved = info?.realPath ?? normalize(next);
  }
  // configDir too: a link to a custom CLAUDE_CONFIG_DIR resolves to it, and its folders above an install still count.
  return literalLabel(resolved, options, ancestor);
}

// Only literal shell names and operators, never eval or shell expansion. Keep
// operators inside quotes as text, and join quoted/escaped pieces of a word.
function shellWords(command) {
  const words = [];
  let word = '', quote = '', active = false, quotes = 0, escapes = false, bare = false;
  const flush = () => {
    if (active) words.push({ text: word, ...escapes || quotes > 1 || quotes && bare ? { joined: true } : {} });
    word = ''; active = false; quotes = 0; escapes = false; bare = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") {
      const escaped = command[++i] ?? '';
      if (escaped !== '\n') { active = true; escapes = true; word += escaped; }
    }
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; active = true; quotes++; }
    else if (c === '\n') { flush(); words.push({ text: ';', operator: true }); }
    else if (/\s/.test(c)) flush();
    else if (';&|<>()'.includes(c)) {
      flush();
      const pair = c + (command[i + 1] ?? '');
      const operator = ['>>', '>|', '>&', '<<', '&&', '||', '|&'].includes(pair) ? (i++, pair) : c;
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
const PROTECTED_NAME = /(?:preapproved|turbo|turbo-apps|turbo-owner|electron-grants|hand|permissions)\.json|grant-seal\.key/i;
const launcher = name => name === 'sleight-mcp' || name === 'launch.mjs';
const commandArgument = value => value.replace(/^['"]+|[;&|)'"]+$/g, '');
// True when the words run the launcher's command with arguments `allowed` refuses (by default anything but status), as
// separate words or inside a -c string, where the arguments run to the next shell operator.
const statusOnly = rest => rest[0] === 'status';
function launcherToggle(words, command, allowed = statusOnly) {
  const names = words.map(word => word.split('/').at(-1)), first = names.findIndex(launcher);
  if (first >= 0) {
    const at = names.indexOf(command, first + 1);
    if (at >= 0 && !allowed(names.slice(at + 1).map(commandArgument))) return true;
  }
  return words.some(word => {
    if (!/\s/.test(word)) return false;
    const hit = /(?<![\w.-])(?:\S*\/)?(?:sleight-mcp|launch\.mjs)(?=[\s'"]|$)/.exec(word);
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
  ['permissions', listingOnly, 'permissions.json']];
// Fail closed. A Bash command that names the launcher (sleight-mcp or launch.mjs) beside one of these subcommand words passes
// only as a plain direct invocation of a read-only form: literal arguments, and no expansion, substitution, glob, brace,
// redirection, heredoc, subshell, xargs, parallel or eval anywhere in it. Any other spelling is refused, except read-only
// tools (grep, cat, git log) that can't run anything. The guard doesn't try to read what the shell would make of it.
const LAUNCHER_NAME = /sleight-mcp|launch\.mjs/;
const SUBCOMMAND = /(?<![\w-])(?:hand|turbo|permissions|cursor)(?![\w.-])/; // not turbo.json or hand.json
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
};
const PREFIXES = new Set(Object.keys(PREFIX_OPTIONS));
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
  return i;
}
// The segment's command word, after assignments and prefixes such as env or nohup (with their known options).
// assigned: an assignment came first, which can change what the command word runs (PATH, GIT_PAGER).
function commandWord(segment, prefixes = PREFIXES) {
  let assigned = false;
  for (let i = 0; i < segment.length;) {
    if (segment[i].operator) return { unreadable: true };
    const text = segment[i].text, name = text.split('/').at(-1);
    if (/^[A-Za-z_]\w*=/.test(text)) { assigned = true; i++; continue; }
    if (prefixes.has(name)) {
      i = prefixEnd(segment, i + 1, PREFIX_OPTIONS[name]);
      if (i < 0) return { unreadable: true };
      continue;
    }
    return { index: i, unreadable: UNREADABLE_WORD.test(text) || segment[i].joined === true, assigned };
  }
  return { assigned };
}
const READ_FORMS = ['hand status', 'turbo status', 'permissions', 'permissions list', 'cursor list', 'cursor status', 'runs list'];
const readForm = args => args.length === 3 && args[0] === 'runs' && args[1] === 'open' && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{32}$/.test(args[2]) || READ_FORMS.includes(args.join(' ')) || args.length === 3 && args[0] === 'cursor' && args[1] === 'check' && /^[\w-]{1,64}$/.test(args[2]);
// The launcher run directly, or by node with -- options, with literal arguments in a read form. at is its first word.
function launcherReadForm(plain, at) {
  if (plain[at]?.split('/').at(-1) === 'node') { at++; while (plain[at]?.startsWith('--')) at++; }
  return launcher(plain[at]?.split('/').at(-1) ?? '') && readForm(plain.slice(at + 1));
}
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const INTERPRETERS = /^(?:python[\d.]*|node|ruby|perl|php|osascript|swift|lua|tclsh|deno|bun|expect)$/;
const shellScript = (words, at) => {
  if (!SHELLS.has(words[at]?.split('/').at(-1))) return undefined;
  const flag = words.findIndex((word, k) => k > at && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word));
  return flag > at && words.slice(at + 1, flag).every(word => /^-[a-zA-Z]+$/.test(word)) ? words[flag + 1] ?? '' : null;
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
const RUNS_COMMAND = /^--(?:pre|pre-glob|filter|view|pager|open-files-in-pager|output|ext-diff|exec)(?:=|$)/;
function readTool(segment) {
  const { index, unreadable, assigned } = commandWord(segment, READ_PREFIXES);
  if (index === undefined || unreadable || assigned) return false;
  const plain = segment.map(word => word.text), name = plain[index].split('/').at(-1), args = plain.slice(index + 1);
  if (args.some(word => RUNS_COMMAND.test(word))) return false;
  if (READ_TOOLS.has(name)) return true;
  // git grep -O opens a pager command.
  return name === 'git' && GIT_READS.has(args[0] === '--no-pager' ? args[1] : args[0]) && !args.some(word => /^-O/.test(word));
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
function launcherRefused(command, depth = 0) {
  if (depth > 8) return true;
  const words = shellWords(command), texts = [command, ...words.map(word => word.text)];
  const named = texts.some(text => LAUNCHER_NAME.test(text));
  // Pipelines split on ; & && || and newline; their segments on | and |&. Subshell parentheses stay in the segment.
  const pipelines = [[[]]];
  for (const word of words) {
    if (word.operator && [';', '&', '&&', '||'].includes(word.text)) pipelines.push([[]]);
    else if (word.operator && ['|', '|&'].includes(word.text)) pipelines.at(-1).push([]);
    else pipelines.at(-1).at(-1).push(word);
  }
  const sub = texts.some(text => SUBCOMMAND.test(text)) || pipelines.flat().some(runsSubcommand);
  // Piped text run as code can be anything. Piped text as xargs arguments refuses once the launcher or a subcommand shows.
  for (const pipeline of pipelines) for (const segment of pipeline.slice(1)) {
    const runs = segment.length && runsInput(segment);
    if (runs === 'code' || runs === 'arguments' && (named || sub)) return true;
  }
  const reads = readOnly(command, words);
  const launcherSegments = pipelines.flat().filter(segment => segment.some(word => !word.operator && LAUNCHER_NAME.test(word.text)));
  // Only read tools name the launcher: nothing here can run it, so the command-wide rule is off.
  const exempt = named && reads && launcherSegments.every(readTool);
  if (named && !exempt && texts.some(text => (sub ? UNPLAIN : GENERATES).test(text))) return true;
  for (const pipeline of pipelines) {
    const pipeSub = pipeline.flat().some(word => !word.operator && SUBCOMMAND.test(word.text)) || pipeline.some(runsSubcommand);
    for (const segment of pipeline) {
      if (!segment.length || reads && readTool(segment)) continue;
      const segNamed = segment.some(word => !word.operator && LAUNCHER_NAME.test(word.text));
      const segSub = segment.some(word => !word.operator && SUBCOMMAND.test(word.text)) || runsSubcommand(segment);
      const { index, unreadable } = commandWord(segment);
      // A command word the guard can't read beside a subcommand word may be the launcher under another spelling.
      if (unreadable && pipeSub) return true;
      if (index === undefined) { if (segNamed && segSub) return true; continue; }
      const plain = segment.map(word => word.text);
      if (segSub) {
        // Beside a subcommand word, every word is plain: no expansion, glob, brace or joined quoting.
        if (segment.some(word => !word.operator && (word.joined || EXPANDING_WORD.test(word.text)))) return true;
        const name = plain[index].split('/').at(-1);
        if (SHELLS.has(name) || INTERPRETERS.test(name)) { if (!runsLauncherReadForm(segment, index)) return true; continue; }
      }
      const script = shellScript(plain, index);
      if (script === null && named && sub) return true;
      if (script !== undefined) { if (script !== null && launcherRefused(script, depth + 1)) return true; continue; }
      if (!(named && sub) || !segNamed) continue;
      // A direct invocation: the launcher itself, or node with its options and then the launcher.
      let at = index;
      if (plain[at].split('/').at(-1) === 'node') { at++; while (plain[at]?.startsWith('--')) at++; }
      if (!launcher(plain[at]?.split('/').at(-1) ?? '')) return true;
      const args = plain.slice(at + 1);
      if (args.some(arg => arg.startsWith('~') || LAUNCHER_NAME.test(arg))) return true;
      if ((args[0] === 'runs' || args.some(arg => SUBCOMMAND.test(arg))) && !readForm(args)) return true;
    }
  }
  return false;
}

function shellWritePaths(command, initialDirectory, depth = 0) {
  if (depth > 8) return [];
  const paths = [], segments = [{ words: [] }];
  let directory = initialDirectory;
  for (const word of shellWords(command)) {
    const previous = segments.at(-1);
    if (word.operator && [';', '&', '|', '|&', '&&', '||', '(', ')'].includes(word.text)) {
      segments.push({ words: [], piped: word.text === '|' ? previous.words : undefined });
    } else previous.words.push(word);
  }
  // ancestor: the command also reaches what is under the path (rm -r, mv, find -delete, chmod -R), so a parent folder counts.
  const add = (path, literalOnly = false, ancestor = false) => {
    if (typeof path !== 'string') return;
    paths.push({ path: directory && !/^(?:\/|~|\$HOME|\$\{HOME\})/.test(path) ? `${directory}/${path}` : path, literalOnly, ancestor });
  };
  for (const { words: segment, piped } of segments) {
    const texts = [];
    for (let i = 0; i < segment.length; i++) {
      if (segment[i].operator) {
        const operator = segment[i].text;
        const target = segment[++i];
        if (['>', '>>', '>|', '>&'].includes(operator) && target && !target.operator) add(target.text);
      } else texts.push(segment[i].text);
    }
    const allWords = [...texts];
    let xargs = false;
    while (texts.length) {
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(texts[0])) { texts.shift(); continue; }
      const prefix = texts[0].split('/').at(-1);
      if (!['env', 'command', 'sudo', 'time', 'nohup', 'xargs'].includes(prefix)) break;
      xargs ||= prefix === 'xargs'; texts.shift();
      while (texts[0]?.startsWith('-')) {
        const flag = texts.shift();
        if (['-u', '--unset', '-I', '-n', '-P'].includes(flag)) texts.shift();
      }
    }
    const executable = texts.shift()?.split('/').at(-1);
    const operands = texts.filter(text => text && !text.startsWith('-'));
    // `sleight-mcp turbo on|off` writes turbo.json for the user, so a model's shell may not run it. Position-free on purpose:
    // env, nohup, timeout, interpreter flags and sh -c strings all reach it. Only `turbo status` passes. When in doubt, deny.
    // `hand on|off|capture` writes hand.json the same way, and only `hand status` passes. Character writes and the cursor
    // style are the user's commands too: only cursor list, check and status pass, an allow-list, so an argument the guard
    // can't read (a variable, a substitution, xargs input) is refused. `permissions block|unblock|revoke|sites` change what
    // sleight may do, and only the listing passes.
    // A read-only tool's segment can't run the launcher (grep -n hand .../launch.mjs, file .../sleight-mcp hand).
    const reading = readOnly(command, shellWords(command)) && readTool(segment);
    for (const [command, allowed, file] of LAUNCHER_COMMANDS) {
      if (!reading && launcherToggle(allWords, command, allowed)) add(`~/Library/Application Support/sleight/${file}`, true);
    }
    if (xargs && piped) operands.push(...piped.filter(word => !word.operator).map(word => word.text));
    if (executable === 'cd') {
      const next = operands[0];
      if (next) directory = /^(?:\/|~|\$HOME|\$\{HOME\})/.test(next) || !directory ? next : `${directory}/${next}`;
    } else if (['bash', 'sh', 'zsh'].includes(executable) && texts.some(text => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(text))) {
      // -c alone or in a flag group (-lc, -ic): the script is the next word.
      paths.push(...shellWritePaths(texts[texts.findIndex(text => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(text)) + 1] ?? '', directory, depth + 1));
    } else if (['cp', 'install', 'rsync', 'ln'].includes(executable)) {
      const target = texts.findIndex(text => text === '-t' || text === '--target-directory');
      add(target >= 0 ? texts[target + 1] : operands.at(-1));
      const attached = texts.find(text => text.startsWith('--target-directory='));
      if (attached) add(attached.slice('--target-directory='.length));
    } else if (executable === 'rm') operands.forEach(path => add(path, false, true));
    else if (executable === 'mv') operands.forEach((path, at) => add(path, false, at < operands.length - 1));
    else if (['chmod', 'chown', 'chgrp', 'chflags'].includes(executable)) operands.forEach(path => add(path, false, texts.some(arg => /^-[^-]*R/.test(arg))));
    else if (executable === 'find' && texts.some((arg, at) => arg === '-delete' ||
      ['-exec', '-execdir', '-ok', '-okdir'].includes(arg) && FIND_WRITERS.has(texts[at + 1]?.split('/').at(-1)))) {
      // find's search roots come before its first expression; a protected name anywhere in the expression denies too.
      const start = texts.findIndex(arg => !['-H', '-L', '-P'].includes(arg)), end = texts.findIndex((arg, at) => at >= start && /^[-(!]/.test(arg));
      const roots = texts.slice(start, end < 0 ? texts.length : end);
      for (const root of roots.length ? roots : ['.']) add(root, false, true);
      if (texts.some(arg => PROTECTED_NAME.test(arg))) add('~/Library/Application Support/sleight', true);
    } else if (executable === 'tar' && /^-?[a-zA-Z]*x|^--extract$|^--get$/.test(texts[0] ?? '') || executable === 'tar' && texts.some(arg => /^-[a-zA-Z]*x/.test(arg))) {
      // An archive unpacked into a folder can write any file under it.
      const at = texts.findIndex(arg => arg === '-C' || arg === '--directory');
      if (at >= 0) add(texts[at + 1], false, true);
      texts.filter(arg => arg.startsWith('--directory=')).forEach(arg => add(arg.slice('--directory='.length), false, true));
    } else if (executable === 'unzip' && texts.includes('-d')) add(texts[texts.indexOf('-d') + 1], false, true);
    else if (executable === 'ditto') add(operands.at(-1), false, true);
    else if (['curl', 'wget'].includes(executable)) {
      texts.forEach((arg, at) => { if (['-o', '--output', '-O', '--output-document'].includes(arg)) add(texts[at + 1]); });
      texts.filter(arg => /^--output(?:-document)?=/.test(arg)).forEach(arg => add(arg.slice(arg.indexOf('=') + 1)));
    } else if (executable === 'git' && ['checkout', 'restore', 'apply'].includes(texts[0])) operands.slice(1).forEach(path => add(path));
    else if (executable === 'patch') operands.forEach(path => add(path));
    else if (['tee', 'truncate'].includes(executable) ||
      (['sed', 'perl'].includes(executable) && texts.some(arg => /^-[^-]*i/.test(arg))) ||
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
      const writes = /\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][wax][+bt]*['"]|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|rm(?:Sync)?|remove|truncate|File\.write)\s*\(|\b(?:unlink|rename|chmod|chown|rmtree|move|symlink)\b/;
      if (!writes.test(source)) continue;
      // Inline code is scanned as text only, never passed to the filesystem resolver.
      for (const match of source.matchAll(/(?:~|\$\{?HOME\}?|\/|\.{1,2}\/)[^'"`;\n()<>|]*?(?:(?:preapproved|turbo|turbo-apps|turbo-owner|electron-grants|hand|permissions)\.json|grant-seal\.key|\/sleight(?=['"`;,)\s]|$)|\/(?:library\/caches|plugins\/cache\/[^/'"`;\n()<>|]+)\/sleight(?![\w.-])(?:\/[^'"`;\n()<>|]*)?|\/library\/caches\/sleight-bench\/[^'"`;\n()<>|]*)|\b(?:(?:preapproved|turbo|turbo-apps|turbo-owner|electron-grants|hand|permissions)\.json|grant-seal\.key)\b/gi)) add(match[0], true);
    }
  }
  return paths;
}

/** The protected folder (a PROTECTED label) a file or shell tool call would change, or undefined. */
export async function preapprovedWriteTarget(input, options) {
  const { tool } = input;
  let paths;
  if (mutations.has(tool)) {
    paths = [input.file_path, input.notebook_path, ...(Array.isArray(input.edits) ? input.edits.map(edit => edit?.file_path) : [])];
  } else if (tool === 'Bash' && typeof input.command === 'string') {
    if (launcherRefused(input.command)) return PROTECTED.launcher;
    paths = shellWritePaths(input.command);
  } else return undefined;
  for (const candidate of paths) {
    const { path, literalOnly, ancestor } = tool === 'Bash' ? candidate : { path: candidate };
    if (typeof path !== 'string') continue;
    if (tool === 'Bash') {
      const literal = await literalLabel(path, options, ancestor);
      if (literal) return literal;
      const folder = globFolder(path), inFolder = folder && await literalLabel(folder, options, ancestor);
      if (inFolder) return inFolder;
      // Inline code's paths stay text, except under sleight-bench, where the arm's links make the real target count.
      if ((literalOnly || /\s/.test(path) || path.length >= 512) && !underBench(path, options?.home)) continue;
    }
    const label = await protectedPath(path, options, ancestor);
    if (label) return label;
  }
  return undefined;
}
export const preapprovedWriteDenied = async (input, options) => !!await preapprovedWriteTarget(input, options);
/** The refusal Claude gets, naming what the call reached. */
export const preapprovedWriteReason = label => `Only the user changes ${label}. Ask them to make this change.`;

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
const CONFIG = /(?:^|\/)(?:\.claude\/[^/]*\.json|\.claude\.json|\.?mcp\.json|managed-settings\.json|settings(?:\.local)?\.json|\.claude-plugin\/plugin\.json|bin\/sleight-mcp|launchagents\/[^/]+\.plist|\.config\/fish\/(?:[^/]+\/)*[^/]+\.fish|\.(?:zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile|envrc)|\.zshrc\.d\/[^/]+)$/;
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
  // A write to a config file, or an interpreter or editor tool run with one named: reads such as grep pass.
  return shellWritePaths(command).some(({ path }) => CONFIG.test(folded(normalize(path)))) ||
    // Each test on its own spelling: a fold that reaches the path can join the interpreter's name onto the argument before it
    // (Python's and Ruby's adjacent literals), and the raw spelling keeps the name but not the path.
    candidates.some(text => CONFIG_TEXT.test(text)) && candidates.some(text => SETTERS.test(text));
}
