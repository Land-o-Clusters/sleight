import { lineCommentEnd, isLineTerminator } from '../lib/code-line-terminators.mjs';
// A literal-command guard, not a shell sandbox. Never evaluate shell text or
// inspect scripts on disk. Opaque programs remain subject to the host's policy.
export const shellGuardReason = "sleight's shell guard for this turn blocked a launch that could take focus. Use browser_open for a background tab or sleight tools for apps. Headless browser runs are allowed. Set SLEIGHT_SHELL_GUARD=0 to turn this guard off.";

// Browser aliases identify CLI headless support, not app-specific UI behavior.
const headlessBrowser = /^(?:(?:google[ -])?chrome(?:[ -](?:stable|beta|unstable|canary|for testing))?|chromium(?:-browser)?|chromium-headless-shell|chrome-headless-shell|helium|firefox(?:[ -](?:esr|nightly))?|msedge|microsoft edge(?: (?:beta|dev|canary))?|brave(?:-browser| browser)?|opera)$/i;
const guiLauncher = /^(?:open|xdg-open|sensible-browser|osascript|safari)$/i;
const shell = /^(?:(?:ba|z|da|k)?sh|fish|csh|tcsh)$/;
const python = /^python(?:\d+(?:\.\d+)*)?$/;
const interpreter = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|perl|ruby|osascript|swift)$/;
const base = word => word.split('/').at(-1);

// Tokenize literal source, without executing it or reading imported code. Keep
// strings atomic so parentheses and process names in data cannot create calls.
function payloadTokens(source, language) {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const start = i, c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#' || ['node', 'nodejs', 'swift'].includes(language) && source.startsWith('//', i)) {
      i = lineCommentEnd(source, i);
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2; continue;
    }
    const commandQuote = language === 'perl' && /^qx\b\s*([^\w\s])/.exec(source.slice(i)) ||
      language === 'ruby' && /^%x\s*([^\w\s])/.exec(source.slice(i));
    if (commandQuote) {
      const open = commandQuote[1], close = { '(': ')', '[': ']', '{': '}', '<': '>' }[open] ?? open;
      i += commandQuote[0].length;
      const content = i;
      let nesting = 1;
      for (; i < source.length; i++) {
        if (source[i] === '\\') { i++; continue; }
        if (source[i] === close && --nesting === 0) break;
        if (open !== close && source[i] === open) nesting++;
      }
      tokens.push({ value: source.slice(content, i), quote: 'command', start, end: Math.min(source.length, i + 1) });
      i = Math.min(source.length, i + 1); continue;
    }
    if ('"\'`'.includes(c)) {
      const quote = c !== '`' && source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
      const content = i;
      while (i < source.length && !source.startsWith(quote, i)) {
        if (source[i] === '\\') i++;
        i++;
      }
      const value = source.slice(content, i);
      i = Math.min(source.length, i + quote.length);
      tokens.push({ value, quote, start, end: i }); continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))?.[0];
    i += word?.length ?? 1;
    tokens.push({ text: word ?? c, start, end: i });
  }
  return tokens;
}

// Within a process argument, commands may start after a shell operator or
// behind env / sh -c. This is still a literal check, not shell evaluation.
function launcherStringDenied(command, depth = 0) {
  if (depth > 12) return false;
  const launcher = /^(?:open|osascript|xdg-open|x-www-browser)$/i;
  // An escaped quote around a shell -c body still delimits a literal command.
  const parsed = lex(command.replace(/\\(["'])/g, '$1'), false, false);
  if (parsed.unsafeLines) return true;
  return segments(parsed.tokens).some(({ words }) => {
    let i = 0;
    while (/^[A-Za-z_]\w*=/.test(words[i] ?? '')) i++;
    let name = base(words[i++] ?? '');
    while (name === 'env') {
      while (i < words.length) {
        if (['-u', '--unset', '-C', '--chdir'].includes(words[i])) { i += 2; continue; }
        if (['-S', '--split-string'].includes(words[i])) return launcherStringDenied(words.slice(i + 1).join(' '), depth + 1);
        if (words[i].startsWith('--split-string=')) return launcherStringDenied(words[i].slice(15), depth + 1);
        if (words[i].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i])) { i++; continue; }
        break;
      }
      name = base(words[i++] ?? '');
    }
    if (launcher.test(name)) return true;
    if (!shell.test(name)) return false;
    for (; i < words.length; i++) {
      const option = /^-[^-]*?c(.*)$/s.exec(words[i]);
      if (option) return launcherStringDenied(option[1] || words[i + 1] || '', depth + 1);
    }
    return false;
  });
}

function launcherPayloadDenied(payload, language = '') {
  if (/\b(?:webbrowser|NSWorkspace|LSOpen\w*|NSAppleScript)\b|\bosascript\s+-e\b/i.test(payload)) return true;
  const tokens = payloadTokens(payload, language), pairs = new Map(), stack = [];
  const text = i => tokens[i]?.text;
  for (let i = 0; i < tokens.length; i++) {
    if (['(', '[', '{'].includes(text(i))) stack.push(i);
    else if ([')', ']', '}'].includes(text(i)) && text(stack.at(-1)) === { ')': '(', ']': '[', '}': '{' }[text(i)]) {
      const start = stack.pop(); pairs.set(start, i);
    }
  }
  const boundary = i => i >= tokens.length || text(i) === ';' ||
    i > 0 && /[\n\r\u2028\u2029]/.test(payload.slice(tokens[i - 1].end, tokens[i].start));
  const endOf = start => {
    let i = start;
    for (; i < tokens.length && (i === start || !boundary(i)); i++) {
      if (pairs.has(i)) i = pairs.get(i);
    }
    return i;
  };
  const methods = /^(?:popen|exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|system)$/;
  const member = (module, method) => /^[A-Za-z_]\w*$/.test(method ?? '') && (module === 'subprocess' || module === 'Open3' ||
    module === 'os' && /^(?:system|popen|exec\w*|spawn\w*)$/.test(method) ||
    module === 'asyncio' && /^create_subprocess_/.test(method));
  const modules = new Map(['os', 'subprocess', 'asyncio', 'Open3'].map(name => [name, name]));
  const functions = new Set(), bindings = new Map();
  const childProcess = value => /^(?:node:)?child_process$/.test(value ?? '');
  // Recognize Python import aliases and Node destructuring / named imports.
  for (let i = 0; i < tokens.length; i++) {
    if (text(i) === 'import' && text(i - 2) === 'from' && modules.has(text(i - 1))) {
      const module = modules.get(text(i - 1));
      for (let j = i + 1, end = endOf(i + 1); j < end; j++) {
        if (member(module, text(j))) {
          functions.add(text(j + 1) === 'as' ? text(j + 2) : text(j));
          if (text(j + 1) === 'as') j += 2;
        }
      }
    } else if (text(i) === 'import') {
      for (let j = i + 1, end = endOf(i + 1); j < end; j++) {
        if (modules.has(text(j)) && text(j + 1) === 'as') modules.set(text(j + 2), modules.get(text(j)));
      }
    }
    if (text(i) !== '{' || !pairs.has(i)) continue;
    const end = pairs.get(i);
    const nodeImport = text(end + 1) === 'from' && childProcess(tokens[end + 2]?.value) ||
      text(end + 1) === '=' && text(end + 2) === 'require' && childProcess(tokens[end + 4]?.value);
    if (nodeImport) for (let j = i + 1; j < end; j++) {
      const method = text(j) ?? tokens[j].value;
      if (methods.test(method)) {
        const next = text(j + 1) === ']' ? j + 2 : j + 1;
        functions.add([':', 'as'].includes(text(next)) ? text(next + 1) : method);
        if ([':', 'as'].includes(text(next))) j = next + 1;
      }
    }
  }
  const inspect = (start, end) => {
    for (let i = start; i < end; i++) {
      if (tokens[i]?.value !== undefined ? launcherStringDenied(tokens[i].value) : bindings.get(text(i))) return true;
    }
    return false;
  };
  for (let i = 0; i < tokens.length; i++) {
    const name = text(i);
    if (/^[A-Za-z_$][\w$]*$/.test(name ?? '') && text(i - 1) !== '.' && text(i + 1) === '=' && text(i + 2) !== '=') {
      const start = i + 2;
      const prefixed = /^[frbu]+$/i.test(text(start) ?? '') && tokens[start + 1]?.value !== undefined;
      let end = pairs.has(start) ? pairs.get(start) + 1 : start + (prefixed ? 2 : 1);
      if (python.test(language) && text(end) === ',') end = endOf(start);
      const literal = ['[', '('].includes(text(start)) || tokens[start]?.value !== undefined || prefixed || boundary(end);
      // Snapshot references before rebinding, so a later assignment cannot
      // rewrite a list already passed to another variable. Opaque values clear it.
      bindings.set(name, literal && inspect(start, end));
    }
    if (name === 'require' && text(i + 1) === '(' && tokens[i + 2]?.value === 'open') return true;
    if ((tokens[i]?.quote === 'command' || tokens[i]?.quote === '`' && ['ruby', 'perl'].includes(language)) &&
      launcherStringDenied(tokens[i].value)) return true;
    const method = tokens[i]?.value !== undefined && text(i - 1) === '[' && text(i + 1) === ']'
      ? tokens[i].value : name;
    const call = methods.test(method) || functions.has(name) ||
      text(i - 1) === '.' && member(modules.get(text(i - 2)), name);
    const property = ['launchPath', 'executableURL'].includes(name) && text(i - 1) === '.' && text(i + 1) === '=';
    const pipeOpen = language === 'perl' && name === 'open' && text(i - 1) !== '.';
    if (!call && !property && !pipeOpen) continue;
    let start = text(i + 1) === ']' ? i + 2 : i + 1;
    if (property) start++;
    const commandStyle = ['ruby', 'perl'].includes(language) && !boundary(start) &&
      (tokens[start]?.value !== undefined || /^[A-Za-z_$]/.test(text(start) ?? '') || text(start) === '[');
    if (!property && text(start) !== '(' && !commandStyle) continue;
    const end = pairs.get(start) ?? endOf(start);
    if (pipeOpen && !tokens.slice(start, end).some(token => token.value?.includes('|'))) continue;
    if (inspect(start, end)) return true;
  }
  return false;
}

function lookupLauncher(body, depth) {
  if (depth > 12) return '';
  const parsed = lex(body, false, false, false, depth + 1);
  if (parsed.uncertain || parsed.tokens.some(token => token.text === undefined)) return '';
  const words = parsed.tokens.map(token => token.text), name = base(words[0] ?? '');
  const args = words.slice(1).filter(word => word !== '--');
  const target = name === 'which' && args.length === 1 ? args[0] :
    name === 'command' && args.length === 2 && args[0] === '-v' ? args[1] : '';
  return guiLauncher.test(base(target)) ? target : '';
}

// Preserve operators inside quotes as data and join quoted/escaped word parts.
// Substitutions execute even within double quotes, so check their bodies too.
function lex(source, expansionOnly = false, extractHeredocs = true, stopAtParen = false, depth = 0) {
  const tokens = [], substitutions = [];
  const pending = [], heredocs = [];
  // This lexer only certifies a subset of shell grammar. Arithmetic, test and
  // let contexts cannot certify a heredoc. The caller scans their full source.
  let uncertain = depth > 12, unsafeLines = false;
  extractHeredocs &&= !uncertain;
  let text = '', active = false, quote = '', quoted = false, awaitingHeredoc, parens = 0, i = 0;
  const flush = () => {
    if (active) {
      tokens.push({ text });
      if (!expansionOnly && !awaitingHeredoc && text === 'let') { uncertain = true; extractHeredocs = false; }
      if (awaitingHeredoc) {
        pending.push(Object.assign(awaitingHeredoc, { delimiter: text, quoted }));
        awaitingHeredoc = undefined;
      }
    }
    text = ''; active = false; quoted = false;
  };
  for (; i < source.length && depth <= 12; i++) {
    const c = source[i];
    // These bytes are not shell separators. Refuse structural ambiguity instead
    // of splitting an argument and accidentally certifying a headless flag.
    if (!quote && c !== '\n' && isLineTerminator(c)) unsafeLines = true;
    if (!expansionOnly && !quote && ['((', '[[', '$[', '$(('].some(start => source.startsWith(start, i))) {
      uncertain = true; extractHeredocs = false;
    }
    if (c === '\\' && quote !== "'") {
      const next = source[++i] ?? '';
      if (next !== '\n') {
        quoted = true;
        text += quote === '"' && !'$`"\\'.includes(next) ? '\\' + next : next;
        active = true;
      }
    } else if (quote !== "'" && (c === '`' || c === '$' && source[i + 1] === '(' ||
      !expansionOnly && !quote && '<>'.includes(c) && source[i + 1] === '(')) {
      const backtick = c === '`', process = '<>'.includes(c), start = i + (backtick ? 1 : 2);
      let j = start;
      if (backtick) {
        for (; j < source.length; j++) { if (source[j] === '\\') j++; else if (source[j] === '`') break; }
      } else {
        const inner = lex(source.slice(start), false, extractHeredocs, true, depth + 1);
        j += inner.end;
        uncertain ||= inner.uncertain;
      }
      if (j >= source.length) uncertain = true;
      if (awaitingHeredoc) uncertain = true; // Delimiter expansion is not certified.
      const body = source.slice(start, j);
      substitutions.push({ body, process });
      // Resolving a literal availability lookup is only useful as a command
      // word. An echo argument containing that lookup remains ordinary data.
      text += !process && lookupLauncher(body, depth) || '$substitution'; active = true; i = j;
    } else if (quote) {
      if (c === quote) quote = ''; else text += c;
    } else if (!expansionOnly && (c === "'" || c === '"')) { quote = c; quoted = true; active = true; }
    else if (!expansionOnly && c === '#' && !active) {
      const end = source.indexOf('\n', i);
      unsafeLines ||= /[\r\u2028\u2029]/.test(source.slice(i, end < 0 ? source.length : end));
      i = end < 0 ? source.length : end - 1;
    } else if (c === '\n' || ';&|()'.includes(c) || '{}'.includes(c) && !active && /^[\s;]?$/.test(source[i + 1] ?? '')) {
      flush();
      if (c === ')' && stopAtParen && parens === 0) break;
      if (c === '(') parens++;
      if (c === ')') parens--;
      const pair = c + source[i + 1];
      tokens.push({ op: ['&&', '||', '|&'].includes(pair) ? (i++, pair) : c === '\n' ? ';' : c, newline: c === '\n' });
      if (c === '\n' && pending.length) {
        let cursor = i + 1;
        for (const doc of pending.splice(0)) {
          const start = cursor;
          let bodyEnd = cursor;
          doc.matched = false;
          while (cursor < source.length) {
            const end = source.indexOf('\n', cursor), next = end < 0 ? source.length : end;
            const line = source.slice(cursor, next);
            const terminator = doc.redirect === '<<-' ? line.replace(/^\t+/, '') : line;
            if (terminator === doc.delimiter) { doc.matched = true; bodyEnd = cursor; cursor = end < 0 ? next : next + 1; break; }
            cursor = end < 0 ? next : next + 1;
            bodyEnd = cursor;
          }
          doc.body = source.slice(start, bodyEnd);
          heredocs.push(doc);
          // Bash joins backslash-newline before testing unquoted delimiters.
          // Leave that grammar and unsupported delimiter forms to whole scans.
          if (!doc.matched || !doc.quoted && doc.body.includes('\\\n')) uncertain = true;
        }
        i = cursor - 1;
      }
    } else if (!expansionOnly && '<>'.includes(c)) {
      // A redirection's operand is data, not the command being launched.
      const fd = !quoted && /^\d+$/.test(text) ? text : undefined;
      if (fd !== undefined) { text = ''; active = false; }
      flush();
      let op = c;
      if (source[i + 1] === c) op += source[++i];
      if (op === '<<' && ['-', '<'].includes(source[i + 1])) op += source[++i];
      else if (source[i + 1] === '&') op += source[++i];
      const token = { redirect: op, fd };
      tokens.push(token);
      if (op === '<<' && source[i + 1] === '~') uncertain = true;
      if (extractHeredocs && /^<<-?$/.test(op)) { token.body = ''; awaitingHeredoc = token; }
    } else if (c === ' ' || c === '\t') flush();
    else { text += c; active = true; }
  }
  flush();
  if (quote || awaitingHeredoc || pending.length) uncertain = true;
  return { tokens, substitutions, heredocs, uncertain, unsafeLines, end: i };
}

function deniedCommand(words, depth, stdinSource, heredocs = [], consumerOnly = false) {
  if (depth > 12) return true;
  const command = (words, depth, stdinSource, heredocs) => deniedCommand(words, depth, stdinSource, heredocs, consumerOnly);
  const source = (text, depth, heredocs) => consumerOnly ? hasCodeConsumer(lex(text), depth, consumerOnly) : deniedSource(text, depth, heredocs);
  while (words.length && (/^[A-Za-z_][\w]*=/.test(words[0]) || ['!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until'].includes(words[0]))) words = words.slice(1);
  if (!words.length) return false;
  const name = base(words[0]), args = words.slice(1);
  if (name === 'command' && args.some(arg => /^-[vV]+$/.test(arg)) &&
    args.filter(arg => arg.startsWith('-')).every(arg => /^-[vV]+$/.test(arg) || arg === '--')) return false;
  if (consumerOnly && ['xargs', 'eval', 'su', 'parallel', 'watch', 'source', '.'].includes(name)) return true;
  if (name === 'busybox') return command(args, depth + 1, stdinSource, heredocs);
  if (name === 'shortcuts' && args[0] === 'run') return true;
  if (name === 'su') {
    const at = args.findIndex(arg => arg === '--command' || /^-[^-]*c/.test(arg) || arg.startsWith('--command='));
    if (at < 0) return false;
    const option = args[at];
    const attached = option.startsWith('--command=') ? option.slice(10) : /^-[^-]*?c(.*)$/s.exec(option)?.[1];
    return source(attached || args[at + 1] || '', depth + 1, heredocs);
  }
  // Unwrap ordinary launch prefixes without allowing flags to hide a command.
  if (['command', 'builtin', 'exec', 'nohup', 'env', 'sudo', 'nice', 'time', 'xargs', 'arch', 'timeout', 'caffeinate', 'setsid', 'stdbuf', 'script', 'launchctl',
    'doas', 'ionice', 'chroot', 'parallel', 'watch', 'sandbox-exec', 'xcrun'].includes(name)) {
    let i = 0;
    const takesValue = { env: ['-u', '--unset', '-C', '--chdir'], sudo: ['-u', '-g', '-h', '-p', '-C', '-T'],
      nice: ['-n'], time: ['-o', '--output', '-f', '--format'], xargs: ['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a'],
      exec: ['-a'], arch: ['-arch', '-d', '-e'], timeout: ['-s', '--signal', '-k', '--kill-after'],
      caffeinate: ['-t', '-w'], stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
      script: ['-t', '-I', '-O', '-B', '-T', '--log-in', '--log-out', '--log-io', '--log-timing'],
      doas: ['-u', '-C'], ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'],
      chroot: ['--userspec', '--groups'], parallel: ['-j', '--jobs', '-S', '--sshlogin', '-a', '--arg-file', '-I', '--replace'],
      watch: ['-n', '--interval'], 'sandbox-exec': ['-f', '-p', '-D'], xcrun: ['-sdk', '--sdk', '-toolchain', '--toolchain'] };
    if (name === 'launchctl') {
      // These start a job whose program may live in an opaque plist or service.
      if (['submit', 'load', 'bootstrap', 'kickstart'].includes(args[0])) return true;
      return args[0] === 'asuser' && command(args.slice(2), depth + 1, stdinSource, heredocs);
    }
    while (i < args.length) {
      if (name === 'env' && ['-S', '--split-string'].includes(args[i])) return source(args.slice(i + 1).join(' '), depth + 1, heredocs);
      if (name === 'env' && /^--split-string=/.test(args[i])) return source(args[i].slice(15) + ' ' + args.slice(i + 1).join(' '), depth + 1, heredocs);
      if (name === 'script' && ['-c', '--command'].includes(args[i])) return source(args[i + 1] ?? '', depth + 1, heredocs);
      if (name === 'script' && args[i].startsWith('--command=')) return source(args[i].slice(10), depth + 1, heredocs);
      const scriptCommand = name === 'script' && /^-[^-c]*c(.*)$/s.exec(args[i]);
      if (scriptCommand) return source(scriptCommand[1] || args[i + 1] || '', depth + 1, heredocs);
      if (args[i] === '--') { i++; break; }
      if (takesValue[name]?.includes(args[i])) { i += 2; continue; }
      // Short options may be bundled. A value-taking flag at the end uses
      // the next word; any suffix on that flag is the value itself.
      if (name !== 'arch' && /^-[^-]/.test(args[i])) {
        const flags = takesValue[name]?.filter(flag => flag.length === 2).map(flag => flag[1]) ?? [];
        const at = [...args[i]].findIndex((flag, index) => index > 0 && flags.includes(flag));
        if (at > 0) { i += at === args[i].length - 1 ? 2 : 1; continue; }
      }
      if (args[i].startsWith('-') || /^[A-Za-z_][\w]*=/.test(args[i])) { i++; continue; }
      break;
    }
    if (['timeout', 'script', 'chroot'].includes(name)) i++; // Duration, transcript path or new root.
    if (name === 'parallel' || name === 'watch') return source(args.slice(i).join(' '), depth + 1, heredocs);
    return command(args.slice(i), depth + 1, stdinSource, heredocs);
  }
  if (name === 'find') return args.some((arg, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg) && command(args.slice(i + 1), depth + 1, stdinSource, heredocs));
  if (name === 'eval') return source(args.join(' '), depth + 1, heredocs);
  if (shell.test(name) || ['source', '.'].includes(name)) {
    if (consumerOnly) return true;
    const at = args.findIndex(arg => /^-[^-]*c/.test(arg) || arg === '--command' || arg.startsWith('--command='));
    if (at < 0) return heredocs.some(doc => deniedSource(doc.body, depth + 1, [], false));
    const option = args[at];
    const attached = option.startsWith('--command=') ? option.slice(10) : /^-[^-]*?c(.*)$/s.exec(option)?.[1];
    return source(attached || args[at + 1] || '', depth + 1, heredocs);
  }
  if (consumerOnly) return consumerOnly !== 'shell' && interpreter.test(name) && (consumerOnly === 'language' ? name : true);
  if (guiLauncher.test(name) || name === 'gio' && args[0] === 'open') return true;
  const browser = headlessBrowser.test(name);
  if (browser || /\.app\/Contents\/MacOS\//i.test(words[0])) {
    // Only a browser with known CLI support gets a headless exemption. Flags
    // after --, strings containing a flag, and --headless=false grant nothing.
    const flags = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
    return !(browser && !flags.some(arg => arg.startsWith('--headless=') && !/^--headless=(?:new|old|true)$/.test(arg)) &&
      (flags.some(arg => /^--headless(?:=(?:new|old|true))?$/.test(arg)) || args.length === 1 && ['--version', '--help'].includes(args[0])));
  }
  if (interpreter.test(name)) {
    const stdinDenied = () => Boolean(stdinSource || heredocs.some(doc => launcherPayloadDenied(doc.body, name)));
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--') return (!args[i + 1] || args[i + 1] === '-') && stdinDenied();
      if ((python.test(name) ? ['-W', '-X'] : name === 'node' ? ['-r', '--require', '--import'] : []).includes(args[i])) { i++; continue; }
      const option = python.test(name) ? /^-[bBdEhiIOPqRsSuvV]*([cm])(.*)$/s.exec(args[i]) :
        /^-(?:[wnpa]*)([ceE])(.*)$/s.exec(args[i]);
      if (option) {
        const payload = option[2] || args[i + 1] || '';
        if (option[1] === 'm') return payload === 'webbrowser';
        if (launcherPayloadDenied(payload, name)) return true;
        if (!option[2]) i++;
        continue; // Perl and Ruby allow multiple -e payloads.
      }
      if (args[i] === '--eval' || args[i].startsWith('--eval=')) {
        const payload = args[i] === '--eval' ? args[++i] ?? '' : args[i].slice(7);
        if (launcherPayloadDenied(payload, name)) return true;
        continue;
      }
      if (args[i] === '-') return stdinDenied();
      if (!args[i].startsWith('-')) return false; // A script on disk is opaque.
    }
    return stdinDenied();
  }
  return false;
}

function segments(tokens) {
  const commands = [];
  let words = [], redirects = [], redirect;
  for (const token of [...tokens, { op: ';' }]) {
    if (token.op) {
      if (token.newline && !words.length && !redirects.length && ['|', '|&'].includes(commands.at(-1)?.after)) continue;
      commands.push({ words, redirects, after: token.op });
      words = []; redirects = []; redirect = undefined;
    } else if (token.redirect) { redirect = { ...token }; redirects.push(redirect); }
    else if (redirect) { redirect.target = token.text; redirect = undefined; }
    else words.push(token.text);
  }
  return commands;
}

function dataSink({ words }) {
  const [executable = '', ...args] = words, name = base(executable);
  const optionStdin = (short, long) => args.some((arg, i) =>
    arg === short && args[i + 1] === '-' || arg === long && args[i + 1] === '-' || arg === `${long}=-`);
  if (name === 'git' && args[0] === 'commit') return optionStdin('-F', '--file');
  if (name === 'gh') return optionStdin(undefined, '--body-file');
  return ['cat', 'tee', 'pbcopy', 'grep', 'wc'].includes(name);
}

// Conservative across the whole source, including nested substitutions. A
// consumer hidden behind a wrapper or a quoted env split string still counts.
function hasCodeConsumer(parsed, depth, kind = true) {
  if (depth > 12) return true;
  return segments(parsed.tokens).some(({ words }) => deniedCommand(words, depth, false, [], kind)) ||
    parsed.substitutions.some(sub => hasCodeConsumer(lex(sub.body), depth + 1, kind));
}

function scanParsed(parsed, depth, inheritedHeredocs, allowData) {
  if (parsed.unsafeLines) return true;
  if (parsed.substitutions.some(sub => deniedSource(sub.body, depth + 1, [], allowData))) return true;
  const stdinSource = /\b(?:import\s+webbrowser|from\s+webbrowser\s+import)\b/.test(
    [...parsed.tokens, ...inheritedHeredocs].map(token => token.text ?? token.body ?? '').join('\n'));
  const commands = segments(parsed.tokens);
  return commands.some(({ words, redirects }, i) => {
    if (deniedCommand(words, depth, stdinSource,
      [...inheritedHeredocs, ...redirects.filter(redirect => redirect.body !== undefined)])) return true;
    if (!deniedCommand(words, depth, false, [], true)) return false;
    const shellInput = deniedCommand(words, depth, false, [], 'shell');
    const language = deniedCommand(words, depth, false, [], 'language');
    // Retain the actual pipe boundaries. Lists and separate commands do not
    // feed a later shell, while every earlier stage of one pipeline can.
    for (let j = i - 1; j >= 0 && ['|', '|&'].includes(commands[j].after); j--) {
      const producer = commands[j];
      if (streamInputDenied({ tokens: producer.words.map(text => ({ text })), substitutions: [] }, depth, shellInput, language) ||
        producer.redirects.some(redir => redir.body !== undefined &&
          (shellInput && deniedSource(redir.body, depth + 1, [], false) || launcherPayloadDenied(redir.body, language)))) return true;
    }
    return false;
  });
}

// Here-strings and process substitutions may produce code for another command
// in the pipeline. Inspect their literal words too, including echo/printf data.
function streamInputDenied(parsed, depth, shellInput = true, language = '') {
  if (depth > 12 || parsed.unsafeLines) return true;
  const words = parsed.tokens.filter(token => token.text !== undefined).map(token => token.text);
  return words.some((word, i) => launcherPayloadDenied(word, language) || shellInput &&
    (deniedCommand(words.slice(i), depth + 1, false) || /\s/.test(word) && deniedSource(word, depth + 1, [], false))) ||
    parsed.substitutions.some(sub => streamInputDenied(lex(sub.body, false, false), depth + 1, shellInput, language));
}

function deniedSource(source, depth = 0, inheritedHeredocs = [], allowData = true) {
  if (depth > 12) return true;
  const parsed = lex(source, false, allowData);
  if (parsed.unsafeLines) return true;
  const consumer = hasCodeConsumer(parsed, depth);
  const shellConsumer = hasCodeConsumer(parsed, depth, 'shell');
  const commands = segments(parsed.tokens);
  const docs = parsed.heredocs;
  // Known interpreter input gets launcher checks, never shell command parsing.
  // Unknown consumers and uncertain heredocs retain the whole-source fallback.
  const bodySink = command => dataSink(command) ||
    deniedCommand(command.words, depth, false, [], true) && !deniedCommand(command.words, depth, false, [], 'shell');
  const provenData = allowData && !parsed.uncertain && !shellConsumer && !inheritedHeredocs.length &&
    commands.every((command, i) => !['|', '|&'].includes(command.after) ||
      bodySink(command) && bodySink(commands[i + 1])) &&
    docs.every(doc => doc.matched && !/[$`]/.test(doc.delimiter)) && commands.every(command =>
      !command.redirects.some(redir => redir.body !== undefined) ||
      bodySink(command));

  // Keep raw heredoc source available to interpreter and shell consumers before
  // the fallback lexer treats its quotes as shell syntax.
  if (scanParsed(parsed, depth, inheritedHeredocs, allowData)) return true;
  if (source.includes('<<') && !provenData) {
    // No omission is authorized. Ignore heredoc syntax and scan every line as
    // well as the whole text, so a body's unmatched quote cannot hide a later
    // opener. Join continued lines for that scan. Nested data heredocs get no
    // exemption on this path.
    const whole = lex(source, false, false);
    if (scanParsed(whole, depth, inheritedHeredocs, false) || source.replace(/\\\n/g, '').split('\n').some(line =>
      scanParsed(lex(line, false, false), depth, [], false))) return true;
  } else {
    for (const doc of docs) {
      if (!doc.quoted && lex(doc.body, true, false).substitutions.some(sub => deniedSource(sub.body, depth + 1))) return true;
    }
  }
  if (consumer && /<<<|[<>]\(/.test(source)) {
    const input = lex(source, false, false);
    if (shellConsumer && streamInputDenied(input, depth, true)) return true;
    if (commands.some(({ words }) => {
      const language = deniedCommand(words, depth, false, [], 'language');
      return language && streamInputDenied(input, depth, false, language);
    })) return true;
  }
  return false;
}

export function shellLaunchDenied(event) {
  return event?.tool === 'Bash' && typeof event.command === 'string' && deniedSource(event.command);
}
