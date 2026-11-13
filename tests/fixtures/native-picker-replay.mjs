// Offline engine boundary. No app, Accessibility, browser or model calls.
import assert from 'node:assert/strict';
import { sameElement, windowFromText } from '../../plugins/sleight/lib/document-scope.mjs';

export const fixtureWindow = { title: 'Fixture catalog', app: 'Fixture', url: null };
const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export function labelsFor(family, count = 240) {
  const syllables = ['Alder', 'Birch', 'Cedar', 'Elm', 'Juniper', 'Maple', 'Oak', 'Pine', 'Willow'];
  return Array.from({ length: count }, (_, i) => family === 'numeric' ? `Part ${i * 7 + 13}`
    : family === 'accented' ? `Étage ${String.fromCharCode(65 + i % 26)}${String.fromCharCode(97 + Math.floor(i / 26))} ${i}`
      : `${syllables[i % syllables.length]} ${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + i % 26)} ${i}`)
    .sort(compare);
}

export function virtualList({ family = 'numeric', count = 240, targetIndex = 127, visible = 10, overscan = 3,
  keyRows = 2, wheelRows = 7, start = 0, delayedFrame = false, permanentFrame = false,
  changingBand = false, focusRecovery = false, mutate = '', afterClick = '', missing = false, frameDelay = 120 } = {}) {
  const names = labelsFor(family, count), target = names[targetIndex];
  if (missing) names.splice(targetIndex, 1);
  const m = { names, target, time: 0, reads: 0, keys: 0, ticks: 0, attempts: 0, noFrames: 0,
    selected: undefined, focus: focusRecovery ? 'container' : 'list', focusClicks: [], chosen: [],
    top: start, rendered: [], readyAt: Infinity, waits: [], movesAfterFailure: 0, listLine: 'list Catalog' };
  const clamp = top => Math.max(0, Math.min(names.length - visible, top));
  const body = label => `text (${label === m.selected ? 'selected' : 'selectable'}) ${label}`;
  const advance = (direction, units) => { m.time++; m.top = clamp(m.top + direction * units); if (m.noFrames) m.movesAfterFailure++; };
  m.press = async key => {
    assert.equal(m.focus, 'list', 'no key without list focus');
    assert.ok(['Page_Up', 'Page_Down'].includes(key));
    m.keys++; advance(key === 'Page_Down' ? 1 : -1, keyRows);
  };
  m.scroll = async (line, direction, ticks) => {
    assert.equal(line, m.listLine, 'wheel must target a list from the freshest tree');
    assert.ok(['up', 'down'].includes(direction));
    assert.ok(Number.isInteger(ticks) && ticks > 0);
    m.ticks += ticks; advance(direction === 'down' ? 1 : -1, ticks * wheelRows);
  };
  m.sleep = async ms => { m.waits.push(ms); m.time += ms; };
  m.tree = async () => {
    m.reads++; m.time++;
    // A redraw may change overscan without moving the visible viewport.
    const extra = changingBand && m.noFrames ? (m.reads % 2 ? 2 : 1) : 0;
    const from = Math.max(0, Math.floor(m.top) - overscan - extra);
    m.rendered = names.slice(from, Math.min(names.length, Math.ceil(m.top) + visible + overscan + extra));
    if (m.noFrames && mutate === 'missing') m.rendered = m.rendered.filter(label => label !== target);
    if (m.noFrames && mutate === 'duplicate') m.rendered.splice(m.rendered.indexOf(target), 0, target);
    if (m.noFrames && mutate === 'reorder') [m.rendered[1], m.rendered[2]] = [m.rendered[2], m.rendered[1]];
    if (m.chosen.length && afterClick === 'duplicate') m.rendered.splice(m.rendered.indexOf(target), 0, target);
    if (m.noFrames && mutate === 'focus') m.focus = 'outside';
    const list = (m.chosen.length && afterClick === 'list') || (m.noFrames && mutate === 'list') ? 'list Other' : 'list Catalog';
    m.listLine = list;
    return ['Window: "Fixture catalog", App: Fixture.', '0 standard window Fixture catalog', '\t1 container Catalog pane',
      `\t\t2 ${list}`, ...m.rendered.map((label, i) => `\t\t\t${10 + i} ${m.chosen.length && afterClick === 'role'
        ? body(label).replace(/^text /, 'button ') : body(label)}`), '\t900 button Continue', '',
      m.focus === 'list' ? `The focused UI element is 2 ${list}`
        : m.focus === 'container' ? 'The focused UI element is 1 container Catalog pane' : 'The focused UI element is 900 button Continue'].join('\n');
  };
  m.click = async line => {
    const candidates = m.rendered.filter(label => body(label) === line);
    assert.equal(candidates.length, 1, 'a unique row from the freshest tree');
    const label = candidates[0];
    m.time++;
    if (m.focus === 'container') {
      m.focusClicks.push(line); m.selected = label;
      if (m.focusClicks.length === 2) m.focus = 'list';
      return;
    }
    assert.equal(label, target, 'final click must name the exact requested row');
    m.attempts++;
    const at = names.indexOf(label);
    const inView = at >= Math.floor(m.top) && at < Math.floor(m.top) + visible;
    if (permanentFrame || !inView || (delayedFrame && m.time < m.readyAt)) {
      if (!m.noFrames) m.readyAt = m.time + frameDelay;
      m.noFrames++;
      throw new Error('Computer Use server error -10005: elementHasNoFrame');
    }
    m.selected = label; m.chosen.push(label);
  };
  return m;
}

export async function replay(listPicker, options, { trace, searchOptions = {} } = {}) {
  const model = virtualList(options);
  let result, error;
  try {
    result = await listPicker({ read: model.tree, observe() {}, press: model.press, scroll: model.scroll,
      click: model.click, parse: windowFromText, sameElement, expected: fixtureWindow,
      now: () => model.time, sleep: model.sleep, trace })(...(options?.focusRecovery ? [2, model.target] : [model.target]),
      { maxReads: 60, timeoutMs: 4000, ...searchOptions });
  } catch (caught) { error = String(caught.message); }
  return { model, result, error };
}

export function replayCounts({ model: m, result, error }) {
  return { clicked: result?.clicked === true, reason: error ? 'error' : result?.reason ?? 'selected',
    reads: m.reads, keys: m.keys, ticks: m.ticks, attempts: m.attempts, noFrames: m.noFrames,
    focusClicks: m.focusClicks.length, simulatedMs: m.time };
}
