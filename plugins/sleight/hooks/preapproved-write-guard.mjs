const directorySuffix = '/library/application support/sleight';
// grant-seal.key seals the Electron Always records in electron-grants.json; writing it would forge consent. hand.json is the
// user's ghost hand opt-out. permissions.json holds the apps and sites the user told sleight never to act in. turbo-owner.json
// names the copy that issued turbo.json's receipt, which decides whether a startup may move it.
const suffixes = ['preapproved.json', 'turbo.json', 'turbo-apps.json', 'turbo-owner.json', 'electron-grants.json', 'grant-seal.key', 'hand.json', 'permissions.json'].map(filename => `${directorySuffix}/${filename}`);
const mutations = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const folded = path => path.normalize('NFC').toLowerCase();
const protectedLiteral = path => {
  const value = folded(normalize(path));
  return suffixes.some(suffix => value.endsWith(suffix)) || value.endsWith(directorySuffix);
};
const normalize = path => {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
};

// True when the path is sleight's folder or a folder above it, so deleting, moving or changing it reaches the protected files.
// Without the home folder, only ~ spellings can be judged.
const above = (path, home) => {
  const root = home ?? '/~', value = folded(normalize(path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => root)));
  const folder = folded(normalize(`${root}/Library/Application Support/sleight`));
  return value.startsWith('/') && (value === folder || folder.startsWith(value === '/' ? '/' : value + '/'));
};

// Resolve before normalizing: a symlink followed by .. walks from its target.
async function protectedPath(path, { stat, home }, ancestor = false) {
  if (typeof path !== 'string' || !path || path.length > 4096) return false;
  if (protectedLiteral(path) || ancestor && above(path, home)) return true;
  if (home) path = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home);
  let resolved = (await stat(path.startsWith('/') ? '/' : '.').catch(() => undefined))?.realPath;
  if (!resolved) return false;
  for (const part of path.split('/').filter(Boolean)) {
    const next = `${resolved.replace(/\/$/, '')}/${part}`;
    const info = await stat(next).catch(() => undefined);
    resolved = info?.realPath ?? normalize(next);
  }
  return protectedLiteral(resolved) || ancestor && above(resolved, home);
}

// Only literal shell names and operators, never eval or shell expansion. Keep
// operators inside quotes as text, and join quoted/escaped pieces of a word.
function shellWords(command) {
  const words = [];
  let word = '', quote = '', active = false;
  const flush = () => { if (active) words.push({ text: word }); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") {
      const escaped = command[++i] ?? '';
      if (escaped !== '\n') { active = true; word += escaped; }
    }
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (c === '\n') { flush(); words.push({ text: ';', operator: true }); }
    else if (/\s/.test(c)) flush();
    else if (';&|<>()'.includes(c)) {
      flush();
      const pair = c + (command[i + 1] ?? '');
      const operator = ['>>', '>|', '>&', '<<', '&&', '||', '|&'].includes(pair) ? (i++, pair) : c;
      words.push({ text: operator, operator: true });
    }
    else { word += c; active = true; }
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
const refusedLauncher = words => LAUNCHER_COMMANDS.some(([command, allowed]) => launcherToggle(words, command, allowed));
const LAUNCHER_TEXT = /(?<![\w.-])(?:\S*\/)?(?:sleight-mcp|launch\.mjs)(?![\w.-])/g;
// True when the launcher's arguments, up to the next unquoted ;, &, | or newline, hold text the guard can't read: a backtick,
// a $ expansion of any kind ($(, ${, $NAME, $'...') or a <( process substitution. The shell runs a substitution before the
// launcher sees its arguments, so it can name any subcommand. Quotes don't make it readable: double quotes still substitute,
// and a single-quoted string may be an sh -c script.
function launcherSubstitution(command) {
  for (const match of command.matchAll(LAUNCHER_TEXT)) {
    let quote = '';
    for (let i = match.index + match[0].length; i < command.length; i++) {
      const c = command[i];
      if (c === '\\') { i++; continue; }
      if (c === '`' || c === '$' && command[i + 1] !== undefined && !/\s/.test(command[i + 1]) || c === '<' && command[i + 1] === '(') return true;
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (';&|\n'.includes(c)) break;
    }
  }
  return false;
}
// xargs takes the launcher's arguments from its input, which the guard reads only as the literal words of an echo or printf
// that feeds it through a pipe. Any other input (a file, a redirect, another command, xargs options) is refused, and so are
// literal words that make a refused command with the launcher's own arguments.
function xargsLauncher(words, piped) {
  const names = words.map(word => word.split('/').at(-1)), at = names.findIndex(launcher), from = names.indexOf('xargs');
  if (at < 0 || from < 0 || from > at) return false;
  if (words.slice(from + 1, at).some(word => /^-[^-]/.test(word))) return true;
  const producer = piped?.filter(word => !word.operator).map(word => word.text);
  if (!producer?.length || !['echo', 'printf'].includes(producer[0].split('/').at(-1))) return true;
  const input = producer.slice(1);
  if (input.some(word => /[$`\\'"%]|^-/.test(word))) return true;
  return refusedLauncher([...words.slice(at), ...input.flatMap(word => word.split(/\s+/).filter(Boolean))]);
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
  // A substitution in the launcher's arguments could name any subcommand.
  if (launcherSubstitution(command)) add('~/Library/Application Support/sleight/hand.json', true);
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
    for (const [command, allowed, file] of LAUNCHER_COMMANDS) {
      if (launcherToggle(allWords, command, allowed)) add(`~/Library/Application Support/sleight/${file}`, true);
    }
    if (xargsLauncher(allWords, piped)) add('~/Library/Application Support/sleight/hand.json', true);
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
      for (const match of source.matchAll(/(?:~|\$\{?HOME\}?|\/|\.{1,2}\/)[^'"`;\n()<>|]*?(?:(?:preapproved|turbo|turbo-apps|turbo-owner|electron-grants|hand|permissions)\.json|grant-seal\.key|\/sleight(?=['"`;,)\s]|$))|\b(?:(?:preapproved|turbo|turbo-apps|turbo-owner|electron-grants|hand|permissions)\.json|grant-seal\.key)\b/gi)) add(match[0], true);
    }
  }
  return paths;
}

export async function preapprovedWriteDenied(input, options) {
  const { tool } = input;
  let paths;
  if (mutations.has(tool)) {
    paths = [input.file_path, input.notebook_path, ...(Array.isArray(input.edits) ? input.edits.map(edit => edit?.file_path) : [])];
  } else if (tool === 'Bash' && typeof input.command === 'string') {
    paths = shellWritePaths(input.command);
  } else return false;
  for (const candidate of paths) {
    const { path, literalOnly, ancestor } = tool === 'Bash' ? candidate : { path: candidate };
    if (typeof path !== 'string') continue;
    if (tool === 'Bash') {
      if (protectedLiteral(path) || ancestor && above(path, options?.home)) return true;
      const folder = globFolder(path);
      if (folder && (protectedLiteral(folder) || ancestor && above(folder, options?.home))) return true;
      if (literalOnly || /\s/.test(path) || path.length >= 512) continue;
    }
    if (await protectedPath(path, options, ancestor)) return true;
  }
  return false;
}

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
