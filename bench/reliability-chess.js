// AX evidence and exact owned-game operations. CG metadata comes from the managed inspector.
ObjC.import('AppKit');
function run(argv) {
  const request = JSON.parse(argv[0]);
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.Chess');
  if (!Number(apps.count)) return JSON.stringify({ running: false, windows: [] });
  const target = apps.objectAtIndex(0), pid = Number(target.processIdentifier);
  if (request.expectedPid !== undefined && request.expectedPid !== pid) throw new Error('Chess process replaced; no input posted');
  if (request.op === 'process') return JSON.stringify({ running: true, pid });
  if (request.op === 'quit') {
    if (!Number(target.terminate)) throw new Error('Chess declined quit');
    return JSON.stringify({ pid, quitRequested: true });
  }
  const proc = Application('System Events').processes.whose({ unixId: pid })[0];
  const all = proc.windows();
  const attempt = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const records = all.map(win => {
    const p = attempt(() => win.position(), []), s = attempt(() => win.size(), []);
    return { title: attempt(() => win.name(), ''), number: attempt(() => win.attributes.byName('AXWindowNumber').value(), null),
      bounds: { X: p[0], Y: p[1], Width: s[0], Height: s[1] },
      minimized: attempt(() => win.attributes.byName('AXMinimized').value(), null),
      modified: attempt(() => win.attributes.byName('AXEdited').value(), null),
      closeValue: attempt(() => win.buttons.whose({ subrole: 'AXCloseButton' })[0].value(), null),
      main: attempt(() => win.attributes.byName('AXMain').value(), null) };
  });
  if (request.op === 'snapshot') return JSON.stringify({ running: true, pid, windows: records });
  if (request.op === 'cancel-new-game') {
    const sheets = all.flatMap(win => attempt(() => win.sheets(), [])).filter(sheet =>
      attempt(() => sheet.staticTexts(), []).some(text => attempt(() => text.name(), '') === 'Start a New Game?' || attempt(() => text.value(), '') === 'Start a New Game?'));
    if (sheets.length > 1) throw new Error('New game sheet is ambiguous');
    if (sheets.length) { sheets[0].buttons.byName('Cancel').click(); delay(0.3); }
    return JSON.stringify({ cancelled: sheets.length === 1 });
  }
  const key = title => request.allowTurnChange ? title.replace(/\s*\((?:White|Black) to Move\)$/, '') : title;
  const matches = records.map((w, i) => ({ w, i })).filter(({ w }) => key(w.title) === key(request.title) && w.bounds.Width > 400);
  if (matches.length !== 1) throw new Error('Exact owned game missing or ambiguous');
  const index = matches[0].i;
  const win = all[index], b = records[index].bounds;
  if (request.op === 'minimize' || request.op === 'restore') {
    win.attributes.byName('AXMinimized').value = request.op === 'minimize';
    if (request.op === 'restore') {
      win.attributes.byName('AXMain').value = true; win.actions.byName('AXRaise').perform();
    }
    delay(0.3);
    return JSON.stringify({ pid, title: records[index].title, minimized: win.attributes.byName('AXMinimized').value() });
  }
  if (request.op === 'close') {
    win.attributes.byName('AXMain').value = true; win.actions.byName('AXRaise').perform();
    const close = win.buttons.whose({ subrole: 'AXCloseButton' })[0]; close.click(); delay(0.3);
    const sheet = attempt(() => win.sheets[0], null);
    if (sheet) for (const button of attempt(() => sheet.buttons(), [])) {
      if (["Don't Save", 'Don’t Save', 'Delete'].includes(button.name())) button.click();
    }
    delay(0.3);
    return JSON.stringify({ closed: !proc.windows().some(w => key(attempt(() => w.name(), '')) === key(request.title)) });
  }
  if (request.op === 'labels') {
    const labels = []; let visited = 0;
    const collect = (el, depth) => {
      if (++visited > 300 || depth > 12) throw new Error('AX limit');
      labels.push({ name: attempt(() => el.name(), ''), description: attempt(() => el.description(), '') });
      for (const child of attempt(() => el.uiElements(), [])) collect(child, depth + 1);
    };
    collect(win, 0);
    return JSON.stringify({ pid, ...records[index], labels });
  }
  const squares = []; let visited = 0;
  const walk = (el, depth) => {
    if (++visited > 300 || depth > 12) throw new Error('AX limit');
    const name = attempt(() => el.description(), '');
    if (/\b(?:e2|e4)\b/.test(name)) {
      const p = el.position(), s = el.size();
      squares.push({ name, point: [p[0] + s[0] / 2 - b.X, p[1] + s[1] / 2 - b.Y], size: s });
    }
    for (const child of attempt(() => el.uiElements(), [])) walk(child, depth + 1);
  };
  walk(win, 0);
  return JSON.stringify({ pid, ...records[index], squares });
}
