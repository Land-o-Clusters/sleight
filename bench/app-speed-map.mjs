#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const catalog = [
  ['vscode', 'Visual Studio Code', 'com.microsoft.VSCode', 'Electron/CEF', 'workspace'],
  ['cursor', 'Cursor', 'com.todesktop.230313mzl4w4u92', 'Electron/CEF', 'workspace'],
  ['spotify', 'Spotify', 'com.spotify.client', 'Electron/CEF', 'existing'],
  ['word', 'Microsoft Word', 'com.microsoft.Word', 'Office', 'docx'],
  ['excel', 'Microsoft Excel', 'com.microsoft.Excel', 'Office', 'xlsx'],
  ['textedit', 'TextEdit', 'com.apple.TextEdit', 'Apple native', 'txt'],
  ['finder', 'Finder', 'com.apple.finder', 'Apple native', 'folder'],
  ['notes', 'Notes', 'com.apple.Notes', 'Apple native', 'local-container'],
  ['calendar', 'Calendar', 'com.apple.iCal', 'Apple native', 'local-container'],
  ['helium', 'Helium', 'net.imput.helium', 'Chromium', 'browser'],
  ['slack', 'Slack', 'com.tinyspeck.slackmacgap', 'Electron/CEF', 'existing', true],
  ['discord', 'Discord', 'com.hnc.Discord', 'Electron/CEF', 'existing', true],
  ['whatsapp', 'WhatsApp', 'net.whatsapp.WhatsApp', 'Account app', 'existing', true],
  ['notion', 'Notion', 'notion.id', 'Electron/CEF', 'existing', true],
  ['mail', 'Mail', 'com.apple.mail', 'Apple native', 'existing', true],
].map(([id, app, bundle, group, fixture, ownerPresent = false]) =>
  ({ id, app, bundle, class: group, fixture, ownerPresent, readOnly: ownerPresent }));

export function speedPlan({ ids, runs = 10, ownerPresent = false, concurrentApp = 'textedit', dryRun = false } = {}) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 30) throw Error('runs must be an integer from 1 to 30');
  if (ids && (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)) throw Error('apps must be a nonempty unique list');
  const apps = ids ? ids.map(id => {
    const app = catalog.find(a => a.id === id);
    if (!app) throw Error('unknown app id: ' + id);
    return app;
  }) : catalog.filter(app => !app.ownerPresent || ownerPresent);
  if (apps.some(app => app.ownerPresent) && !ownerPresent) throw Error('account apps require --owner-present');
  if (!apps.some(app => app.id === concurrentApp)) {
    if (concurrentApp === 'textedit' && ids && !ids.includes('textedit')) concurrentApp = apps[0].id;
    else throw Error('concurrent app must be selected');
  }
  return { dryRun, runs, concurrency: 4, concurrentApp, ownerPresent, apps: apps.map(app => ({ ...app, readOnly: ownerPresent || app.readOnly })),
    excluded: catalog.filter(app => !apps.includes(app)).map(app => ({ id: app.id, reason: app.ownerPresent && !ownerPresent ? 'requires --owner-present' : 'not selected' })),
    phases: ['acquire', 'first explicit full read', 'warm full read', 'unique scroll-area action', 'full readback'],
    concurrentPhases: ['acquire', 'first explicit full read', 'warm full read'],
    note: 'Acquisition includes the engine automatic initial read. Concurrent and owner-present samples send no input. Local-container away cells are unqualified and refused before host access. Owner-present reads do not prove local-container membership. A missing unique scroll target is a failed action sample.',
    prerequisites: ['background fixture ownership', 'qualified current local-container identity for away cells (unavailable)', 'local-container receipts for owner-present reads only', 'owner-approved benchmark browser profile receipt', 'workspace apps stopped before opening a fresh folder', 'live lock and hold preflights'] };
}

export function speedScope(plan, task) {
  // AX text and owner-attested IDs do not join the active document to a local container.
  // No supported joining adapter is qualified here. Refuse before acquiring any host/client.
  if (task.fixture === 'local-container' && plan.ownerPresent !== true) throw Error('LOCAL_CONTAINER_UNQUALIFIED');
  return plan.ownerPresent === true ? 'owner-present-read-only' : 'owned-fixture';
}

export async function readMetrics(handle, { marker, requiredText, scrollMarker, anyRegion } = {}) {
  const tree = await handle.getAXState({ disableDiffing: true, emit: false });
  return treeMetrics(tree, { marker, requiredText, scrollMarker, anyRegion });
}

// Serialized into the engine. Receives text, never a native handle.
function treeMetrics(tree, { marker, requiredText, scrollMarker, anyRegion } = {}) {
  if (typeof tree !== 'string') throw Error('TREE_UNAVAILABLE');
  if (marker && !tree.split('\n')[0].includes(marker) || requiredText && !tree.includes(requiredText)) throw Error('FIXTURE_IDENTITY');
  const numbered = [...tree.matchAll(/^\t*\d+ /gm)].length;
  const dom = [...tree.matchAll(/\bnode_id=/g)].length;
  // Role words counted for the receipt, longest first. Labels and values are never kept.
  const vocabulary = ['standard window', 'scroll area', 'scroll view', 'layout area', 'text entry area', 'text area', 'text view', 'web area',
    'tab group', 'static text', 'pop up button', 'menu button', 'radio button', 'check box', 'menu bar', 'menu item', 'table', 'grid',
    'outline', 'list', 'row', 'cell', 'group', 'button', 'toolbar', 'splitter', 'image', 'link', 'heading', 'window', 'dialog', 'sheet'];
  const tier1 = /^(?:scroll area|scroll view|AXScrollArea)\b/i, tier2 = /^(?:list|outline|table|grid|layout area|text area|text entry area|text view)\b/i;
  const tier3 = /^web area\b/i, legacy = /^(?:text area|text view|outline|list)\b/i, field = /^text entry area\b/i, canvas = /^layout area\b/i;
  const rows = [], stack = [], roles = {};
  for (const line of tree.split('\n')) {
    const match = /^(\t*)(\d+) (.+)$/.exec(line);
    if (!match) continue;
    const row = { depth: match[1].length, id: Number(match[2]), text: match[3], size: 0 };
    while (stack.length && stack.at(-1).depth >= row.depth) stack.pop();
    row.parents = stack.slice(); for (const parent of stack) parent.size++;
    stack.push(row); rows.push(row);
    const role = vocabulary.find(word => row.text.toLowerCase() === word || row.text.toLowerCase().startsWith(word + ' ') || row.text.toLowerCase().startsWith(word + ','));
    if (role) roles[role] = (roles[role] ?? 0) + 1;
  }
  const scrolls = rows.filter(row => tier1.test(row.text)), fallback = rows.filter(row => legacy.test(row.text));
  // Counts, depths and role words only, never text: enough to tell why a scroll target was or wasn't unique.
  const shape = { scrollAreas: scrolls.length, fallbackTargets: fallback.length, markerRows: 0, markerScrollAreas: 0,
    scrollDepths: scrolls.slice(0, 10).map(row => row.depth), markerRegions: 0, tier: 0, targetRole: null, roles };
  const largest = list => {
    const top = Math.max(...list.map(row => row.size));
    const best = list.filter(row => row.size === top);
    return best.length === 1 ? best[0].id : null;
  };
  let scrollTarget = null;
  if (scrollMarker) {
    const marked = rows.filter(row => row.text.includes(scrollMarker));
    shape.markerRows = marked.length;
    // Tier 1: the one scroll area around the fixture's own text (Word, TextEdit, Finder).
    const areas = new Map();
    for (const row of marked) { const area = row.parents.findLast(parent => tier1.test(parent.text)); if (area) areas.set(area.id, area); }
    shape.markerScrollAreas = areas.size;
    if (areas.size === 1) { scrollTarget = [...areas.keys()][0]; shape.tier = 1; }
    else if (!areas.size) {
      // Tier 2: no scroll area holds it, so the nearest list, outline, table, grid, layout or text region that does (a
      // sheet's cell table, an editor's explorer list); several such regions resolve to the largest.
      // An editable field holding the text is excluded: it shows a value (Excel's formula bar), not the document.
      const regions = new Map();
      for (const row of marked) {
        const region = [...row.parents, row].findLast(item => tier2.test(item.text) && !(item === row && field.test(row.text)));
        if (region) regions.set(region.id, region);
      }
      shape.markerRegions = regions.size;
      if (regions.size) { scrollTarget = largest([...regions.values()]); if (scrollTarget !== null) shape.tier = 2; }
      // Tier 4: the document's text isn't in the tree (Excel exposes no cells), so the document canvas, AXLayoutArea.
      if (scrollTarget === null) {
        const canvases = rows.filter(row => canvas.test(row.text));
        if (canvases.length) { scrollTarget = largest(canvases); if (scrollTarget !== null) shape.tier = 4; }
      }
    }
    // Tier 3: in an instance that is wholly the run's own, the largest scrollable region when nothing holds the marker.
    if (scrollTarget === null && anyRegion) {
      for (const tier of [tier1, tier2, tier3]) {
        const regions = rows.filter(row => tier.test(row.text));
        if (regions.length) { scrollTarget = largest(regions); break; }
      }
      if (scrollTarget !== null) shape.tier = 3;
    }
  } else {
    const targets = scrolls.length ? scrolls : fallback;
    scrollTarget = targets.length === 1 ? targets[0].id : null;
  }
  const chosen = rows.find(row => row.id === scrollTarget);
  shape.targetRole = chosen ? vocabulary.find(word => chosen.text.toLowerCase().startsWith(word)) ?? 'other' : null;
  return { chars: tree.length, nodes: numbered || dom || null, scrollTarget, shape };
}

function metrics(reply) {
  if (reply?.isError) throw Error('ENGINE_CALL_FAILED');
  const text = (reply?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const line = text.split('\n').findLast(line => line.startsWith('AM1METRICS:'));
  let value; try { value = JSON.parse(line?.slice(11)); } catch { throw Error('METRICS_UNAVAILABLE'); }
  if (!Number.isInteger(value?.chars) || value.chars < 0 ||
      value.nodes !== null && (!Number.isInteger(value.nodes) || value.nodes < 0) ||
      value.scrollTarget !== null && (!Number.isInteger(value.scrollTarget) || value.scrollTarget < 0)) throw Error('METRICS_INVALID');
  const shape = value.shape, count = item => Number.isInteger(item) && item >= 0;
  const roles = shape?.roles;
  if (shape !== undefined && !(shape && ['scrollAreas', 'fallbackTargets', 'markerRows', 'markerScrollAreas', 'markerRegions'].every(key => count(shape[key])) &&
      Array.isArray(shape.scrollDepths) && shape.scrollDepths.length <= 10 && shape.scrollDepths.every(count) && [0, 1, 2, 3, 4].includes(shape.tier) &&
      (shape.targetRole === null || /^[a-z ]{1,24}$/.test(shape.targetRole)) &&
      roles && typeof roles === 'object' && Object.keys(roles).length <= 40 &&
      Object.entries(roles).every(([role, n]) => /^[a-z ]{1,24}$/.test(role) && count(n)))) throw Error('METRICS_INVALID');
  return shape === undefined ? value : { ...value, shape: { scrollAreas: shape.scrollAreas, fallbackTargets: shape.fallbackTargets,
    markerRows: shape.markerRows, markerScrollAreas: shape.markerScrollAreas, scrollDepths: shape.scrollDepths,
    markerRegions: shape.markerRegions, tier: shape.tier, targetRole: shape.targetRole, roles: { ...roles } } };
}
const failures = new Set(['HOLD', 'TREE_UNAVAILABLE', 'FIXTURE_IDENTITY', 'ENGINE_CALL_FAILED', 'METRICS_UNAVAILABLE', 'METRICS_INVALID',
  'NO_UNIQUE_SCROLL_AREA', 'CLEANUP_UNCONFIRMED', 'SESSION_CLEANUP_UNCONFIRMED', 'FOCUS_CHANGED', 'APP_ALREADY_RUNNING',
  'FIXTURE_NOT_OPEN', 'FIXTURE_SETUP_FAILED', 'LOCAL_CONTAINER_RECEIPT_REQUIRED', 'LOCAL_CONTAINER_UNQUALIFIED', 'MACOS_REQUIRED', 'INVALID_OPTIONS',
  'CONFLICTING_OWNER_BOUNDARY', 'OWNER_BOUNDARY_REQUIRED', 'BROWSER_PROFILE_RECEIPT_REQUIRED', 'OUTPUT_OUTSIDE_BENCH_RESULTS', 'OUTPUT_SYMLINK', 'OUTPUT_ALREADY_EXISTS', 'TEMP_CLEANUP_UNCONFIRMED']);
const failureCode = error => failures.has(error?.message) ? error.message : 'READ_FAILED';
// A failed engine call keeps only AX codes and fixed error kinds, never its text.
const errorKinds = ['not scrollable', 'not found', 'timed out', 'timeout', 'invalid', 'unsupported', 'denied', 'lease', 'stale', 'covered',
  'offscreen', 'not visible', 'approval', 'busy', 'cannot complete'];
// A failed first call carries the engine's API docs ahead of its error, and sleight's relay adds its own notices after
// it. Neither is the error: on 2026-10-19 the docs' heading ("## Computer Use") became every Excel template, and words in
// the docs (timeout, unsupported, lease, approval) became its kinds, hiding 21 helper crashes.
const engineDocs = /(?:^|\n)(?:## Computer Use|# Other Browser APIs|# Computer Use Confirmations Policy|# Browser Safety|# API Reference)\n/;
const relayNotice = /^\s*sleight(?:-[a-z]+)?:/;
const helperFailures = [['crash', /sky computer use native pipe closed before response/], ['start', /sky computer use (?:native pipe|service) startup (?:request )?failed/]];
export function engineError(reply) {
  const text = (reply?.content ?? []).filter(item => item.type === 'text' && typeof item.text === 'string' && !relayNotice.test(item.text))
    .map(item => { const docs = engineDocs.exec(item.text); return docs ? item.text.slice(0, docs.index) : item.text; })
    .filter(item => item.trim()).join('\n').toLowerCase();
  // A template of the message: quoted values, paths and numbers replaced, other characters dropped. Unquoted words
  // can still be labels, so the template only goes to the local log, and the report gets its hash (same template, same hash).
  // The first three non-empty lines, since a message can run over several.
  // A quote opens only after a space or line start, so apostrophes inside words (can't, app's) stay text.
  const template = text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 3).join(' / ')
    .replace(/(^|[\s(:])(?:"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|`[^`]*`)/g, '$1_q_')
    .replace(/(?:~|\/)[^\s)]*/g, match => match === '/' ? match : '_p_').replace(/-?\d+(?:\.\d+)?/g, '_n_')
    .replace(/[^_a-z ,.:;()'/-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let hash = 0x811c9dc5;
  for (const char of template) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  // The engine helper's own failures are named by a fixed word: the crash and start messages are the engine's, not the app's.
  const helper = helperFailures.find(([, pattern]) => pattern.test(text))?.[0];
  return { template, published: { codes: [...new Set((text.match(/-25\d{3}\b/g) ?? []).map(Number))].slice(0, 5),
    kinds: errorKinds.filter(kind => text.includes(kind)), signature: hash.toString(16).padStart(8, '0'), ...(helper && { helper }) } };
}
const engineFailure = reply => { const { template, published } = engineError(reply); return { engine: published, template }; };
const steps = { acquireMs: 'acquire', firstReadMs: 'firstRead', warmReadMs: 'warmRead', actionMs: 'action', afterReadMs: 'afterRead' };

export async function runSpeedMap(plan, runtime) {
  const report = { startedUTC: new Date().toISOString(), runs: plan.runs, concurrency: plan.concurrency,
    ownerPresent: plan.ownerPresent, rows: [], cohorts: [], note: plan.note };
  const boundary = () => { if (runtime.held()) throw Error('HOLD'); };
  const sleep = runtime.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  async function cohort(task, trial, mode) {
    boundary();
    let fixture, scope, preparationStarted = false;
    try {
      scope = speedScope(plan, task);
      preparationStarted = true;
      fixture = await runtime.prepare(task, { trial, mode });
    }
    catch (error) {
      const cleanupConfirmed = !preparationStarted || error.cleanupConfirmed === true;
      report.rows.push({ app: task.id, class: task.class, ownerAccount: plan.ownerPresent || task.ownerPresent,
        scope: scope ?? 'unqualified-local-container', mode, trial, status: 'refused', failure: failureCode(error),
        acquireMs: null, firstReadMs: null, warmReadMs: null, actionMs: null, afterReadMs: null,
        chars: null, nodes: null, cleanupConfirmed,
        // Setup diagnosis is codes and counts from the live runtime (setupDiagnosis), never text.
        ...(error.setup && { setup: error.setup }), ...(Array.isArray(error.cleanupReasons) && { cleanupReasons: error.cleanupReasons }),
        ...(Array.isArray(error.attention) && { attention: error.attention }) });
      await runtime.publish(report);
      if (!cleanupConfirmed) throw Error('CLEANUP_UNCONFIRMED');
      return;
    }
    const count = mode === 'concurrent' ? plan.concurrency : 1, start = runtime.now();
    // The engine helper's crash reports present before the cell, so the cell can count the ones it adds (null: unreadable).
    let crashMark = null;
    try { crashMark = runtime.helperCrashMark?.() ?? null; } catch { crashMark = null; }
    const rows = await Promise.all(Array.from({ length: count }, async (_, sessionIndex) => {
      let session;
      const row = { app: task.id, class: task.class, ownerAccount: plan.ownerPresent || task.ownerPresent,
        scope, mode, trial, sessionIndex, status: 'failed',
        acquireMs: null, firstReadMs: null, warmReadMs: null, actionMs: null, afterReadMs: null,
        chars: null, nodes: null, cleanupConfirmed: true, setupWaitMs: fixture.setupWaitMs ?? null };
      async function timed(key, code) {
        boundary(); const start = runtime.now();
        const reply = await session.js(code);
        if (reply?.isError) throw Object.assign(Error('ENGINE_CALL_FAILED'), { step: steps[key], ...engineFailure(reply) });
        row[key] = runtime.now() - start;
      }
      try {
        boundary(); session = await runtime.openSession(task, fixture);
        const browser = task.fixture === 'browser';
        const handle = browser ? 'am1Tab' : 'am1App';
        const acquire = browser ? `var am1Choices = (await cua.listBrowsers({emit:false})).filter(b => b.name === ${JSON.stringify(task.app)} && b.id === ${JSON.stringify(fixture.browserId)} && b.profileName === ${JSON.stringify(fixture.profileName)}); if(am1Choices.length !== 1) throw Error('BROWSER_IDENTITY'); var am1Tab = await cua.createBrowserTab(am1Choices[0].id, ${JSON.stringify(fixture.url)}, {visible:false});` :
          `var am1App = await cua.getApp(${JSON.stringify(task.bundle)});`;
        // An engine that says it is busy (-25204, cannot complete) gets at most two more tries, counted in the row.
        row.acquireRetries = 0;
        for (;;) {
          try { await timed('acquireMs', acquire); break; }
          catch (error) {
            const busy = error.engine && (error.engine.codes.includes(-25204) || error.engine.kinds.some(kind => kind === 'busy' || kind === 'cannot complete'));
            if (!busy || row.acquireRetries >= 2) throw error;
            row.acquireRetries++; await sleep(500);
          }
        }
        const read = `var am1Tree = await ${handle}.getAXState({ disableDiffing: true, emit: false }); am1Tree;`;
        async function measuredRead(key) {
          // A bound standalone read follows the native lease rule and lets
          // concurrent read-only sessions avoid taking an action lease.
          await timed(key, read);
          boundary();
          const reply = await session.js(`nodeRepl.write('AM1METRICS:' + JSON.stringify((${treeMetrics.toString()})(typeof am1Tree === "string" ? am1Tree + "" : null, ${JSON.stringify({ marker: fixture.marker, requiredText: fixture.requiredText, scrollMarker: fixture.scrollMarker, anyRegion: fixture.anyRegion === true })})));`);
          if (reply?.isError) throw Object.assign(Error('ENGINE_CALL_FAILED'), { step: steps[key] + 'Metrics', ...engineFailure(reply) });
          return metrics(reply);
        }
        const first = await measuredRead('firstReadMs');
        row.chars = first.chars; row.nodes = first.nodes;
        const warm = await measuredRead('warmReadMs');
        if (warm.shape) row.treeShape = warm.shape;
        if (mode === 'sequential' && !plan.ownerPresent && !task.readOnly) {
          // A document the tree doesn't show (tier 4, Excel's canvas) doesn't scroll through the engine (10/10 failed,
          // 2026-10-19), so its action is a Page Down the app handles itself, published as a key action.
          const key = !browser && warm.shape?.tier === 4;
          if (!browser && !key && warm.scrollTarget === null) throw Error('NO_UNIQUE_SCROLL_AREA');
          row.actionKind = key ? 'key' : 'scroll';
          await timed('actionMs', browser ? 'await am1Tab.cua.scroll({x:120,y:200,scrollX:0,scrollY:400});' :
            key ? `await am1App.pressKey('Page_Down');` : `await am1App.scroll(${warm.scrollTarget}, 'down', 1);`);
          const after = await measuredRead('afterReadMs');
          row.afterChars = after.chars; row.afterNodes = after.nodes;
        }
        row.status = 'complete';
      } catch (error) {
        row.failure = failureCode(error); if (!session) row.cleanupConfirmed = error.cleanupConfirmed === true;
        if (error.step) {
          row.failedStep = error.step; row.engineError = error.engine;
          runtime.log?.(`AM1_ENGINE_ERROR ${task.id} ${error.step} ${error.template}`);
        }
      }
      finally {
        if (session) {
          try { await session.close(); }
          catch { row.cleanupConfirmed = false; row.status = 'failed'; row.failure = 'SESSION_CLEANUP_UNCONFIRMED'; }
        }
      }
      return row;
    }));
    let cleanup;
    try { cleanup = await runtime.closeFixture(fixture); } catch { cleanup = { confirmed: false }; }
    // Counted after cleanup: macOS writes a crash report about half a second after the crash. A count, never a name or path.
    let helperCrashes = null;
    try { if (crashMark !== null) helperCrashes = runtime.helperCrashesSince(crashMark); } catch { helperCrashes = null; }
    for (const row of rows) {
      row.cleanupConfirmed &&= cleanup?.confirmed === true;
      row.cleanupReasons = cleanup?.reasons ?? [];
      row.attention = cleanup?.attention ?? [];
      if (Number.isInteger(helperCrashes)) row.helperCrashes = helperCrashes;
      if (Array.isArray(cleanup?.windows)) row.cleanupWindows = cleanup.windows;
      if (cleanup?.focusChanged) {
        if (row.failure && row.failure !== 'FOCUS_CHANGED') row.sessionFailure = row.failure;
        row.status = 'unsafe'; row.failure = 'FOCUS_CHANGED';
      }
    }
    report.rows.push(...rows);
    if (mode === 'concurrent') report.cohorts.push({ app: task.id, trial, sessions: count, wallMs: runtime.now() - start,
      ...(Number.isInteger(helperCrashes) && { helperCrashes }) });
    report.summary = summarizeSpeedMap(report);
    await runtime.publish(report);
    if (rows.some(row => !row.cleanupConfirmed)) throw Error('CLEANUP_UNCONFIRMED');
    if (cleanup?.focusChanged) throw Error('FOCUS_CHANGED');
  }
  for (const task of plan.apps) for (let trial = 1; trial <= plan.runs; trial++) await cohort(task, trial, 'sequential');
  const concurrent = plan.apps.find(app => app.id === plan.concurrentApp);
  for (let trial = 1; trial <= plan.runs; trial++) await cohort(concurrent, trial, 'concurrent');
  report.summary = summarizeSpeedMap(report); report.finishedUTC = new Date().toISOString();
  await runtime.publish(report); return report;
}

export function summarizeSpeedMap({ rows, cohorts = [] }) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.app + ':' + row.mode;
    if (!groups.has(key)) groups.set(key, { app: row.app, class: row.class, ownerAccount: row.ownerAccount === true, mode: row.mode, rows: [] });
    groups.get(key).rows.push(row);
  }
  const stats = values => {
    values = values.filter(Number.isFinite).sort((a, b) => a - b);
    const n = values.length;
    return { n, median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
      p90: n ? values[Math.ceil(n * 0.9) - 1] : null };
  };
  return [...groups.values()].map(group => {
    const completed = group.rows.filter(row => row.status === 'complete' && row.cleanupConfirmed !== false);
    const qualifiedCohorts = group.mode === 'concurrent' ? cohorts.filter(cohort => cohort.app === group.app &&
      group.rows.filter(row => row.trial === cohort.trial).length === cohort.sessions &&
      group.rows.filter(row => row.trial === cohort.trial).every(row => row.status === 'complete' && row.cleanupConfirmed !== false)) : [];
    return { app: group.app, class: group.class, ownerAccount: group.ownerAccount, mode: group.mode,
      scope: [...new Set(group.rows.map(row => row.scope ?? 'unknown'))].join(', '),
      failures: [...new Set(group.rows.filter(row => row.failure).map(row => row.setup?.message ? `${row.failure}:${row.setup.message}`
        : row.failedStep ? `${row.failure}:${row.failedStep}${row.engineError?.helper ? `:helper-${row.engineError.helper}` : ''}` : row.failure))],
      // One fixture per cell: count its attention events once, not once per concurrent session.
      attention: group.rows.filter(row => !row.sessionIndex).flatMap(row => row.attention ?? [])
        .reduce((counts, event) => ({ ...counts, [event.class]: (counts[event.class] ?? 0) + 1 }), {}),
      cohortWallMs: stats(qualifiedCohorts.map(cohort => cohort.wallMs)), attempted: group.rows.length, completed: completed.length,
      actionKinds: [...new Set(completed.map(row => row.actionKind).filter(Boolean))],
      // One count per fixture cell, like attention; null when no cell could read the crash reports.
      helperCrashes: group.rows.some(row => !row.sessionIndex && Number.isInteger(row.helperCrashes))
        ? group.rows.filter(row => !row.sessionIndex && Number.isInteger(row.helperCrashes)).reduce((sum, row) => sum + row.helperCrashes, 0) : null,
      ...Object.fromEntries(['setupWaitMs', 'acquireMs', 'firstReadMs', 'warmReadMs', 'actionMs', 'afterReadMs', 'chars', 'nodes']
        .map(key => [key, stats(completed.map(row => row[key]))])) };
  });
}

export function speedMarkdown(report) {
  const rounded = value => Number(value.toFixed(2));
  const cell = value => value.n ? `${rounded(value.median)} / ${rounded(value.p90)} (n=${value.n})` : 'not measured';
  const rows = [...(report.summary ?? summarizeSpeedMap(report))].sort((a, b) => a.class.localeCompare(b.class) || a.app.localeCompare(b.app));
  const table = selected => '| Class | App | Mode | Scope | Failure | Attention | Complete | Setup wait | Acquire | First read | Warm read | Action | Readback | Characters | Nodes | Cohort lifecycle |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' + selected.map(row =>
      `| ${row.class} | ${row.app} | ${row.mode} | ${row.scope ?? 'unknown'} | ${(row.failures ?? []).join(', ') || 'none'} | ` +
      `${Object.entries(row.attention ?? {}).map(([name, count]) => `${name} ${count}`).join(', ') || 'none'} | ${row.completed}/${row.attempted} | ` +
      ['setupWaitMs', 'acquireMs', 'firstReadMs', 'warmReadMs', 'actionMs', 'afterReadMs', 'chars', 'nodes', 'cohortWallMs'].map(key =>
        cell(row[key] ?? { n: 0 }) + (key === 'actionMs' && (row.actionKinds ?? []).includes('key') ? ' (key)' : '')).join(' | ') + ' |').join('\n') + '\n';
  const account = rows.filter(row => row.ownerAccount), background = rows.filter(row => !row.ownerAccount);
  const crashed = rows.filter(row => row.helperCrashes > 0);
  const crashes = crashed.length ? '\nEngine helper crash reports written during the cells (SkyComputerUseService, any client): ' +
    crashed.map(row => `${row.app} ${row.mode} ${row.helperCrashes}`).join(', ') + '. sleight resends a read that met a crash once, so a crash can ' +
    'show up as a slower acquisition instead of a failure.\n' : '';
  return '# App-class speed map\n\nTimes in ms, median / p90 (nearest rank). Counts describe the first explicit full read. ' +
    'Only complete trials contribute to these summaries. Setup wait runs from the return of the open command to an identified fixture window. ' +
    'Cohort lifecycle includes session startup, reads and cleanup.\n\n' +
    (background.length ? table(background) : '') + crashes +
    (account.length ? '\n## Owner-present reads\n\nTiming and tree counts only. Local-container membership is unproved.\n\n' + table(account) : '');
}

// Rough per-cell seconds for the dry run's estimate, not a measurement. TextEdit measured acquisition at 1.25 s and a
// scroll at 0.92 s (2026-10-14); launch, client start and quit are assumed. The bound adds every timeout a cell can reach.
const ESTIMATE = { sequential: 15, concurrent: 20, startup: 80, phase: 60, cleanup: 50 };

// Runs the real scheduler against an in-memory runtime: every planned cell, its engine calls and refusals, with no app,
// engine, lock, file or child process.
export async function simulateSpeedMap(plan) {
  const steps = new Map(), sessions = new Map(), totals = { fixtures: 0, engineCalls: 0, scrolls: 0 };
  const key = (app, mode, trial) => `${app}:${mode}:${trial}`;
  const runtime = {
    held: () => false, now: () => 0, async publish() {}, async closeFixture() { return { confirmed: true, reasons: [] }; },
    async prepare(task, { trial, mode }) {
      totals.fixtures++;
      return { marker: 'AM1-simulated', cell: key(task.id, mode, trial),
        ...(task.fixture === 'browser' && { url: 'http://127.0.0.1:1/fixture', browserId: 'simulated', profileName: 'simulated' }) };
    },
    async openSession(task, fixture) {
      const index = sessions.get(fixture.cell) ?? 0; sessions.set(fixture.cell, index + 1);
      if (!index) steps.set(fixture.cell, []);
      return { async close() {}, async js(code) {
        totals.engineCalls++;
        if (code.includes('AM1METRICS')) return { content: [{ type: 'text', text: 'AM1METRICS:' + JSON.stringify({ chars: 0, nodes: 0, scrollTarget: 1 }) }] };
        const step = /getApp|createBrowserTab/.test(code) ? 'acquire' : /scroll\(/.test(code) ? 'scroll' : /pressKey\(/.test(code) ? 'key'
          : /getAXState/.test(code) ? 'read' : 'other';
        if (step === 'scroll') totals.scrolls++;
        if (!index) steps.get(fixture.cell).push(step);
        return { content: [] };
      } };
    },
  };
  const report = await runSpeedMap(plan, runtime);
  const cells = [];
  for (const row of report.rows) {
    const id = key(row.app, row.mode, row.trial);
    if (cells.some(cell => cell.id === id)) continue;
    cells.push({ id, app: row.app, mode: row.mode, trial: row.trial, status: row.status, ...(row.failure && { failure: row.failure }),
      sessions: sessions.get(id) ?? 0, steps: steps.get(id) ?? [] });
  }
  const sequential = cells.filter(cell => cell.mode === 'sequential' && cell.sessions).length;
  const concurrent = cells.filter(cell => cell.mode === 'concurrent' && cell.sessions).length;
  const typicalSeconds = sequential * ESTIMATE.sequential + concurrent * ESTIMATE.concurrent;
  const boundSeconds = cells.filter(cell => cell.sessions).reduce((sum, cell) =>
    sum + ESTIMATE.startup + cell.steps.length * ESTIMATE.phase + ESTIMATE.cleanup, 0);
  const defaultCohort = plan.concurrentApp === 'textedit' || plan.concurrentApp === plan.apps[0].id;
  const liveCommand = ['node bench/app-speed-map.mjs', plan.ownerPresent ? '--owner-present' : '--owner-away',
    '--apps', plan.apps.map(app => app.id).join(','), '--runs', String(plan.runs),
    ...(defaultCohort ? [] : ['--concurrent-app', plan.concurrentApp])].join(' ');
  // The live runtime refuses the whole run before any lock or app when one of these receipts is missing.
  const receiptsRequired = plan.apps.filter(app => app.fixture === 'browser' || app.fixture === 'local-container' && plan.ownerPresent).map(app => app.id);
  return { cells: cells.map(({ id, ...cell }) => cell), totals, receiptsRequired, estimate: { typicalSeconds, boundSeconds,
    basis: 'estimate, not measured: 15 s per sequential cell and 20 s per cohort; the bound adds every timeout' }, liveCommand };
}

export async function main(argv = process.argv.slice(2)) {
  const values = {}, flags = new Set(['--dry-run', '--owner-present', '--owner-away']);
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) { values[argv[i].slice(2)] = true; continue; }
    if (!['--runs', '--apps', '--concurrent-app', '--receipts', '--out'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('INVALID_OPTIONS');
    values[argv[i].slice(2)] = argv[++i];
  }
  if (values['owner-away'] && values['owner-present']) throw Error('CONFLICTING_OWNER_BOUNDARY');
  const plan = speedPlan({ ids: values.apps?.split(','), runs: values.runs === undefined ? 10 : Number(values.runs),
    ownerPresent: Boolean(values['owner-present']), concurrentApp: values['concurrent-app'] ?? 'textedit', dryRun: Boolean(values['dry-run']) });
  if (plan.dryRun) { console.log(JSON.stringify({ ...plan, simulation: await simulateSpeedMap(plan) }, null, 2)); return 0; }
  if (!values['owner-away'] && !values['owner-present']) throw Error('OWNER_BOUNDARY_REQUIRED');
  const { liveSpeedRuntime } = await import('./app-speed-map-live.mjs');
  const runtime = await liveSpeedRuntime(plan, values);
  try { const report = await runSpeedMap(plan, runtime); return report.rows.every(row => row.status === 'complete') ? 0 : 1; }
  finally { await runtime.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(failureCode(error)); process.exitCode = 1; });
}
