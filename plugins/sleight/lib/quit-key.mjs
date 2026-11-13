// Shared by the native runtime proxy and turbo. Install the helpers together in
// the engine's JavaScript realm; none may depend on other module state.
export const QUIT_KEY_REFUSAL = /* notice */ "sleight quit-key rule: only plain Cmd+Q is permitted by your request to quit this app; force-quit, log-out and lock shortcuts always refuse; nothing was sent for this action; earlier actions in this cell may already have run.";

export function quitKeyToken(token) {
  const aliases = { cmd: 'cmd', command: 'cmd', meta: 'meta', super: 'cmd', hyper: 'hyper', '⌘': 'cmd',
    controlormeta: 'cmd', cmdorctrl: 'cmd', commandorcontrol: 'cmd',
    ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl', alt: 'alt', option: 'alt', '⌥': 'alt',
    shift: 'shift', '⇧': 'shift', esc: 'escape', escape: 'escape', '\u001b': 'escape', keyq: 'q' };
  const lower = token.toLowerCase();
  const base = lower.replace(/(?:_[lr]|_?left|_?right)$/, '');
  return aliases[base] ?? lower;
}

export function quitKeyBlocked(method, args, allowPlainQuit = false, held = []) {
  if (!['pressKey', 'press', 'typeText', 'click', 'doubleClick', 'rightClick', 'drag', 'scroll',
    'modifiers', 'keyDown', 'key_down'].includes(method)) return false;
  if (method === 'modifiers' && args[0]?.state === 'up') return false;
  const parts = value => typeof value === 'string' ? value.split('+').map(s => s.trim())
    : Array.isArray(value) ? value.flatMap(parts) : [];
  const base = token => token.toLowerCase().replace(/(?:_[lr]|_?left|_?right)$/, '');
  // Meta can mean Command or Option; Hyper can hold all four modifiers. Keep
  // every interpretation for blocking and raw tokens for the narrow exception.
  const fold = tokens => tokens.flatMap(token => {
    const key = quitKeyToken(token);
    if (key === 'hyper') return ['cmd', 'alt', 'ctrl', 'shift'];
    return key === 'meta' ? ['cmd', 'alt'] : [key];
  });
  const singleCommand = token => ['cmd', 'command', 'super', 'meta', '⌘'].includes(base(token));
  const modifiers = [...held, ...args.flatMap((value, index) => value && typeof value === 'object' && !Array.isArray(value)
    ? ['key', 'modifier', 'modifiers', ...(method === 'modifiers' ? ['keys'] : [])].flatMap(key => parts(value[key])) : index ? parts(value) : [])];
  const foldedModifiers = fold(modifiers);
  if (method === 'typeText') {
    // Ordinary typing cannot be a quit chord. Avoid walking or allocating its text.
    if (!foldedModifiers.includes('cmd') || typeof args[0] !== 'string') return false;
    if (allowPlainQuit && args[0] === 'q' && modifiers.length === 1 && singleCommand(modifiers[0])) return false;
    return foldedModifiers.includes('q') || /q/i.test(args[0]) || foldedModifiers.includes('alt') && (foldedModifiers.includes('escape') || args[0].includes('\u001b'));
  }
  const isPress = ['pressKey', 'press'].includes(method);
  const tokens = [...modifiers, ...(isPress || ['keyDown', 'key_down'].includes(method) ? parts(args[0]) : [])];
  if (allowPlainQuit && isPress && tokens.length === 2 && tokens.includes('q') && tokens.some(singleCommand) &&
      (!held.length || held.length === 1 && singleCommand(held[0]) && args[0] === 'q')) return false;
  const all = new Set(fold(tokens));
  // Superset matching deliberately keeps unknown extra modifiers from weakening the rule.
  return all.has('cmd') && (all.has('q') || all.has('alt') && all.has('escape'));
}

// RT5's modifier API and Sky's documented down/up chord API. Unknown shapes refuse
// before dispatch. Retain original spellings so two Command tokens cannot become
// one token for the plain-quit exception. Releases use the predicate's canonical
// aliases but keep modifier sides distinct. An unsided release clears every side.
export function heldKeyChange(method, args, held = []) {
  const modifiers = method === 'modifiers', value = args[0];
  const down = modifiers ? value?.state === 'down' : ['keyDown', 'key_down'].includes(method);
  const parts = key => typeof key === 'string' && key.length > 0 && key.length <= 256
    ? key.split('+').map(token => token.trim()) : [];
  const modifier = token => /^(?:(?:cmd|command|super|meta|hyper|ctrl|control|alt|option|shift)(?:_[lr]|_?left|_?right)?|controlormeta|cmdorctrl|commandorcontrol|[⌘⌃⌥⇧])$/i.test(token);
  let tokens;
  if (modifiers) {
    if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'keys,state' || !['down', 'up'].includes(value.state) ||
        !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 4) return null;
    tokens = value.keys.flatMap(parts);
    if (tokens.length !== value.keys.length || tokens.some(token => !modifier(token))) return null;
  } else {
    if (!['keyDown', 'key_down', 'keyUp', 'key_up'].includes(method) || args.length !== 1) return null;
    if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['key', 'window'].includes(key)))) return null;
    tokens = parts(typeof value === 'string' ? value : value?.key);
    // Unknown held spellings may be modifiers on another backend. Do not let
    // them create a hold the predicate cannot interpret. Ordinary pressKey's
    // existing grammar is unchanged.
    if (tokens.some(token => !modifier(token) && [...token].length !== 1 &&
        !/^(?:key[a-z]|escape|esc|return|enter|tab|space|backspace|delete|del|insert|home|end|(?:arrow)?(?:left|right|up|down)|page_?(?:up|down)|prior|next|f(?:[1-9]|[12][0-9]|3[0-5])|kp_(?:[0-9]|left|right|up|down|enter|add|subtract|multiply|divide|decimal|equal))$/i.test(token))) return null;
  }
  if (!tokens.length || tokens.some(token => !token)) return null;
  const id = token => token.toLowerCase();
  const side = token => {
    const suffix = modifier(token) && /(?:_([lr])|_?(left|right))$/i.exec(token);
    return suffix ? (suffix[1] ?? suffix[2][0]).toLowerCase() : null;
  };
  const keys = tokens.map(token => ({ key: quitKeyToken(token), side: side(token) }));
  return { down, next: down ? [...held, ...tokens.filter(token => !held.some(key => id(key) === id(token)))]
    : held.filter(token => {
      const key = quitKeyToken(token), heldSide = side(token);
      return !keys.some(release => release.key === key && (!release.side || !heldSide || release.side === heldSide));
    }) };
}

export function quitAppAllowed(app, requests) {
  const normalize = value => typeof value === 'string' ? value.trim().replace(/\.app$/i, '').toLowerCase() : '';
  const name = normalize(app);
  return !!name && Array.isArray(requests) && requests.some(request => normalize(request) === name);
}

// This consumes only the existing authenticated turn-message reader. Store app names,
// never the full message, in the native runtime. Ambiguous or indirect requests refuse.
export function requestedQuitApps(text, { menu = false } = {}) {
  if (typeof text !== 'string') return [];
  // Quoted instructions and code remain data. Only a quoted name immediately
  // after the requested imperative can contribute authority.
  const quotedName = menu ? /\b(?:quit|exit|open|choose|click)\s+(?:(?:the|app|application)\s+)*$/i : /\b(?:quit|exit)\s+(?:(?:the|app|application)\s+)*$/i;
  const source = text.replace(/`[^`]*`/gs, ' ').replace(/"[^"\n]*"|'[^'\n]*'/g, (quoted, at) =>
    quotedName.test(text.slice(0, at)) ? quoted : ' ');
  const apps = [];
  for (const clause of source.split(/[;!?\n]|\.(?=\s|$)|,|\b(?:and|then)\b/i)) {
    // One request check for keys and menus, with the same imperative, clause,
    // negation and indirect-instruction handling. Menu mode widens only verbs.
    const match = /^\s*(?:(?:please|now)\s+|(?:can|could|would|will)\s+you\s+)*(force[ -]?(?:quit|exit)|quit|exit|log[ -]?out|shut[ -]?down|restart|lock screen|sleep|open|choose|click)(?:\s+(.+?))?\s*$/i.exec(clause);
    if (!match || !menu && !/^(?:force[ -]?)?(?:quit|exit)$/i.test(match[1])) continue;
    const verb = match[1].toLowerCase().replace(/-/g, ' ');
    const name = (match[2] ?? '').replace(/^(?:(?:the|app|application)\s+)+/i, '')
      .replace(/\s+(?:now|please|for me|after\b.*|once\b.*|when\b.*)$/i, '').trim().replace(/^["']|["']$/g, '');
    if (name.length > 128 || /\b(?:not|never|don't|do not|unless|if|says?|asks?|instructions?)\b/i.test(name)) continue;
    if (!menu) { if (name) apps.push(name); continue; }
    if (['quit', 'exit'].includes(verb)) {
      if (name) apps.push('menu:quit:' + name.replace(/\.app$/i, ''));
    } else if (['open', 'choose', 'click'].includes(verb)) {
      if (name) {
        apps.push('menu:label:' + name);
        // A literal "open x from Recent Items" names both the leaf and its
        // submenu, without authorizing any sibling in that submenu.
        const path = /^(.+?)\s+from\s+(.+?)$/i.exec(name);
        if (path) for (const label of path.slice(1)) apps.push('menu:label:' + label.replace(/^["']|["']$/g, '').trim());
      }
    } else {
      const system = verb.replace(/^logout$/, 'log out').replace(/^shutdown$/, 'shut down')
        .replace(/^force(?:quit|exit)$/, 'force quit').replace(/^force exit$/, 'force quit');
      const computer = /^(?:(?:of|from)\s+)?(?:(?:this|the|my)\s+)?(?:mac|computer|machine|system)$/i.test(name);
      apps.push('menu:session:' + system + (name && !computer ? ':' + name : ''));
      // An app-specific force-quit request may open the system chooser, but
      // cannot authorize a differently named app's direct command.
      if (system === 'force quit' && name) apps.push('menu:chooser:force quit');
    }
  }
  return [...new Set(apps)];
}
