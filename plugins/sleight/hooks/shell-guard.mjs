// A literal-command guard, not a shell sandbox. Never evaluate shell text or
// inspect scripts on disk. Opaque programs remain subject to the host's policy.
export const shellGuardReason = "sleight's shell guard for this turn blocked a launch that could take focus. Use browser_open for a background tab or sleight tools for apps. Headless browser runs are allowed. Set SLEIGHT_SHELL_GUARD=0 to turn this guard off.";

// Browser aliases identify CLI headless support, not app-specific UI behavior.
const headlessBrowser = /^(?:(?:google[ -])?chrome(?:[ -](?:stable|beta|unstable|canary|for testing))?|chromium(?:-browser)?|chromium-headless-shell|chrome-headless-shell|helium|firefox(?:[ -](?:esr|nightly))?|msedge|microsoft edge(?: (?:beta|dev|canary))?|brave(?:-browser| browser)?|opera)$/i;
const guiLauncher = /^(?:open|xdg-open|sensible-browser|osascript|safari)$/i;
const shell = /^(?:ba|z|da|k)?sh$/;
const python = /^python(?:\d+(?:\.\d+)*)?$/;
const base = word => word.split('/').at(-1);

// Preserve operators inside quotes as data and join quoted/escaped word parts.
// Substitutions execute even within double quotes, so check their bodies too.
function lex(source, expansionOnly = false) {
  const tokens = [], substitutions = [];
  const heredocs = [];
  let text = '', active = false, quote = '', quoted = false, awaitingHeredoc;
  const flush = () => {
    if (active) {
      tokens.push({ text });
      if (awaitingHeredoc) {
        heredocs.push(Object.assign(awaitingHeredoc, { delimiter: text, quoted }));
        awaitingHeredoc = undefined;
      }
    }
    text = ''; active = false; quoted = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && quote !== "'") {
      quoted = true;
      const next = source[++i] ?? '';
      if (next !== '\n') { text += next; active = true; }
    } else if (quote !== "'" && (c === '`' || c === '$' && source[i + 1] === '(')) {
      const backtick = c === '`', start = i + (backtick ? 1 : 2);
      let j = start, nesting = 1, innerQuote = '';
      for (; j < source.length; j++) {
        const x = source[j];
        if (x === '\\') { j++; continue; }
        if (backtick) { if (x === '`') break; continue; }
        if (innerQuote) { if (x === innerQuote) innerQuote = ''; continue; }
        if (x === "'" || x === '"') { innerQuote = x; continue; }
        if (x === '(') nesting++;
        if (x === ')' && --nesting === 0) break;
      }
      substitutions.push(source.slice(start, j));
      text += '$substitution'; active = true; i = j;
    } else if (quote) {
      if (c === quote) quote = ''; else text += c;
    } else if (!expansionOnly && (c === "'" || c === '"')) { quote = c; quoted = true; active = true; }
    else if (!expansionOnly && c === '#' && !active) { while (i + 1 < source.length && source[i + 1] !== '\n') i++; }
    else if (c === '\n' || ';&|()'.includes(c) || '{}'.includes(c) && !active && /^[\s;]?$/.test(source[i + 1] ?? '')) {
      flush();
      const pair = c + source[i + 1];
      tokens.push({ op: ['&&', '||', '|&'].includes(pair) ? (i++, pair) : c === '\n' ? ';' : c });
      if (c === '\n' && heredocs.length) {
        let cursor = i + 1;
        for (const doc of heredocs.splice(0)) {
          const start = cursor;
          let bodyEnd = cursor;
          while (cursor < source.length) {
            const end = source.indexOf('\n', cursor), next = end < 0 ? source.length : end;
            const line = source.slice(cursor, next);
            const terminator = doc.redirect === '<<-' ? line.replace(/^\t+/, '') : doc.redirect === '<<~' ? line.trimStart() : line;
            if (terminator === doc.delimiter) { bodyEnd = cursor; cursor = end < 0 ? next : next + 1; break; }
            cursor = end < 0 ? next : next + 1;
            bodyEnd = cursor;
          }
          doc.body = source.slice(start, bodyEnd);
          // An unquoted data heredoc expands substitutions, but its plain
          // text is never a list of commands. Quoted delimiters expand none.
          if (!doc.quoted) substitutions.push(...lex(doc.body, true).substitutions);
        }
        i = cursor - 1;
      }
    } else if (!expansionOnly && '<>'.includes(c)) {
      // A redirection's operand is data, not the command being launched.
      if (/^\d+$/.test(text)) { text = ''; active = false; }
      flush();
      let op = c;
      while (source[i + 1] === c || source[i + 1] === '&' || source[i + 1] === '-' || source[i + 1] === '~') op += source[++i];
      const token = { redirect: op };
      tokens.push(token);
      if (/^<<[-~]?$/.test(op)) { token.body = ''; awaitingHeredoc = token; }
    } else if (/\s/.test(c)) flush();
    else { text += c; active = true; }
  }
  flush();
  return { tokens, substitutions };
}

function deniedCommand(words, depth, stdinSource, heredocs = []) {
  if (depth > 12) return true;
  while (words.length && (/^[A-Za-z_][\w]*=/.test(words[0]) || ['!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until'].includes(words[0]))) words = words.slice(1);
  if (!words.length) return false;
  const name = base(words[0]), args = words.slice(1);
  // Unwrap ordinary launch prefixes without allowing flags to hide a command.
  if (['command', 'builtin', 'exec', 'nohup', 'env', 'sudo', 'nice', 'time', 'xargs', 'arch', 'timeout', 'caffeinate', 'setsid', 'stdbuf', 'script', 'launchctl'].includes(name)) {
    let i = 0;
    const takesValue = { env: ['-u', '--unset', '-C', '--chdir'], sudo: ['-u', '-g', '-h', '-p', '-C', '-T'],
      nice: ['-n'], time: ['-o', '--output', '-f', '--format'], xargs: ['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a'],
      exec: ['-a'], arch: ['-arch', '-d', '-e'], timeout: ['-s', '--signal', '-k', '--kill-after'],
      caffeinate: ['-t', '-w'], stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
      script: ['-t', '-I', '-O', '-B', '-T', '--log-in', '--log-out', '--log-io', '--log-timing'] };
    if (name === 'launchctl') return args[0] === 'asuser' && deniedCommand(args.slice(2), depth + 1, stdinSource, heredocs);
    while (i < args.length) {
      if (name === 'env' && ['-S', '--split-string'].includes(args[i])) return deniedSource(args.slice(i + 1).join(' '), depth + 1, heredocs);
      if (name === 'env' && /^--split-string=/.test(args[i])) return deniedSource(args[i].slice(15) + ' ' + args.slice(i + 1).join(' '), depth + 1, heredocs);
      if (name === 'script' && ['-c', '--command'].includes(args[i])) return deniedSource(args[i + 1] ?? '', depth + 1, heredocs);
      if (name === 'script' && args[i].startsWith('--command=')) return deniedSource(args[i].slice(10), depth + 1, heredocs);
      const scriptCommand = name === 'script' && /^-[^-c]*c(.*)$/s.exec(args[i]);
      if (scriptCommand) return deniedSource(scriptCommand[1] || args[i + 1] || '', depth + 1, heredocs);
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
    if (name === 'timeout' || name === 'script') i++; // Duration or transcript path, then the command.
    return deniedCommand(args.slice(i), depth + 1, stdinSource, heredocs);
  }
  if (name === 'find') return args.some((arg, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg) && deniedCommand(args.slice(i + 1), depth + 1, stdinSource, heredocs));
  if (name === 'eval') return deniedSource(args.join(' '), depth + 1, heredocs);
  if (shell.test(name)) {
    const at = args.findIndex(arg => /^-[^-]*c/.test(arg));
    return at >= 0 ? deniedSource(args[at + 1] ?? '', depth + 1, heredocs) : heredocs.some(doc => deniedSource(doc.body, depth + 1));
  }
  if (guiLauncher.test(name) || name === 'gio' && args[0] === 'open') return true;
  const browser = headlessBrowser.test(name);
  if (browser || /\.app\/Contents\/MacOS\//i.test(words[0])) {
    // Only a browser with known CLI support gets a headless exemption. Flags
    // after --, strings containing a flag, and --headless=false grant nothing.
    const flags = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
    return !(browser && !flags.some(arg => arg.startsWith('--headless=') && !/^--headless=(?:new|old|true)$/.test(arg)) &&
      (flags.some(arg => /^--headless(?:=(?:new|old|true))?$/.test(arg)) || args.length === 1 && ['--version', '--help'].includes(args[0])));
  }
  if (python.test(name)) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--') return args[i + 1] === '-' && stdinSource;
      if (['-W', '-X'].includes(args[i])) { i++; continue; }
      const option = /^-[bBdEhiIOPqRsSuvV]*([cm])(.*)$/s.exec(args[i]);
      if (option) {
        const payload = option[2] || args[i + 1] || '';
        return option[1] === 'm' ? payload === 'webbrowser' : /\bwebbrowser\b/.test(payload);
      }
      if (!args[i].startsWith('-')) return false; // A script on disk is opaque.
    }
    return stdinSource;
  }
  return false;
}

function deniedSource(source, depth = 0, inheritedHeredocs = []) {
  if (depth > 12) return true;
  const { tokens, substitutions } = lex(source);
  if (substitutions.some(body => deniedSource(body, depth + 1))) return true;
  let words = [], redirect = false, heredocs = [];
  const stdinSource = /\b(?:import\s+webbrowser|from\s+webbrowser\s+import)\b/.test([...tokens, ...inheritedHeredocs].map(token => token.text ?? token.body ?? '').join('\n'));
  for (const token of [...tokens, { op: ';' }]) {
    if (token.op) {
      if (deniedCommand(words, depth, stdinSource, [...inheritedHeredocs, ...heredocs])) return true;
      words = []; redirect = false; heredocs = [];
    } else if (token.redirect) { redirect = true; if (token.body !== undefined) heredocs.push(token); }
    else if (redirect) redirect = false;
    else words.push(token.text);
  }
  return false;
}

export function shellLaunchDenied(event) {
  return event?.tool === 'Bash' && typeof event.command === 'string' && deniedSource(event.command);
}
